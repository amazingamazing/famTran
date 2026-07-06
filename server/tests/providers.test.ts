import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildGeminiGenerateContentBody,
  InMemoryProviderPipeline,
  isGemini3FamilyModel,
  resolveSpeakerVoiceIndex,
  TTS_FETCH_TIMEOUT_MS,
  TRANSLATION_FETCH_TIMEOUT_MS
} from "../src/providers.js";

describe("Gemini provider helpers", () => {
  it("detects Gemini 3 family models by prefix", () => {
    expect(isGemini3FamilyModel("gemini-3.1-flash-lite")).toBe(true);
    expect(isGemini3FamilyModel("gemini-3-flash-preview")).toBe(true);
    expect(isGemini3FamilyModel("gemini-2.5-flash")).toBe(false);
    expect(isGemini3FamilyModel("gemini-2.0-flash")).toBe(false);
  });

  it("adds minimal thinkingConfig for Gemini 3 models", () => {
    const body = buildGeminiGenerateContentBody("Hello", "gemini-3.1-flash-lite") as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string } };
    };
    expect(body.generationConfig?.thinkingConfig?.thinkingLevel).toBe("minimal");
  });

  it("omits generationConfig for Gemini 2.5 models", () => {
    const body = buildGeminiGenerateContentBody("Hello", "gemini-2.5-flash") as {
      generationConfig?: unknown;
    };
    expect(body.generationConfig).toBeUndefined();
  });
});

describe("fetch timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("aborts hung Cartesia fetch and returns cartesia_exception with timeout detail", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    const pipeline = new InMemoryProviderPipeline(
      { stt: "deepgram", translation: "gemini", tts: "cartesia" },
      { cartesiaApiKey: "test-key" }
    );

    const promise = pipeline.synthesizeSpeech({
      text: "hello",
      targetLanguage: "en",
      speakerId: "speaker-a"
    });
    await vi.advanceTimersByTimeAsync(TTS_FETCH_TIMEOUT_MS);

    const result = await promise;
    expect(result.path).toBe("tts.cartesia_exception");
    expect(result.detail).toBe(`timeout=${TTS_FETCH_TIMEOUT_MS}ms`);
    expect(result.value).toBe("");
  });

  it(
    "aborts hung Gemini fetch and retries with timeout detail in failure path",
    async () => {
      vi.useFakeTimers();
      vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      });

      const pipeline = new InMemoryProviderPipeline(
        { stt: "deepgram", translation: "gemini", tts: "cartesia" },
        { geminiApiKey: "test-key" }
      );

      const promise = pipeline.translateText({
        sourceText: "hello",
        sourceLanguage: "en",
        targetLanguage: "ja",
        context: { glossaryLines: [], correctionLines: [], recentTurns: [] }
      });

      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result.path).toBe("translation.gemini_http_error");
      expect(result.detail).toContain(`timeout=${TRANSLATION_FETCH_TIMEOUT_MS}ms`);
    },
    30_000
  );
});

describe("Cartesia voice assignment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns cached voice index for the same speaker", () => {
    const used = new Set<number>();
    const first = resolveSpeakerVoiceIndex("speaker-a", 4, used);
    used.add(first);
    const second = resolveSpeakerVoiceIndex("speaker-a", 4, used, first);
    expect(second).toBe(first);
  });

  it("assigns index 0 then 1 sequentially regardless of speakerId hash", () => {
    const used = new Set<number>();
    expect(resolveSpeakerVoiceIndex("speaker-that-would-hash-to-3", 4, used)).toBe(0);
    used.add(0);
    expect(resolveSpeakerVoiceIndex("another-speaker", 4, used)).toBe(1);
  });

  it("uses stable voice ids and sequential indices per speaker in synthesizeSpeech", async () => {
    const voiceIds: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { voice?: { id?: string } };
      if (body.voice?.id) {
        voiceIds.push(body.voice.id);
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });

    const pipeline = new InMemoryProviderPipeline(
      { stt: "deepgram", translation: "gemini", tts: "cartesia" },
      { cartesiaApiKey: "test-key" }
    );

    const first = await pipeline.synthesizeSpeech({ text: "one", targetLanguage: "en", speakerId: "alice" });
    const second = await pipeline.synthesizeSpeech({ text: "two", targetLanguage: "en", speakerId: "alice" });
    const third = await pipeline.synthesizeSpeech({ text: "three", targetLanguage: "en", speakerId: "bob" });

    expect(voiceIds).toHaveLength(3);
    expect(voiceIds[0]).toBe(voiceIds[1]);
    expect(voiceIds[0]).not.toBe(voiceIds[2]);
    expect(first.path).toContain(":v0:");
    expect(third.path).toContain(":v1:");
  });
});
