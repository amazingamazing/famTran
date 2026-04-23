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
   * When true (with sttStream + Deepgram), interim STT is debounce-translated and sent as `transcript.live` per participant.
   * End-of-utterance `transcript.chunk` + TTS are unchanged.
   */
  liveCaptions: process.env.LIVE_CAPTIONS === "1" || process.env.LIVE_CAPTIONS === "true"
};

