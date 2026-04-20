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
      roomId: "ROOM42",
      displayName: "Alex",
      language: "en",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    hub.join(jaSocket as never, {
      type: "session.join",
      roomId: "ROOM42",
      displayName: "Yuki",
      language: "ja",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    await hub.handleEvent(enClientId, {
      type: "turn.start",
      turnId: "turn-1",
      roomId: "ROOM42",
      speakerLanguage: "en"
    });
    await hub.handleEvent(enClientId, {
      type: "audio.input",
      turnId: "turn-1",
      roomId: "ROOM42",
      payloadBase64: Buffer.from("Hello family").toString("base64"),
      sequence: 0,
      isLast: true
    });
    await hub.handleEvent(enClientId, {
      type: "turn.stop",
      turnId: "turn-1",
      roomId: "ROOM42"
    });

    const jaTranscriptMessage = jaSocket.sent.map((item) => JSON.parse(item)).find((event) => event.type === "transcript.chunk");
    expect(jaTranscriptMessage).toBeDefined();
    expect(jaTranscriptMessage.originalText).toBe("Hello family");
  });

  it("stores corrections for later translation context", async () => {
    const enSocket = new MockSocket();
    const enClientId = hub.join(enSocket as never, {
      type: "session.join",
      roomId: "ROOM42",
      displayName: "Alex",
      language: "en",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    await hub.handleEvent(enClientId, {
      type: "correction.submit",
      roomId: "ROOM42",
      wrongText: "Pepe",
      rightText: "Peh-peh",
      context: "Family dog"
    });

    const corrections = db.latestCorrections("ROOM42");
    expect(corrections).toHaveLength(1);
    expect(corrections[0].rightText).toBe("Peh-peh");
  });

  it("does not treat raw pcm mic bytes as utf8 text hints", async () => {
    const enSocket = new MockSocket();
    const jaSocket = new MockSocket();
    const enClientId = hub.join(enSocket as never, {
      type: "session.join",
      roomId: "ROOM42",
      displayName: "Alex",
      language: "en",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    hub.join(jaSocket as never, {
      type: "session.join",
      roomId: "ROOM42",
      displayName: "Yuki",
      language: "ja",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    await hub.handleEvent(enClientId, {
      type: "turn.start",
      turnId: "turn-raw-audio",
      roomId: "ROOM42",
      speakerLanguage: "en"
    });
    await hub.handleEvent(enClientId, {
      type: "audio.input",
      turnId: "turn-raw-audio",
      roomId: "ROOM42",
      payloadBase64: Buffer.from([0, 0, 16, 255, 32, 128, 1, 254, 64, 192]).toString("base64"),
      sequence: 0,
      isLast: false
    });
    await hub.handleEvent(enClientId, {
      type: "turn.stop",
      turnId: "turn-raw-audio",
      roomId: "ROOM42"
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
      roomId: "ROOM42",
      displayName: "Alex",
      language: "en",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    hub.join(jaSocket as never, {
      type: "session.join",
      roomId: "ROOM42",
      displayName: "Yuki",
      language: "ja",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    await hub.handleEvent(enClientId, {
      type: "turn.start",
      turnId: "turn-slow-tts",
      roomId: "ROOM42",
      speakerLanguage: "en"
    });
    await hub.handleEvent(enClientId, {
      type: "audio.input",
      turnId: "turn-slow-tts",
      roomId: "ROOM42",
      payloadBase64: Buffer.from("Hello family").toString("base64"),
      sequence: 0,
      isLast: true
    });

    await hub.handleEvent(enClientId, {
      type: "turn.stop",
      turnId: "turn-slow-tts",
      roomId: "ROOM42"
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
});

