import { randomUUID } from "node:crypto";

import type { ClientEvent, ServerEvent, SupportedLanguage } from "@family-translation/shared";
import type { WebSocket } from "ws";

import { appConfig } from "./config.js";
import { DgPcmStream } from "./deepgram-stream.js";
import type { AppDb } from "./db.js";
import type { ProviderPipeline, SynthesisResult, TranscribeForTurnOutput } from "./providers.js";

type SessionParticipant = {
  clientId: string;
  socket: WebSocket;
  displayName: string;
  language: SupportedLanguage;
  hearAudio: boolean;
  contextNotes: string;
};

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
  /** Serializes phrase-final translate+TTS so order is preserved and completeTurn can await drain. */
  segmentPipeline: Promise<void>;
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

export class RoomHub {
  /** Everyone in the single family session. */
  private readonly participants = new Map<string, SessionParticipant>();
  private readonly activeTurns = new Map<string, ActiveTurn>();

  constructor(private readonly db: AppDb, private readonly providers: ProviderPipeline) {}

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
          segmentPipeline: Promise.resolve()
        });
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
              turn.dgStream = new DgPcmStream(key, turn.sourceLanguage, {
                endpointingMs:
                  appConfig.deepgramLiveEndpointingMs > 0 ? appConfig.deepgramLiveEndpointingMs : undefined,
                onTranscript: live
                  ? (sourceText: string) => {
                      this.scheduleLiveCaption({ turnId: tId, sourceText });
                    }
                  : undefined,
                onFinalSegment: (segmentText: string) => {
                  this.queueStreamSegmentCommit({ turnId: tId, segmentText });
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
      case "session.join":
        // Join is handled by ws bootstrap to create client ids.
        return;
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
      this.activeTurns.delete(turnId);
      return;
    }

    const committed = turn.committedStreamSource.trim();
    let effectiveSource = fullSourceText;
    if (committed.length > 0) {
      if (fullSourceText === committed) {
        await this.finalizeStreamedTurnDebugOnly({
          turnId,
          turn,
          fullSourceText,
          turnTranscription
        });
        return;
      }
      if (fullSourceText.startsWith(committed)) {
        let remainder = fullSourceText.slice(committed.length).trim();
        remainder = remainder.replace(/^[\s.,;!?、。，]+/u, "").trim();
        if (remainder.length === 0) {
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
    }

    const glossaryLines = this.db
      .listGlossary()
      .map((entry) => `${entry.term} -> ${entry.translation} (${entry.notes})`);
    const correctionLines = this.db
      .latestCorrections()
      .map((entry) => `${entry.wrongText} => ${entry.rightText} (${entry.context})`);
    const recentTurns = this.db.latestTurns();

    const participants = [...this.participants.values()];
    const translateContext = { glossaryLines, correctionLines, recentTurns };

    const turnRows = await Promise.all(
      participants.map(async (participant) => {
        const targetLanguage = participant.language;
        const isSpeaker = participant.clientId === turn.speakerId;
        const translation = isSpeaker
          ? {
              value: effectiveSource,
              path: "translation.self_passthrough",
              detail: "speaker_receives_source_text"
            }
          : await this.providers.translateText({
              sourceText: effectiveSource,
              sourceLanguage: turn.sourceLanguage,
              targetLanguage,
              context: translateContext
            });
        return { participant, targetLanguage, isSpeaker, translation, translatedText: translation.value };
      })
    );

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

      this.db.insertTurn({
        turnId,
        speakerId: sourceSpeaker.clientId,
        sourceLanguage: turn.sourceLanguage,
        sourceText: effectiveSource,
        targetLanguage,
        targetText: translatedText
      });

      this.send(participant.socket, {
        type: "transcript.chunk",
        turnId,
        speakerId: sourceSpeaker.clientId,
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
    this.activeTurns.delete(turnId);
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

  private queueStreamSegmentCommit(args: { turnId: string; segmentText: string }) {
    const turn = this.activeTurns.get(args.turnId);
    if (!turn || !this.shouldSttStream()) {
      return;
    }
    const segment = args.segmentText.trim();
    if (!segment) {
      return;
    }
    turn.segmentPipeline = turn.segmentPipeline
      .catch(() => undefined)
      .then(() => this.deliverCommittedPhrase({ turnId: args.turnId, segmentText: segment }));
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

    const sourceText = args.segmentText;
    const glossaryLines = this.db
      .listGlossary()
      .map((entry) => `${entry.term} -> ${entry.translation} (${entry.notes})`);
    const correctionLines = this.db
      .latestCorrections()
      .map((entry) => `${entry.wrongText} => ${entry.rightText} (${entry.context})`);
    const recentTurns = this.db.latestTurns();
    const participants = [...this.participants.values()];
    const translateContext = { glossaryLines, correctionLines, recentTurns };

    const turnRows = await Promise.all(
      participants.map(async (participant) => {
        const targetLanguage = participant.language;
        const isSpeaker = participant.clientId === turn.speakerId;
        const translation = isSpeaker
          ? {
              value: sourceText,
              path: "translation.self_passthrough",
              detail: "speaker_receives_source_text"
            }
          : await this.providers.translateText({
              sourceText,
              sourceLanguage: turn.sourceLanguage,
              targetLanguage,
              context: translateContext
            });
        return { participant, targetLanguage, isSpeaker, translation, translatedText: translation.value };
      })
    );

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

      this.db.insertTurn({
        turnId: args.turnId,
        speakerId: sourceSpeaker.clientId,
        sourceLanguage: turn.sourceLanguage,
        sourceText,
        targetLanguage,
        targetText: translatedText
      });

      this.send(participant.socket, {
        type: "transcript.chunk",
        turnId: args.turnId,
        speakerId: sourceSpeaker.clientId,
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

