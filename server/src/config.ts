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
  }
};

