import { randomUUID } from "node:crypto";

import type { ClientEvent, ServerEvent, SupportedLanguage } from "@family-translation/shared";
import type { WebSocket } from "ws";

import type { AppDb } from "./db.js";
import type { ProviderPipeline } from "./providers.js";

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
          textChunks: []
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
    const room = this.rooms.get(turn.roomId);
    if (!room) {
      this.activeTurns.delete(turnId);
      return;
    }
    const transcription = await this.providers.transcribeSpeech({
      sourceLanguage: turn.sourceLanguage,
      chunks: turn.audioChunks,
      textHints: turn.textChunks
    });
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
    const participantDebugRows = await Promise.all(
      participants.map(async (participant) => {
        const targetLanguage = participant.language;
        const translation =
          participant.clientId === turn.speakerId
            ? {
                value: sourceText,
                path: "translation.self_passthrough",
                detail: "speaker_receives_source_text"
              }
            : await this.providers.translateText({
                sourceText,
                sourceLanguage: turn.sourceLanguage,
                targetLanguage,
                context: { glossaryLines, correctionLines, recentTurns }
              });
        const translatedText = translation.value;
        const shouldSynthesize = participant.clientId !== turn.speakerId && participant.hearAudio;

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
            ttsPath: shouldSynthesize ? "tts.deferred" : undefined
          }
        });

        if (shouldSynthesize) {
          void this.synthesizeAndSendAudio({
            participant,
            turnId,
            targetLanguage,
            text: translatedText,
            speakerId: sourceSpeaker.clientId
          });
        }

        return {
          clientId: participant.clientId,
          displayName: participant.displayName,
          targetLanguage,
          isSpeaker: participant.clientId === turn.speakerId,
          hearAudio: participant.hearAudio,
          translatedText,
          translationPath: translation.path,
          translationDetail: translation.detail,
          ttsPath: shouldSynthesize ? "tts.deferred" : undefined
        };
      })
    );

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
        textHintCount: turn.textChunks.length
      },
      participants: participantDebugRows
    });
    this.activeTurns.delete(turnId);
  }

  private async synthesizeAndSendAudio(args: {
    participant: RoomParticipant;
    turnId: string;
    targetLanguage: SupportedLanguage;
    text: string;
    speakerId: string;
  }) {
    const speech = await this.providers.synthesizeSpeech({
      text: args.text,
      targetLanguage: args.targetLanguage,
      speakerId: args.speakerId
    });

    this.send(args.participant.socket, {
      type: "audio.chunk",
      turnId: args.turnId,
      targetLanguage: args.targetLanguage,
      mimeType: "audio/pcm",
      payloadBase64: speech.value,
      sequence: 0,
      isLast: true
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

