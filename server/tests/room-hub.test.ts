import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppDb } from "../src/db.js";
import { InMemoryProviderPipeline } from "../src/providers.js";
import { RoomHub } from "../src/room-hub.js";

class MockSocket {
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];

  send(payload: string) {
    this.sent.push(payload);
  }
}

class SlowTtsPipeline extends InMemoryProviderPipeline {
  override async synthesizeSpeech(args: { text: string; targetLanguage: "en" | "ja"; speakerId: string }) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return super.synthesizeSpeech(args);
  }
}

class WavTtsPipeline extends InMemoryProviderPipeline {
  override async synthesizeSpeech(args: { text: string; targetLanguage: "en" | "ja"; speakerId: string }) {
    const result = await super.synthesizeSpeech(args);
    return {
      ...result,
      mimeType: "audio/wav" as const
    };
  }
}

describe("RoomHub", () => {
  let dbDir = "";
  let db: AppDb;
  let hub: RoomHub;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "family-translation-test-"));
    db = new AppDb(join(dbDir, "app.sqlite"));
    hub = new RoomHub(
      db,
      new InMemoryProviderPipeline({
        stt: "deepgram",
        translation: "gemini",
        tts: "cartesia"
      })
    );
  });

  afterEach(() => {
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("sends translated transcript rows to participants", async () => {
    const enSocket = new MockSocket();
    const jaSocket = new MockSocket();
    const enClientId = hub.join(enSocket as never, {
      type: "session.join",
      displayName: "Alex",
      language: "en",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    hub.join(jaSocket as never, {
      type: "session.join",
      displayName: "Yuki",
      language: "ja",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    await hub.handleEvent(enClientId, {
      type: "turn.start",
      turnId: "turn-1",
      speakerLanguage: "en"
    });
    await hub.handleEvent(enClientId, {
      type: "audio.input",
      turnId: "turn-1",
      payloadBase64: Buffer.from("Hello family").toString("base64"),
      sequence: 0,
      isLast: true
    });
    await hub.handleEvent(enClientId, {
      type: "turn.stop",
      turnId: "turn-1",
    });

    const jaTranscriptMessage = jaSocket.sent.map((item) => JSON.parse(item)).find((event) => event.type === "transcript.chunk");
    expect(jaTranscriptMessage).toBeDefined();
    expect(jaTranscriptMessage.originalText).toBe("Hello family");
  });

  it("stores corrections for later translation context", async () => {
    const enSocket = new MockSocket();
    const enClientId = hub.join(enSocket as never, {
      type: "session.join",
      displayName: "Alex",
      language: "en",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    await hub.handleEvent(enClientId, {
      type: "correction.submit",
      wrongText: "Pepe",
      rightText: "Peh-peh",
      context: "Family dog"
    });

    const corrections = db.latestCorrections();
    expect(corrections).toHaveLength(1);
    expect(corrections[0].rightText).toBe("Peh-peh");
  });

  it("clears in-progress mic turn when the speaker disconnects", async () => {
    const socket = new MockSocket();
    const id = hub.join(socket as never, {
      type: "session.join",
      displayName: "Alex",
      language: "en",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    await hub.handleEvent(id, {
      type: "turn.start",
      turnId: "turn-dc",
      speakerLanguage: "en"
    });
    hub.leave(id);
    await hub.handleEvent(id, {
      type: "turn.stop",
      turnId: "turn-dc",
    });

    const debugTurns = socket.sent.map((item) => JSON.parse(item)).filter((event) => event.type === "debug.turn");
    expect(debugTurns).toHaveLength(0);
  });

  it("ignores audio.input from a client that is not the turn speaker", async () => {
    const speakerSocket = new MockSocket();
    const otherSocket = new MockSocket();
    const jaSocket = new MockSocket();
    const speakerId = hub.join(speakerSocket as never, {
      type: "session.join",
      displayName: "Speaker",
      language: "en",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });
    const otherId = hub.join(otherSocket as never, {
      type: "session.join",
      displayName: "Other",
      language: "en",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });
    hub.join(jaSocket as never, {
      type: "session.join",
      displayName: "Yuki",
      language: "ja",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    await hub.handleEvent(speakerId, {
      type: "turn.start",
      turnId: "turn-own",
      speakerLanguage: "en"
    });
    await hub.handleEvent(otherId, {
      type: "audio.input",
      turnId: "turn-own",
      payloadBase64: Buffer.from("Evil").toString("base64"),
      sequence: 0,
      isLast: true
    });
    await hub.handleEvent(speakerId, {
      type: "audio.input",
      turnId: "turn-own",
      payloadBase64: Buffer.from("Hello").toString("base64"),
      sequence: 0,
      isLast: true
    });
    await hub.handleEvent(speakerId, {
      type: "turn.stop",
      turnId: "turn-own",
    });

    const jaChunks = jaSocket.sent.map((item) => JSON.parse(item)).filter((e) => e.type === "transcript.chunk");
    expect(jaChunks.length).toBeGreaterThanOrEqual(1);
    expect(jaChunks[0].originalText).toBe("Hello");
  });

  it("does not treat raw pcm mic bytes as utf8 text hints", async () => {
    const enSocket = new MockSocket();
    const jaSocket = new MockSocket();
    const enClientId = hub.join(enSocket as never, {
      type: "session.join",
      displayName: "Alex",
      language: "en",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    hub.join(jaSocket as never, {
      type: "session.join",
      displayName: "Yuki",
      language: "ja",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    await hub.handleEvent(enClientId, {
      type: "turn.start",
      turnId: "turn-raw-audio",
      speakerLanguage: "en"
    });
    await hub.handleEvent(enClientId, {
      type: "audio.input",
      turnId: "turn-raw-audio",
      payloadBase64: Buffer.from([0, 0, 16, 255, 32, 128, 1, 254, 64, 192]).toString("base64"),
      sequence: 0,
      isLast: false
    });
    await hub.handleEvent(enClientId, {
      type: "turn.stop",
      turnId: "turn-raw-audio",
    });

    const transcriptMessages = jaSocket.sent.map((item) => JSON.parse(item)).filter((event) => event.type === "transcript.chunk");
    expect(transcriptMessages).toHaveLength(0);
  });

  it("sends transcript before delayed tts audio is ready", async () => {
    hub = new RoomHub(
      db,
      new SlowTtsPipeline({
        stt: "deepgram",
        translation: "gemini",
        tts: "cartesia"
      })
    );

    const enSocket = new MockSocket();
    const jaSocket = new MockSocket();
    const enClientId = hub.join(enSocket as never, {
      type: "session.join",
      displayName: "Alex",
      language: "en",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    hub.join(jaSocket as never, {
      type: "session.join",
      displayName: "Yuki",
      language: "ja",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    await hub.handleEvent(enClientId, {
      type: "turn.start",
      turnId: "turn-slow-tts",
      speakerLanguage: "en"
    });
    await hub.handleEvent(enClientId, {
      type: "audio.input",
      turnId: "turn-slow-tts",
      payloadBase64: Buffer.from("Hello family").toString("base64"),
      sequence: 0,
      isLast: true
    });

    await hub.handleEvent(enClientId, {
      type: "turn.stop",
      turnId: "turn-slow-tts",
    });

    const earlyEvents = jaSocket.sent.map((item) => JSON.parse(item));
    const earlyTranscript = earlyEvents.find((event) => event.type === "transcript.chunk");
    const earlyAudio = earlyEvents.find((event) => event.type === "audio.chunk");
    expect(earlyTranscript).toBeDefined();
    expect(earlyAudio).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 250));

    const lateEvents = jaSocket.sent.map((item) => JSON.parse(item));
    const lateAudio = lateEvents.find((event) => event.type === "audio.chunk");
    expect(lateAudio).toBeDefined();
  });

  it("broadcasts debug turn details to all participants", async () => {
    const enSocket = new MockSocket();
    const jaSocket = new MockSocket();
    const enClientId = hub.join(enSocket as never, {
      type: "session.join",
      displayName: "Alex",
      language: "en",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    hub.join(jaSocket as never, {
      type: "session.join",
      displayName: "Yuki",
      language: "ja",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    await hub.handleEvent(enClientId, {
      type: "turn.start",
      turnId: "turn-debug",
      speakerLanguage: "en"
    });
    await hub.handleEvent(enClientId, {
      type: "audio.input",
      turnId: "turn-debug",
      payloadBase64: Buffer.from("Hello family").toString("base64"),
      sequence: 0,
      isLast: true
    });
    await hub.handleEvent(enClientId, {
      type: "turn.stop",
      turnId: "turn-debug",
    });

    const enDebugTurn = enSocket.sent
      .map((item) => JSON.parse(item))
      .find((event) => event.type === "debug.turn");
    const jaDebugTurn = jaSocket.sent
      .map((item) => JSON.parse(item))
      .find((event) => event.type === "debug.turn");

    expect(enDebugTurn).toBeDefined();
    expect(jaDebugTurn).toBeDefined();
    expect(enDebugTurn.turnId).toBe("turn-debug");
    expect(enDebugTurn.originalText).toBe("Hello family");
    expect(enDebugTurn.participants).toHaveLength(2);
    expect(enDebugTurn.participants.some((entry: { targetLanguage: string }) => entry.targetLanguage === "en")).toBe(
      true
    );
    expect(enDebugTurn.participants.some((entry: { targetLanguage: string }) => entry.targetLanguage === "ja")).toBe(
      true
    );
  });

  it("forwards synthesized audio mime type to clients", async () => {
    hub = new RoomHub(
      db,
      new WavTtsPipeline({
        stt: "deepgram",
        translation: "gemini",
        tts: "cartesia"
      })
    );

    const enSocket = new MockSocket();
    const jaSocket = new MockSocket();
    const enClientId = hub.join(enSocket as never, {
      type: "session.join",
      displayName: "Alex",
      language: "en",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    hub.join(jaSocket as never, {
      type: "session.join",
      displayName: "Yuki",
      language: "ja",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    await hub.handleEvent(enClientId, {
      type: "turn.start",
      turnId: "turn-mime",
      speakerLanguage: "en"
    });
    await hub.handleEvent(enClientId, {
      type: "audio.input",
      turnId: "turn-mime",
      payloadBase64: Buffer.from("Hello family").toString("base64"),
      sequence: 0,
      isLast: true
    });
    await hub.handleEvent(enClientId, {
      type: "turn.stop",
      turnId: "turn-mime",
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    const audioMessage = jaSocket.sent.map((item) => JSON.parse(item)).find((event) => event.type === "audio.chunk");
    expect(audioMessage).toBeDefined();
    expect(audioMessage.mimeType).toBe("audio/wav");
  });
});

