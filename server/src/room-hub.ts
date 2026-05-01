import { randomUUID } from "node:crypto";

import type { ClientEvent, ServerEvent, SupportedLanguage } from "@family-translation/shared";
import type { WebSocket } from "ws";

import { appConfig } from "./config.js";
import { DgPcmStream } from "./deepgram-stream.js";
import type { AppDb } from "./db.js";
import type {
  ProviderPipeline,
  SynthesisResult,
  TranscribeForTurnOutput,
  TranslationContext,
  TranslationResult
} from "./providers.js";

type SessionParticipant = {
  clientId: string;
  socket: WebSocket;
  displayName: string;
  language: SupportedLanguage;
  hearAudio: boolean;
  contextNotes: string;
};

/** Persist both app languages so `/api/history?language=…` works if a viewer was offline during the turn. */
const VIEWER_HISTORY_LANGUAGES: SupportedLanguage[] = ["en", "ja"];

type ActiveTurn = {
  speakerId: string;
  sourceLanguage: SupportedLanguage;
  audioChunks: Buffer[];
  textChunks: string[];
  /** Set when non-hinted PCM is forwarded to Deepgram live (see {@link appConfig.sttStream}). */
  dgStream: DgPcmStream | null;
  latestLiveSource: string;
  liveSeq: number;
  liveDebounce: ReturnType<typeof setTimeout> | null;
  /** Source text already delivered via {@link DgPcmStream} `is_final` phrase commits (normalized join). */
  committedStreamSource: string;
  /** Merged `is_final` (and optional forced live) text with overlap pruned; used for sentence batching. */
  streamMergedSource: string;
  /** Index in {@link streamMergedSource} up to which we have already enqueued translation. */
  streamEmittedLen: number;
  /** True once PCM is sent to a live Deepgram stream for this turn (affects end-of-turn flush). */
  usedPhraseStreaming: boolean;
  /** Serializes phrase-final translate+TTS so order is preserved and completeTurn can await drain. */
  segmentPipeline: Promise<void>;
  forcedCommitTimer: ReturnType<typeof setInterval> | null;
  lastForcedCommitAtMs: number;
};

const decodeTextHintPayload = (payloadBase64: string, sequence: number, isLast: boolean): string => {
  // Simulator text arrives as a single terminal packet; mic PCM arrives as many non-terminal packets.
  if (sequence !== 0 || !isLast) {
    return "";
  }
  try {
    const bytes = Buffer.from(payloadBase64, "base64");
    if (bytes.length === 0 || bytes.length > 8192) {
      return "";
    }
    if (bytes.includes(0)) {
      return "";
    }
    const text = bytes.toString("utf8").trim();
    if (!text || text.includes("\uFFFD")) {
      return "";
    }
    for (const char of text) {
      const code = char.charCodeAt(0);
      const isControl = code < 32 && char !== "\n" && char !== "\r" && char !== "\t";
      if (isControl) {
        return "";
      }
    }
    return text;
  } catch {
    return "";
  }
};

