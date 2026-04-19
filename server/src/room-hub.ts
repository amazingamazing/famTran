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
  textChunks: string[];
};

const decodeAudioPayload = (payloadBase64: string): string => {
  try {
    return Buffer.from(payloadBase64, "base64").toString("utf8").trim();
  } catch {
    return "";
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
          textChunks: []
        });
        return;
      case "audio.input": {
        const turn = this.activeTurns.get(event.turnId);
        if (!turn) {
          return;
        }
        const textChunk = decodeAudioPayload(event.payloadBase64);
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
    const sourceText = turn.textChunks.join(" ").trim();
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

    for (const participant of room.participants.values()) {
      const targetLanguage = participant.language;
      const translatedText =
        participant.clientId === turn.speakerId
          ? sourceText
          : await this.providers.translateText({
              sourceText,
              sourceLanguage: turn.sourceLanguage,
              targetLanguage,
              context: { glossaryLines, correctionLines, recentTurns }
            });

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
        timestamp: Date.now()
      });

      if (participant.clientId !== turn.speakerId && participant.hearAudio) {
        this.send(participant.socket, {
          type: "audio.chunk",
          turnId,
          targetLanguage,
          mimeType: "audio/pcm",
          payloadBase64: Buffer.from(translatedText).toString("base64"),
          sequence: 0,
          isLast: true
        });
      }
    }
    this.activeTurns.delete(turnId);
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

