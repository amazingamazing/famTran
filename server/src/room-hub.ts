import { randomUUID } from "node:crypto";

import type { ClientEvent, ServerEvent, SupportedLanguage } from "@family-translation/shared";
import type { WebSocket } from "ws";

import { appConfig } from "./config.js";
import { DgPcmStream } from "./deepgram-stream.js";
import type { AppDb } from "./db.js";
import type { ProviderPipeline, SynthesisResult, TranscribeForTurnOutput } from "./providers.js";

type RoomParticipant = {
  clientId: string;
  socket: WebSocket;
  displayName: string;
  language: SupportedLanguage;
  hearAudio: boolean;
  contextNotes: string;
};

type RoomState = {
  roomId: string;
  participants: Map<string, RoomParticipant>;
};

type ActiveTurn = {
  roomId: string;
  speakerId: string;
  sourceLanguage: SupportedLanguage;
  audioChunks: Buffer[];
  textChunks: string[];
  /** Set when non-hinted PCM is forwarded to Deepgram live (see {@link appConfig.sttStream}). */
  dgStream: DgPcmStream | null;
  latestLiveSource: string;
  liveSeq: number;
  liveDebounce: ReturnType<typeof setTimeout> | null;
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
  private readonly rooms = new Map<string, RoomState>();
  private readonly clientToRoom = new Map<string, string>();
  private readonly activeTurns = new Map<string, ActiveTurn>();

  constructor(private readonly db: AppDb, private readonly providers: ProviderPipeline) {}

  join(socket: WebSocket, event: Extract<ClientEvent, { type: "session.join" }>) {
    const clientId = randomUUID();
    const room = this.ensureRoom(event.roomId);
    room.participants.set(clientId, {
      clientId,
      socket,
      displayName: event.displayName,
      language: event.language,
      hearAudio: event.hearAudio,
      contextNotes: event.contextNotes
    });
    this.clientToRoom.set(clientId, room.roomId);

    this.send(socket, { type: "session.joined", roomId: room.roomId, clientId });
    this.send(socket, {
      type: "providers.updated",
      ...this.providers.getProviders()
    });
    return clientId;
  }

  leave(clientId: string) {
    const roomId = this.clientToRoom.get(clientId);
    if (!roomId) {
      return;
    }
    const room = this.rooms.get(roomId);
    if (room) {
      room.participants.delete(clientId);
      if (room.participants.size === 0) {
        this.rooms.delete(roomId);
      }
    }
    this.clientToRoom.delete(clientId);
  }

  async handleEvent(clientId: string, event: ClientEvent) {
    switch (event.type) {
      case "turn.start":
        this.activeTurns.set(event.turnId, {
          roomId: event.roomId,
          speakerId: clientId,
          sourceLanguage: event.speakerLanguage,
          audioChunks: [],
          textChunks: [],
          dgStream: null,
          latestLiveSource: "",
          liveSeq: 0,
          liveDebounce: null
        });
        return;
      case "audio.input": {
        const turn = this.activeTurns.get(event.turnId);
        if (!turn) {
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
              const rId = event.roomId;
              const live = this.shouldLiveCaptions();
              turn.dgStream = new DgPcmStream(key, turn.sourceLanguage, {
                onTranscript: live
                  ? (sourceText: string) => {
                      this.scheduleLiveCaption({ turnId: tId, roomId: rId, sourceText });
                    }
                  : undefined
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
          roomId: event.roomId,
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
      await this.flushLiveCaptions(turnId, turn.roomId);
    }
    if (appConfig.utteranceCommitDelayMs > 0) {
      await sleepMs(appConfig.utteranceCommitDelayMs);
    }
    const room = this.rooms.get(turn.roomId);
    if (!room) {
      this.activeTurns.delete(turnId);
      return;
    }
    const turnTranscription = await this.resolveTranscription(turn);
    const transcription = turnTranscription.result;
    const sourceText = transcription.value.trim();
    const sourceSpeaker = room.participants.get(turn.speakerId);
    if (!sourceSpeaker || sourceText.length === 0) {
      this.activeTurns.delete(turnId);
      return;
    }

    const glossaryLines = this.db
      .listGlossary(turn.roomId)
      .map((entry) => `${entry.term} -> ${entry.translation} (${entry.notes})`);
    const correctionLines = this.db
      .latestCorrections(turn.roomId)
      .map((entry) => `${entry.wrongText} => ${entry.rightText} (${entry.context})`);
    const recentTurns = this.db.latestTurns(turn.roomId);

    const participants = [...room.participants.values()];
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

    const sendPcm = (recipient: RoomParticipant, ttsLanguage: SupportedLanguage, speech: SynthesisResult) => {
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
        roomId: turn.roomId,
        turnId,
        speakerId: sourceSpeaker.clientId,
        sourceLanguage: turn.sourceLanguage,
        sourceText,
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
        originalText: sourceText,
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
      roomId: turn.roomId,
      speakerId: sourceSpeaker.clientId,
      sourceLanguage: turn.sourceLanguage,
      originalText: sourceText,
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

  private scheduleLiveCaption(args: { turnId: string; roomId: string; sourceText: string }) {
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
      void this.flushLiveCaptions(args.turnId, args.roomId);
    }, waitMs);
  }

  private async flushLiveCaptions(turnId: string, roomId: string) {
    const turn = this.activeTurns.get(turnId);
    if (!turn) {
      return;
    }
    const room = this.rooms.get(roomId);
    if (!room) {
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
    const sourceSpeaker = room.participants.get(turn.speakerId);
    if (!sourceSpeaker) {
      return;
    }

    const sendLive = (participant: RoomParticipant, translatedText: string) => {
      this.send(participant.socket, {
        type: "transcript.live",
        turnId,
        roomId,
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
    // Speaker self-monitor only: interim source text. Listeners get translation + TTS only on final transcript.chunk.
    sendLive(sourceSpeaker, sourceSnapshot);
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

  private ensureRoom(roomId: string): RoomState {
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing;
    }
    const room: RoomState = { roomId, participants: new Map() };
    this.rooms.set(roomId, room);
    return room;
  }

  private send(socket: WebSocket, event: ServerEvent) {
    if (socket.readyState !== 1) {
      return;
    }
    socket.send(JSON.stringify(event));
  }

  private broadcastToAll(event: ServerEvent) {
    for (const room of this.rooms.values()) {
      for (const participant of room.participants.values()) {
        this.send(participant.socket, event);
      }
    }
  }
}