const decodeAudioBytes = (payloadBase64: string): Buffer | null => {
  try {
    return Buffer.from(payloadBase64, "base64");
  } catch {
    return null;
  }
};

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[.,!?;:()[\]{}"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Whitespace / Unicode form for “already emitted this text?” checks (no lowercasing — keeps JA + names stable). */
const turnCanonWords = (s: string): string[] =>
  s
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

const dedupeLeadingOverlap = (alreadyCommitted: string, incoming: string): string => {
  const committedWords = normalize(alreadyCommitted).split(" ").filter(Boolean);
  const incomingWordsRaw = incoming.trim().split(/\s+/).filter(Boolean);
  const incomingWordsNorm = normalize(incoming).split(" ").filter(Boolean);
  if (committedWords.length === 0 || incomingWordsNorm.length === 0) {
    return incoming.trim();
  }
  const maxOverlap = Math.min(96, committedWords.length, incomingWordsNorm.length);
  let overlap = 0;
  for (let n = maxOverlap; n >= 1; n -= 1) {
    const c = committedWords.slice(-n).join(" ");
    const i = incomingWordsNorm.slice(0, n).join(" ");
    if (c === i) {
      overlap = n;
      break;
    }
  }
  if (overlap === 0) {
    return incoming.trim();
  }
  const sliced = incomingWordsRaw.slice(overlap).join(" ").trim();
  return sliced;
};

/** Append a new STT segment onto the rolling merged transcript, stripping prefix overlap (re-finalization / rewrite). */
const appendStreamSegment = (current: string, incoming: string): string => {
  const delta = dedupeLeadingOverlap(current, incoming).trim();
  if (!delta) {
    return current;
  }
  if (!current) {
    return delta;
  }
  return `${current} ${delta}`.trim();
};

const SENTENCE_END_CHARS = /[.!?。]/;

/**
 * From `full[start]`, take one or more **complete** sentences (ended by . ? ! or 。), or return empty if the tail
 * has no sentence end yet. Handles overlap boundaries only inside `full` (caller merges segments).
 */
const takeAllCompleteSentencesFrom = (full: string, start: number): { chunk: string; nextStart: number } => {
  let pos = start;
  while (pos < full.length && /\s/.test(full[pos])) {
    pos += 1;
  }
  let lastCompleteExclusive = -1;
  while (pos < full.length) {
    const rel = full.slice(pos).search(SENTENCE_END_CHARS);
    if (rel < 0) {
      break;
    }
    const p = pos + rel;
    const punct = full[p];
    const prev = full[p - 1];
    const next = full[p + 1];
    if (punct === "." && prev !== undefined && /\d/.test(prev) && next !== undefined && /\d/.test(next)) {
      pos = p + 1;
      continue;
    }
    const isBoundary =
      next === undefined ||
      /\s/.test(next) ||
      next === '"' ||
      next === "'" ||
      next === "」" ||
      next === "）" ||
      next === "]";
    if (!isBoundary) {
      pos = p + 1;
      continue;
    }
    lastCompleteExclusive = p + 1;
    pos = p + 1;
    while (pos < full.length && /\s/.test(full[pos])) {
      pos += 1;
    }
  }
  if (lastCompleteExclusive < start) {
    return { chunk: "", nextStart: start };
  }
  return {
    chunk: full.slice(start, lastCompleteExclusive).trim(),
    nextStart: pos
  };
};

export class RoomHub {
  /** Everyone in the single family session. */
  private readonly participants = new Map<string, SessionParticipant>();
  private readonly activeTurns = new Map<string, ActiveTurn>();

  constructor(private readonly db: AppDb, private readonly providers: ProviderPipeline) {}

  /**
   * Portion of `full` that is not already covered by streamed `committed` phrases (word-prefix match,
   * string-prefix, or normalized overlap tail). Matches end-of-turn reconciliation in {@link completeTurn}.
   */
  private resolveRemainderAfterCommitted(committedRaw: string, fullRaw: string): string {
    const committed = committedRaw.trim();
    const full = fullRaw.trim();
    if (!full) {
      return "";
    }
    if (!committed) {
      return full;
    }

    const cw = turnCanonWords(committed);
    const fw = turnCanonWords(full);
    const cCommit = cw.join(" ");
    const cFull = fw.join(" ");

    if (cFull === cCommit) {
      return "";
    }

    const wordMatch = (a: string, b: string) => normalize(a) === normalize(b);
    if (cw.length > 0 && fw.length >= cw.length && cw.every((w, i) => wordMatch(fw[i] ?? "", w))) {
      return fw.slice(cw.length).join(" ").trim();
    }
    if (full.startsWith(committed)) {
      let remainder = full.slice(committed.length).trim();
      remainder = remainder.replace(/^[\s.,;!?、。，]+/u, "").trim();
      return remainder;
    }
    const remainder = dedupeLeadingOverlap(committed, full);
    if (remainder.length > 0 && remainder !== full) {
      return remainder;
    }
    return full;
  }

  join(socket: WebSocket, event: Extract<ClientEvent, { type: "session.join" }>) {
    const clientId = randomUUID();
    this.participants.set(clientId, {
      clientId,
      socket,
      displayName: event.displayName,
      language: event.language,
      hearAudio: event.hearAudio,
      contextNotes: event.contextNotes
    });

    this.send(socket, { type: "session.joined", clientId });
    this.send(socket, {
      type: "providers.updated",
      ...this.providers.getProviders()
    });
    return clientId;
  }

  leave(clientId: string) {
    for (const [turnId, turn] of [...this.activeTurns.entries()]) {
      if (turn.speakerId === clientId) {
        this.clearLiveCaptionSchedule(turn);
        this.clearForcedCommitSchedule(turn);
        if (turn.dgStream) {
          void turn.dgStream.close().catch(() => undefined);
        }
        this.activeTurns.delete(turnId);
      }
    }

    this.participants.delete(clientId);
  }

  async handleEvent(clientId: string, event: ClientEvent) {
    switch (event.type) {
      case "turn.start":
        this.activeTurns.set(event.turnId, {
          speakerId: clientId,
          sourceLanguage: event.speakerLanguage,
          audioChunks: [],
          textChunks: [],
          dgStream: null,
          latestLiveSource: "",
          liveSeq: 0,
          liveDebounce: null,
          committedStreamSource: "",
          streamMergedSource: "",
          streamEmittedLen: 0,
          usedPhraseStreaming: false,
          segmentPipeline: Promise.resolve(),
          forcedCommitTimer: null,
          lastForcedCommitAtMs: Date.now()
        });
        const started = this.activeTurns.get(event.turnId);
        if (started) {
          this.scheduleForcedCommit(event.turnId, started);
        }
        return;
      case "audio.input": {
        const turn = this.activeTurns.get(event.turnId);
        if (!turn || turn.speakerId !== clientId) {
          return;
        }
        const chunkBytes = decodeAudioBytes(event.payloadBase64);
        if (chunkBytes) {
          turn.audioChunks.push(chunkBytes);
        }
        const textChunk = decodeTextHintPayload(event.payloadBase64, event.sequence, event.isLast);
        if (textChunk.length > 0) {
          turn.textChunks.push(textChunk);
        } else if (chunkBytes && this.shouldSttStream()) {
          const key = appConfig.apiKeys.deepgram;
          if (key && this.providers.getProviders().stt === "deepgram") {
            if (!turn.dgStream) {
              const tId = event.turnId;
              const live = this.shouldLiveCaptions();
              turn.usedPhraseStreaming = true;
              turn.dgStream = new DgPcmStream(key, turn.sourceLanguage, {
                endpointingMs:
                  appConfig.deepgramLiveEndpointingMs > 0 ? appConfig.deepgramLiveEndpointingMs : undefined,
                onTranscript: live
                  ? (sourceText: string) => {
                      this.scheduleLiveCaption({ turnId: tId, sourceText });
                    }
                  : undefined,
                onFinalSegment: (segmentText: string) => {
                  this.ingestPhraseFinalSegment({ turnId: tId, segmentText });
                }
              });
            }
            turn.dgStream.addChunk(chunkBytes);
          }
        }
        return;
      }
      case "turn.stop":
        await this.completeTurn(event.turnId);
        return;
      case "correction.submit":
        this.db.insertCorrection({
          userId: clientId,
          wrongText: event.wrongText,
          rightText: event.rightText,
          context: event.context ?? ""
        });
        return;
      case "settings.providers": {
        const selected = this.providers.setProviders({
          stt: event.stt === "openai" ? "openai" : "deepgram",
          translation: event.translation === "openai" ? "openai" : "gemini",
          tts: event.tts === "openai" ? "openai" : "cartesia"
        });
        this.broadcastToAll({ type: "providers.updated", ...selected });
        return;
      }
      case "turn.edit":
        await this.handleTurnEdit(clientId, event.turnId, event.sourceText);
        return;
      case "turn.edit_translation":
        await this.handleTranslatedEdit(clientId, event.turnId, event.translatedText);
        return;
      case "session.join":
        // Join is handled by ws bootstrap to create client ids.
        return;
    }
  }

  private async handleTurnEdit(editorClientId: string, turnId: string, sourceTextRaw: string) {
    const sourceText = sourceTextRaw.trim();
    if (!sourceText) {
      return;
    }
    const seed = this.db.getTurnForEdit(turnId);
    if (!seed || seed.speakerId !== editorClientId) {
      return;
    }

    const glossaryLines = this.db
      .listGlossary()
      .map((entry) => `${entry.term} -> ${entry.translation} (${entry.notes})`);
    const correctionLines = this.db
      .latestCorrections()
      .map((entry) => `${entry.wrongText} => ${entry.rightText} (${entry.context})`);
    const recentTurns = this.db.latestTurns();
    const translateContext = { glossaryLines, correctionLines, recentTurns };

    const translatedByLang = new Map<SupportedLanguage, string>();
    for (const lang of seed.targetLanguages) {
      if (lang === seed.sourceLanguage) {
        translatedByLang.set(lang, sourceText);
      } else {
        const result = await this.providers.translateText({
          sourceText,
          sourceLanguage: seed.sourceLanguage,
          targetLanguage: lang,
          context: translateContext
        });
        translatedByLang.set(lang, result.value);
      }
    }

    const editedAtSec = Math.floor(Date.now() / 1000);
    for (const lang of seed.targetLanguages) {
      const translated = translatedByLang.get(lang) ?? sourceText;
      this.db.updateTurnEditedTranslation({
        turnId,
        targetLanguage: lang,
        sourceText,
        targetText: translated,
        editedAtSec
      });
    }

    for (const participant of this.participants.values()) {
      const translatedText = translatedByLang.get(participant.language) ?? sourceText;
      this.send(participant.socket, {
        type: "transcript.edited",
        turnId,
        speakerId: seed.speakerId,
        speakerDisplayName: seed.speakerName,
        sourceLanguage: seed.sourceLanguage,
        targetLanguage: participant.language,
        originalText: sourceText,
        translatedText,
        timestamp: Date.now(),
        editedAt: editedAtSec * 1000
      });
    }
  }

  private async handleTranslatedEdit(editorClientId: string, turnId: string, translatedTextRaw: string) {
    const translatedText = translatedTextRaw.trim();
    if (!translatedText) {
      return;
    }
    const editor = this.participants.get(editorClientId);
    if (!editor || editor.hearAudio) {
      // Translation edits are reserved for bilingual users (hearAudio=false from onboarding choice).
      return;
    }
    const row = this.db.getTurnRow(turnId, editor.language);
    if (!row) {
      return;
    }

    const editedAtSec = Math.floor(Date.now() / 1000);
    this.db.updateTurnEditedTranslation({
      turnId,
      targetLanguage: editor.language,
      sourceText: row.sourceText,
      targetText: translatedText,
      editedAtSec
    });
    this.db.insertCorrection({
      userId: editorClientId,
      wrongText: row.targetText,
      rightText: translatedText,
      context: `manual translation edit turn=${turnId} lang=${editor.language}`
    });

    const seed = this.db.getTurnForEdit(turnId);
    if (!seed) {
      return;
    }
    for (const participant of this.participants.values()) {
      const targetRow = this.db.getTurnRow(turnId, participant.language);
      if (!targetRow) {
        continue;
      }
      // Mark as edited for all viewers (even if only one language text changed).
      this.db.updateTurnEditedTranslation({
        turnId,
        targetLanguage: participant.language,
        sourceText: targetRow.sourceText,
        targetText: targetRow.targetText,
        editedAtSec
      });
      this.send(participant.socket, {
        type: "transcript.edited",
        turnId,
        speakerId: seed.speakerId,
        speakerDisplayName: seed.speakerName,
        sourceLanguage: targetRow.sourceLanguage,
        targetLanguage: participant.language,
        originalText: targetRow.sourceText,
        translatedText: participant.language === editor.language ? translatedText : targetRow.targetText,
        timestamp: Date.now(),
        editedAt: editedAtSec * 1000
      });
    }
  }

  private async completeTurn(turnId: string) {
    const turn = this.activeTurns.get(turnId);
    if (!turn) {
      return;
    }
    this.clearLiveCaptionSchedule(turn);
    if (appConfig.liveCaptions && this.shouldSttStream() && turn.latestLiveSource.trim().length > 0) {
      await this.flushLiveCaptions(turnId);
    }
    if (appConfig.utteranceCommitDelayMs > 0) {
      await sleepMs(appConfig.utteranceCommitDelayMs);
    }
    const sourceSpeaker = this.participants.get(turn.speakerId);
    if (!sourceSpeaker) {
      this.clearForcedCommitSchedule(turn);
      this.activeTurns.delete(turnId);
      return;
    }

    await turn.segmentPipeline.catch(() => undefined);
    if (turn.committedStreamSource.trim().length > 0 && appConfig.streamSegmentSettleMs > 0) {
      await sleepMs(appConfig.streamSegmentSettleMs);
    }

    const turnTranscription = await this.resolveTranscription(turn);
    const transcription = turnTranscription.result;
    const fullSourceText = transcription.value.trim();
    if (fullSourceText.length === 0) {
      this.clearForcedCommitSchedule(turn);
      this.activeTurns.delete(turnId);
      return;
    }

    if (turn.usedPhraseStreaming) {
      turn.streamMergedSource = fullSourceText;
      const tail = this.resolveRemainderAfterCommitted(turn.committedStreamSource, fullSourceText).trim();
      if (tail.length > 0) {
        await turn.segmentPipeline.catch(() => undefined);
        await this.deliverCommittedPhrase({ turnId, segmentText: tail });
        await turn.segmentPipeline.catch(() => undefined);
      }
      turn.streamEmittedLen = turn.streamMergedSource.length;
    }

    const committed = turn.committedStreamSource.trim();
    let effectiveSource = fullSourceText.trim();
    if (committed.length > 0) {
      const remainder = this.resolveRemainderAfterCommitted(committed, fullSourceText).trim();
      if (!remainder) {
        await this.finalizeStreamedTurnDebugOnly({
          turnId,
          turn,
          fullSourceText,
          turnTranscription
        });
        return;
      }
      effectiveSource = remainder;
    }

    const glossaryLines = this.db
      .listGlossary()
      .map((entry) => `${entry.term} -> ${entry.translation} (${entry.notes})`);
    const correctionLines = this.db
      .latestCorrections()
      .map((entry) => `${entry.wrongText} => ${entry.rightText} (${entry.context})`);
    const recentTurns = this.db.latestTurns();

    const participants = [...this.participants.values()];
    const translateContext: TranslationContext = { glossaryLines, correctionLines, recentTurns };

    const byLang = await this.persistViewerLanguageHistoryAndGetByLang({
      turnId,
      speaker: sourceSpeaker,
      sourceLanguage: turn.sourceLanguage,
      sourceText: effectiveSource,
      translateContext
    });

    const turnRows = participants.map((participant) => {
      const targetLanguage = participant.language;
      const isSpeaker = participant.clientId === turn.speakerId;
      const translation: TranslationResult = isSpeaker
        ? {
            value: effectiveSource,
            path: "translation.self_passthrough",
            detail: "speaker_receives_source_text"
          }
        : byLang.get(targetLanguage)!;
      const translatedText = translation.value;
      return { participant, targetLanguage, isSpeaker, translation, translatedText };
    });

    const ttsKey = (lang: SupportedLanguage, text: string) => `${lang}::${text}`;
    const ttsCache = new Map<string, SynthesisResult>();
    const ttsInFlight = new Map<string, Promise<SynthesisResult>>();

    const getOrSynthesize = async (text: string, ttsLanguage: SupportedLanguage) => {
      const key = ttsKey(ttsLanguage, text);
      const cached = ttsCache.get(key);
      if (cached) {
        return cached;
      }
      const pending = ttsInFlight.get(key);
      if (pending) {
        return pending;
      }
      const p = this.providers
        .synthesizeSpeech({ text, targetLanguage: ttsLanguage, speakerId: sourceSpeaker.clientId })
        .then((speech) => {
          ttsInFlight.delete(key);
          ttsCache.set(key, speech);
          return speech;
        });
      ttsInFlight.set(key, p);
      return p;
    };

    const sendPcm = (recipient: SessionParticipant, ttsLanguage: SupportedLanguage, speech: SynthesisResult) => {
      this.send(recipient.socket, {
        type: "audio.chunk",
        turnId,
        targetLanguage: ttsLanguage,
        mimeType: speech.mimeType,
        payloadBase64: speech.value,
        sequence: 0,
        isLast: true
      });
    };

    const participantDebugRows = turnRows.map((row) => {
      const { participant, targetLanguage, isSpeaker, translation, translatedText } = row;
      const listenerGetsTts = !isSpeaker && participant.hearAudio;
      const shouldSynthesizeTts = listenerGetsTts;

      this.send(participant.socket, {
        type: "transcript.chunk",
        turnId,
        speakerId: sourceSpeaker.clientId,
        speakerDisplayName: sourceSpeaker.displayName,
        sourceLanguage: turn.sourceLanguage,
        targetLanguage,
        translatedText,
        originalText: effectiveSource,
        isFinal: true,
        timestamp: Date.now(),
        debug: {
          transcriptionPath: transcription.path,
          transcriptionDetail: transcription.detail,
          translationPath: translation.path,
          translationDetail: translation.detail,
          ttsPath: shouldSynthesizeTts ? "tts.deferred" : undefined
        }
      });

      if (listenerGetsTts) {
        void (async () => {
          const speech = await getOrSynthesize(translatedText, targetLanguage);
          sendPcm(participant, targetLanguage, speech);
        })();
      }

      return {
        clientId: participant.clientId,
        displayName: participant.displayName,
        targetLanguage,
        isSpeaker,
        hearAudio: participant.hearAudio,
        translatedText,
        translationPath: translation.path,
        translationDetail: translation.detail,
        ttsPath: shouldSynthesizeTts ? "tts.deferred" : undefined
      };
    });

    this.broadcastToAll({
      type: "debug.turn",
      turnId,
      speakerId: sourceSpeaker.clientId,
      sourceLanguage: turn.sourceLanguage,
      originalText: fullSourceText,
      timestamp: Date.now(),
      transcription: {
        path: transcription.path,
        detail: transcription.detail,
        audioChunkCount: turn.audioChunks.length,
        textHintCount: turn.textChunks.length,
        sttBenchmark: turnTranscription.sttBenchmark
      },
      participants: participantDebugRows
    });
    this.clearForcedCommitSchedule(turn);
    this.activeTurns.delete(turnId);
  }

  /**
   * Writes one `turns` row per supported viewer language, then returns those translations for reuse when
   * emitting `transcript.chunk` to currently connected sockets.
   */
  private async persistViewerLanguageHistoryAndGetByLang(args: {
    turnId: string;
    speaker: SessionParticipant;
    sourceLanguage: SupportedLanguage;
    sourceText: string;
    translateContext: TranslationContext;
  }): Promise<Map<SupportedLanguage, TranslationResult>> {
    const byLang = new Map<SupportedLanguage, TranslationResult>();
    for (const targetLanguage of VIEWER_HISTORY_LANGUAGES) {
      const translation: TranslationResult =
        targetLanguage === args.sourceLanguage
          ? {
              value: args.sourceText,
              path: "translation.self_passthrough",
              detail: "speaker_receives_source_text"
            }
          : await this.providers.translateText({
              sourceText: args.sourceText,
              sourceLanguage: args.sourceLanguage,
              targetLanguage,
              context: args.translateContext
            });
      this.db.insertTurn({
        turnId: args.turnId,
        speakerId: args.speaker.clientId,
        speakerName: args.speaker.displayName,
        sourceLanguage: args.sourceLanguage,
        sourceText: args.sourceText,
        targetLanguage,
        targetText: translation.value
      });
      byLang.set(targetLanguage, translation);
    }
    return byLang;
  }

  private shouldSttStream(): boolean {
    return appConfig.sttStream && !appConfig.sttBenchmark;
  }

  private shouldLiveCaptions(): boolean {
    return this.shouldSttStream() && appConfig.liveCaptions;
  }

  private clearLiveCaptionSchedule(turn: ActiveTurn) {
    if (turn.liveDebounce) {
      clearTimeout(turn.liveDebounce);
      turn.liveDebounce = null;
    }
  }

  private clearForcedCommitSchedule(turn: ActiveTurn) {
    if (turn.forcedCommitTimer) {
      clearInterval(turn.forcedCommitTimer);
      turn.forcedCommitTimer = null;
    }
  }

  private scheduleForcedCommit(turnId: string, turn: ActiveTurn) {
    if (!this.shouldSttStream() || appConfig.forcedStreamCommitMs <= 0) {
      return;
    }
    this.clearForcedCommitSchedule(turn);
    turn.forcedCommitTimer = setInterval(() => {
      const current = this.activeTurns.get(turnId);
      if (!current) {
        return;
      }
      const now = Date.now();
      if (now - current.lastForcedCommitAtMs < appConfig.forcedStreamCommitMs) {
        return;
      }
      const rolling = current.latestLiveSource.trim();
      if (!rolling) {
        return;
      }
      const delta = dedupeLeadingOverlap(current.streamMergedSource, rolling).trim();
      if (delta.length < appConfig.forcedStreamCommitMinChars) {
        return;
      }
      current.lastForcedCommitAtMs = now;
      current.streamMergedSource = current.streamMergedSource
        ? `${current.streamMergedSource} ${delta}`.trim()
        : delta;
      current.segmentPipeline = current.segmentPipeline
        .catch(() => undefined)
        .then(() => this.flushPendingTranslationChunks(turnId));
    }, 1000);
  }

  private scheduleLiveCaption(args: { turnId: string; sourceText: string }) {
    const turn = this.activeTurns.get(args.turnId);
    if (!turn) {
      return;
    }
    turn.latestLiveSource = args.sourceText;
    if (turn.liveDebounce) {
      clearTimeout(turn.liveDebounce);
    }
    const waitMs = 400;
    turn.liveDebounce = setTimeout(() => {
      turn.liveDebounce = null;
      void this.flushLiveCaptions(args.turnId);
    }, waitMs);
  }

  private async flushLiveCaptions(turnId: string) {
    const turn = this.activeTurns.get(turnId);
    if (!turn) {
      return;
    }
    const sourceText = turn.latestLiveSource.trim();
    if (sourceText.length === 0) {
      return;
    }
    const sourceSnapshot = sourceText;
    // One sequence number per debounced flush (not per STT frame).
    turn.liveSeq += 1;
    const seqAtStart = turn.liveSeq;
    const sourceSpeaker = this.participants.get(turn.speakerId);
    if (!sourceSpeaker) {
      return;
    }

    const sendLive = (participant: SessionParticipant, translatedText: string) => {
      this.send(participant.socket, {
        type: "transcript.live",
        turnId,
        speakerId: turn.speakerId,
        speakerDisplayName: sourceSpeaker.displayName,
        sourceLanguage: turn.sourceLanguage,
        targetLanguage: participant.language,
        originalText: sourceSnapshot,
        translatedText,
        liveSeq: seqAtStart,
        timestamp: Date.now()
      });
    };

    if (!this.activeTurns.get(turnId)) {
      return;
    }
    if (turn.latestLiveSource.trim() !== sourceSnapshot) {
      return;
    }
    // Speaker self-monitor only: interim source text. Listeners receive phrase-final transcript.chunk + TTS while the turn is open when STT_STREAM is on.
    sendLive(sourceSpeaker, sourceSnapshot);
  }

  private ingestPhraseFinalSegment(args: { turnId: string; segmentText: string }) {
    const turn = this.activeTurns.get(args.turnId);
    if (!turn || !this.shouldSttStream()) {
      return;
    }
    const seg = args.segmentText.trim();
    if (!seg) {
      return;
    }
    turn.streamMergedSource = appendStreamSegment(turn.streamMergedSource, seg);
    turn.segmentPipeline = turn.segmentPipeline
      .catch(() => undefined)
      .then(() => this.flushPendingTranslationChunks(args.turnId));
  }

  /**
   * After each merged `is_final` (or forced rolling delta), emit translation for “short” turns immediately,
   * or for “long” turns only when a sentence-ending marker appears; remainder waits for more finals or
   * turn stop (see `completeTurn` tail flush).
   */
  private async flushPendingTranslationChunks(turnId: string) {
    const turn = this.activeTurns.get(turnId);
    if (!turn) {
      return;
    }
    const full = turn.streamMergedSource;
    if (!full.trim()) {
      return;
    }
    const shortMode = full.length <= appConfig.shortUtteranceMaxChars;

    if (shortMode) {
      const tail = full.slice(turn.streamEmittedLen);
      if (!tail.trim()) {
        return;
      }
      await this.deliverCommittedPhrase({ turnId, segmentText: tail.trim() });
      const t1 = this.activeTurns.get(turnId);
      if (t1) {
        t1.streamEmittedLen = full.length;
      }
      return;
    }

    const { chunk, nextStart } = takeAllCompleteSentencesFrom(full, turn.streamEmittedLen);
    if (!chunk) {
      return;
    }
    await this.deliverCommittedPhrase({ turnId, segmentText: chunk });
    const t2 = this.activeTurns.get(turnId);
    if (t2) {
      t2.streamEmittedLen = nextStart;
    }
  }

  private async deliverCommittedPhrase(args: { turnId: string; segmentText: string }) {
    const turn = this.activeTurns.get(args.turnId);
    if (!turn) {
      return;
    }
    const sourceSpeaker = this.participants.get(turn.speakerId);
    if (!sourceSpeaker) {
      return;
    }

    const sourceText = dedupeLeadingOverlap(turn.committedStreamSource, args.segmentText);
    if (!sourceText.trim()) {
      return;
    }
    const committedBefore = turn.committedStreamSource.trim();
    const combinedCanonKey = turnCanonWords(
      committedBefore ? `${committedBefore} ${sourceText}`.trim() : sourceText
    ).join(" ");
    if (committedBefore.length > 0 && combinedCanonKey === turnCanonWords(committedBefore).join(" ")) {
      return;
    }
    const glossaryLines = this.db
      .listGlossary()
      .map((entry) => `${entry.term} -> ${entry.translation} (${entry.notes})`);
    const correctionLines = this.db
      .latestCorrections()
      .map((entry) => `${entry.wrongText} => ${entry.rightText} (${entry.context})`);
    const recentTurns = this.db.latestTurns();
    const participants = [...this.participants.values()];
    const translateContext: TranslationContext = { glossaryLines, correctionLines, recentTurns };

    const byLang = await this.persistViewerLanguageHistoryAndGetByLang({
      turnId: args.turnId,
      speaker: sourceSpeaker,
      sourceLanguage: turn.sourceLanguage,
      sourceText,
      translateContext
    });

    const turnRows = participants.map((participant) => {
      const targetLanguage = participant.language;
      const isSpeaker = participant.clientId === turn.speakerId;
      const translation: TranslationResult = isSpeaker
        ? {
            value: sourceText,
            path: "translation.self_passthrough",
            detail: "speaker_receives_source_text"
          }
        : byLang.get(targetLanguage)!;
      const translatedText = translation.value;
      return { participant, targetLanguage, isSpeaker, translation, translatedText };
    });

    const ttsKey = (lang: SupportedLanguage, text: string) => `${lang}::${text}`;
    const ttsCache = new Map<string, SynthesisResult>();
    const ttsInFlight = new Map<string, Promise<SynthesisResult>>();

    const getOrSynthesize = async (text: string, ttsLanguage: SupportedLanguage) => {
      const key = ttsKey(ttsLanguage, text);
      const cached = ttsCache.get(key);
      if (cached) {
        return cached;
      }
      const pending = ttsInFlight.get(key);
      if (pending) {
        return pending;
      }
      const p = this.providers
        .synthesizeSpeech({ text, targetLanguage: ttsLanguage, speakerId: sourceSpeaker.clientId })
        .then((speech) => {
          ttsInFlight.delete(key);
          ttsCache.set(key, speech);
          return speech;
        });
      ttsInFlight.set(key, p);
      return p;
    };

    const sendPcm = (recipient: SessionParticipant, ttsLanguage: SupportedLanguage, speech: SynthesisResult) => {
      this.send(recipient.socket, {
        type: "audio.chunk",
        turnId: args.turnId,
        targetLanguage: ttsLanguage,
        mimeType: speech.mimeType,
        payloadBase64: speech.value,
        sequence: 0,
        isLast: true
      });
    };

    for (const row of turnRows) {
      const { participant, targetLanguage, translation, translatedText } = row;
      const listenerGetsTts = participant.clientId !== turn.speakerId && participant.hearAudio;

      this.send(participant.socket, {
        type: "transcript.chunk",
        turnId: args.turnId,
        speakerId: sourceSpeaker.clientId,
        speakerDisplayName: sourceSpeaker.displayName,
        sourceLanguage: turn.sourceLanguage,
        targetLanguage,
        translatedText,
        originalText: sourceText,
        isFinal: true,
        timestamp: Date.now(),
        debug: {
          transcriptionPath: "stt.deepgram_stream",
          transcriptionDetail: "phrase_final",
          translationPath: translation.path,
          translationDetail: translation.detail,
          ttsPath: listenerGetsTts ? "tts.deferred" : undefined
        }
      });

      if (listenerGetsTts) {
        void (async () => {
          const speech = await getOrSynthesize(translatedText, targetLanguage);
          sendPcm(participant, targetLanguage, speech);
        })();
      }
    }

    const tail = this.activeTurns.get(args.turnId);
    if (tail) {
      const acc = tail.committedStreamSource.trim();
      const piece = sourceText.trim();
      tail.committedStreamSource = acc ? `${acc} ${piece}` : piece;
      tail.lastForcedCommitAtMs = Date.now();
    }
  }

  private async finalizeStreamedTurnDebugOnly(args: {
    turnId: string;
    turn: ActiveTurn;
    fullSourceText: string;
    turnTranscription: TranscribeForTurnOutput;
  }) {
    const sourceSpeaker = this.participants.get(args.turn.speakerId);
    if (!sourceSpeaker) {
      this.activeTurns.delete(args.turnId);
      return;
    }
    const transcription = args.turnTranscription.result;
    const participants = [...this.participants.values()];
    const participantDebugRows = participants.map((participant) => ({
      clientId: participant.clientId,
      displayName: participant.displayName,
      targetLanguage: participant.language,
      isSpeaker: participant.clientId === args.turn.speakerId,
      hearAudio: participant.hearAudio,
      translatedText:
        participant.clientId === args.turn.speakerId
          ? args.fullSourceText
          : "(earlier phrases committed during stream)",
      translationPath: "turn.segment_commits_only",
      translationDetail: undefined,
      ttsPath: undefined
    }));

    this.broadcastToAll({
      type: "debug.turn",
      turnId: args.turnId,
      speakerId: sourceSpeaker.clientId,
      sourceLanguage: args.turn.sourceLanguage,
      originalText: args.fullSourceText,
      timestamp: Date.now(),
      transcription: {
        path: transcription.path,
        detail: transcription.detail,
        audioChunkCount: args.turn.audioChunks.length,
        textHintCount: args.turn.textChunks.length,
        sttBenchmark: args.turnTranscription.sttBenchmark
      },
      participants: participantDebugRows
    });
    this.clearForcedCommitSchedule(args.turn);
    this.activeTurns.delete(args.turnId);
  }

  private async resolveTranscription(turn: ActiveTurn): Promise<TranscribeForTurnOutput> {
    const hinted = turn.textChunks.join(" ").trim().length > 0;
    if (hinted) {
      return this.providers.transcribeForTurn({
        sourceLanguage: turn.sourceLanguage,
        chunks: turn.audioChunks,
        textHints: turn.textChunks
      });
    }
    if (turn.dgStream) {
      let streamValue = "";
      try {
        streamValue = (await turn.dgStream.close()).trim();
      } catch {
        // fall through to batch
      }
      if (streamValue.length > 0) {
        return { result: { value: streamValue, path: "stt.deepgram_stream", detail: "live_websocket" } };
      }
    }
    return this.providers.transcribeForTurn({
      sourceLanguage: turn.sourceLanguage,
      chunks: turn.audioChunks,
      textHints: turn.textChunks
    });
  }

  private send(socket: WebSocket, event: ServerEvent) {
    if (socket.readyState !== 1) {
      return;
    }
    socket.send(JSON.stringify(event));
  }

  private broadcastToAll(event: ServerEvent) {
    for (const participant of this.participants.values()) {
      this.send(participant.socket, event);
    }
  }
}

