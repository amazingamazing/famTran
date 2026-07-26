import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppDb } from "../src/db.js";
import { InMemoryProviderPipeline } from "../src/providers.js";
import { SessionHub } from "../src/session-hub.js";

class MockSocket {
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];

  send(payload: string) {
    this.sent.push(payload);
  }
}

class SlowTtsPipeline extends InMemoryProviderPipeline {
  override async synthesizeSpeech(args: {
    text: string;
    targetLanguage: "en" | "ja";
    speakerId: string;
    voiceGender: "male" | "female";
  }) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return super.synthesizeSpeech(args);
  }
}

class WavTtsPipeline extends InMemoryProviderPipeline {
  override async synthesizeSpeech(args: {
    text: string;
    targetLanguage: "en" | "ja";
    speakerId: string;
    voiceGender: "male" | "female";
  }) {
    const result = await super.synthesizeSpeech(args);
    return {
      ...result,
      mimeType: "audio/wav" as const
    };
  }
}

describe("SessionHub", () => {
  let dbDir = "";
  let db: AppDb;
  let hub: SessionHub;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "family-translation-test-"));
    db = new AppDb(join(dbDir, "app.sqlite"));
    hub = new SessionHub(
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

  it("stores Japanese history when only English clients were connected during the turn", async () => {
    const enSocket = new MockSocket();
    const enClientId = hub.join(enSocket as never, {
      type: "session.join",
      displayName: "Thomas",
      language: "en",
      mode: "text_only",
      contextNotes: "",
      hearAudio: true
    });

    await hub.handleEvent(enClientId, {
      type: "turn.start",
      turnId: "turn-solo-en",
      speakerLanguage: "en"
    });
    await hub.handleEvent(enClientId, {
      type: "audio.input",
      turnId: "turn-solo-en",
      payloadBase64: Buffer.from("Hello from solo").toString("base64"),
      sequence: 0,
      isLast: true
    });
    await hub.handleEvent(enClientId, {
      type: "turn.stop",
      turnId: "turn-solo-en",
    });

    const jaHistory = db.historyForLanguage("ja", { limit: 20 });
    expect(jaHistory.some((row) => row.turnId === "turn-solo-en")).toBe(true);
    const jaRow = jaHistory.find((row) => row.turnId === "turn-solo-en");
    expect(jaRow?.originalText).toBe("Hello from solo");
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
    hub = new SessionHub(
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
    hub = new SessionHub(
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

  it("solo room routes en→ja transcript and TTS back to the speaker", async () => {
    const soloSocket = new MockSocket();
    const familySocket = new MockSocket();
    hub.join(familySocket as never, {
      type: "session.join",
      displayName: "Family",
      language: "ja",
      mode: "full_audio",
      contextNotes: "",
      hearAudio: true
    });

    const soloId = hub.join(soloSocket as never, {
      type: "session.join",
      displayName: "Solo",
      language: "ja",
      mode: "full_audio",
      contextNotes: "",
      hearAudio: true,
      roomType: "solo",
      voiceGender: "male"
    });

    await hub.handleEvent(soloId, {
      type: "turn.start",
      turnId: "solo-en",
      speakerLanguage: "en",
      voiceGender: "female"
    });
    await hub.handleEvent(soloId, {
      type: "audio.input",
      turnId: "solo-en",
      payloadBase64: Buffer.from("Good morning").toString("base64"),
      sequence: 0,
      isLast: true
    });
    await hub.handleEvent(soloId, { type: "turn.stop", turnId: "solo-en" });

    const soloEvents = soloSocket.sent.map((item) => JSON.parse(item));
    const transcript = soloEvents.find((event) => event.type === "transcript.chunk");
    const audio = soloEvents.find((event) => event.type === "audio.chunk");

    expect(transcript).toBeDefined();
    expect(transcript.sourceLanguage).toBe("en");
    expect(transcript.targetLanguage).toBe("ja");
    expect(transcript.originalText).toBe("Good morning");
    expect(transcript.translatedText).toBe("Good morning");
    expect(audio).toBeDefined();
    expect(audio.targetLanguage).toBe("ja");

    const familyTranscripts = familySocket.sent
      .map((item) => JSON.parse(item))
      .filter((event) => event.type === "transcript.chunk");
    expect(familyTranscripts).toHaveLength(0);
  });

  it("solo room routes ja→en transcript and TTS back to the speaker", async () => {
    const soloSocket = new MockSocket();
    const soloId = hub.join(soloSocket as never, {
      type: "session.join",
      displayName: "Solo",
      language: "en",
      mode: "full_audio",
      contextNotes: "",
      hearAudio: true,
      roomType: "solo"
    });

    await hub.handleEvent(soloId, {
      type: "turn.start",
      turnId: "solo-ja",
      speakerLanguage: "ja",
      voiceGender: "male"
    });
    await hub.handleEvent(soloId, {
      type: "audio.input",
      turnId: "solo-ja",
      payloadBase64: Buffer.from("こんにちは").toString("base64"),
      sequence: 0,
      isLast: true
    });
    await hub.handleEvent(soloId, { type: "turn.stop", turnId: "solo-ja" });

    const soloEvents = soloSocket.sent.map((item) => JSON.parse(item));
    const transcript = soloEvents.find((event) => event.type === "transcript.chunk");
    const audio = soloEvents.find((event) => event.type === "audio.chunk");

    expect(transcript).toBeDefined();
    expect(transcript.sourceLanguage).toBe("ja");
    expect(transcript.targetLanguage).toBe("en");
    expect(transcript.originalText).toBe("こんにちは");
    expect(audio).toBeDefined();
    expect(audio.targetLanguage).toBe("en");
  });

  it("solo Quick Chat still sends TTS when family hearAudio preference is false", async () => {
    const soloSocket = new MockSocket();
    const soloId = hub.join(soloSocket as never, {
      type: "session.join",
      displayName: "TextOnlyInRooms",
      language: "ja",
      mode: "full_audio",
      contextNotes: "",
      hearAudio: false,
      roomType: "solo",
      voiceGender: "female"
    });

    await hub.handleEvent(soloId, {
      type: "turn.start",
      turnId: "solo-hear-off-en",
      speakerLanguage: "en",
      voiceGender: "female"
    });
    await hub.handleEvent(soloId, {
      type: "audio.input",
      turnId: "solo-hear-off-en",
      payloadBase64: Buffer.from("Hello both sides").toString("base64"),
      sequence: 0,
      isLast: true
    });
    await hub.handleEvent(soloId, { type: "turn.stop", turnId: "solo-hear-off-en" });

    let soloEvents = soloSocket.sent.map((item) => JSON.parse(item));
    expect(soloEvents.some((event) => event.type === "audio.chunk")).toBe(true);
    expect(soloEvents.find((event) => event.type === "audio.chunk")?.targetLanguage).toBe("ja");

    soloSocket.sent.length = 0;
    await hub.handleEvent(soloId, {
      type: "turn.start",
      turnId: "solo-hear-off-ja",
      speakerLanguage: "ja",
      voiceGender: "male"
    });
    await hub.handleEvent(soloId, {
      type: "audio.input",
      turnId: "solo-hear-off-ja",
      payloadBase64: Buffer.from("こんにちは両側").toString("base64"),
      sequence: 0,
      isLast: true
    });
    await hub.handleEvent(soloId, { type: "turn.stop", turnId: "solo-hear-off-ja" });

    soloEvents = soloSocket.sent.map((item) => JSON.parse(item));
    expect(soloEvents.some((event) => event.type === "audio.chunk")).toBe(true);
    expect(soloEvents.find((event) => event.type === "audio.chunk")?.targetLanguage).toBe("en");
  });

  it("solo rooms write nothing to SQLite", async () => {
    const soloSocket = new MockSocket();
    const soloId = hub.join(soloSocket as never, {
      type: "session.join",
      displayName: "Solo",
      language: "en",
      mode: "full_audio",
      contextNotes: "",
      hearAudio: true,
      roomType: "solo"
    });

    await hub.handleEvent(soloId, {
      type: "turn.start",
      turnId: "solo-no-db",
      speakerLanguage: "en",
      voiceGender: "female"
    });
    await hub.handleEvent(soloId, {
      type: "audio.input",
      turnId: "solo-no-db",
      payloadBase64: Buffer.from("Ephemeral only").toString("base64"),
      sequence: 0,
      isLast: true
    });
    await hub.handleEvent(soloId, { type: "turn.stop", turnId: "solo-no-db" });
    await hub.handleEvent(soloId, {
      type: "correction.submit",
      wrongText: "x",
      rightText: "y",
      context: "should not persist"
    });

    expect(db.historyForLanguage("en", { limit: 20 })).toHaveLength(0);
    expect(db.historyForLanguage("ja", { limit: 20 })).toHaveLength(0);
    expect(db.latestCorrections()).toHaveLength(0);
    expect(db.latestTurns()).toHaveLength(0);
  });
});

