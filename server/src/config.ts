import { config as dotenvConfig } from "dotenv";

dotenvConfig();

export const appConfig = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  databasePath: process.env.DATABASE_PATH ?? "./data/family-translation.sqlite",
  providers: {
    stt: (process.env.STT_PROVIDER ?? "deepgram") as "deepgram" | "openai",
    translation: (process.env.TRANSLATION_PROVIDER ?? "gemini") as "gemini" | "openai",
    tts: (process.env.TTS_PROVIDER ?? "cartesia") as "cartesia" | "openai"
  },
  apiKeys: {
    deepgram: process.env.DEEPGRAM_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    cartesia: process.env.CARTESIA_API_KEY,
    openAi: process.env.OPENAI_API_KEY
  },
  models: {
    gemini: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    cartesia: process.env.CARTESIA_MODEL_ID ?? "sonic-2"
  },
  /** When true, each speech turn runs parallel STT (e.g. Deepgram models + OpenAI) and includes timings in debug.turn. Extra API cost. */
  sttBenchmark: process.env.STT_BENCHMARK === "1" || process.env.STT_BENCHMARK === "true",
  /** When true, mic PCM is sent to Deepgram over a live WebSocket; disabled automatically when sttBenchmark is on (batch-only benchmark). */
  sttStream: process.env.STT_STREAM === "1" || process.env.STT_STREAM === "true",
  /**
   * When true (with sttStream + Deepgram), debounced interim STT is sent as `transcript.live` to the **speaker only** (self-monitor).
   * Listeners receive phrase-final `transcript.chunk` + TTS during the turn; `turn.stop` may emit a final chunk only when the batch STT adds new tail text beyond streamed phrases.
   */
  liveCaptions: process.env.LIVE_CAPTIONS === "1" || process.env.LIVE_CAPTIONS === "true",
  /**
   * Optional pause (ms) after `turn.stop` before STT resolve → translate → TTS. Gives streaming STT time to settle; e.g. 1000–1500 for JA.
   * Default 0 for fast dev/tests.
   */
  utteranceCommitDelayMs: Math.max(0, Number(process.env.UTTERANCE_COMMIT_DELAY_MS ?? 0) || 0),
  /**
   * After last `is_final` Deepgram phrase, brief wait before closing the stream so a trailing final can enqueue. Only used when phrase commits ran during the turn.
   */
  streamSegmentSettleMs: Math.max(0, Number(process.env.STREAM_SEGMENT_SETTLE_MS ?? 250) || 0),
  /**
   * Live STT only: silence duration (ms) before Deepgram marks an `is_final` phrase. Higher → fewer phrase breaks but later delivery.
   * 0 = use Deepgram default. Try 500–900 if short pauses (e.g. after questions) split one grammatical sentence.
   */
  deepgramLiveEndpointingMs: Math.max(0, Number(process.env.DEEPGRAM_LIVE_ENDPOINTING_MS ?? 0) || 0),
  /**
   * When >0, force-commit a rolling stream segment every N ms so long monologues do not stall phrase delivery.
   * Helps bound latency when Deepgram waits too long to emit `is_final`.
   */
  forcedStreamCommitMs: Math.max(0, Number(process.env.FORCED_STREAM_COMMIT_MS ?? 7000) || 0),
  /**
   * Minimum character count before a forced segment commit can fire.
   */
  forcedStreamCommitMinChars: Math.max(1, Number(process.env.FORCED_STREAM_COMMIT_MIN_CHARS ?? 24) || 24),
  /**
   * While merged transcript length is at most this many characters **and** it still has no sentence-ending
   * punctuation (. ? ! 。), each Deepgram `is_final` phrase is translated as soon as it arrives (“short
   * utterance”). Once any sentence break appears in the merged text, the server waits for full sentences even
   * below this length (see `mergedTranscriptHasSentenceBreak` in room-hub).
   */
  shortUtteranceMaxChars: Math.max(8, Number(process.env.SHORT_UTTERANCE_MAX_CHARS ?? 120) || 120)
};

