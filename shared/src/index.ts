export type SupportedLanguage = "en" | "ja";

/** One parallel STT path result for STT_BENCHMARK=1; attached to debug.turn on the server. */
export type SttBenchmarkRow = {
  id: string;
  path: string;
  durationMs: number;
  /** Truncated transcript for size */
  text: string;
  error?: string;
};

export type ProviderType = "deepgram" | "openai" | "gemini" | "cartesia";

export type ClientMode = "text_only" | "full_audio";

export type ServerEvent =
  | {
      type: "session.joined";
      clientId: string;
    }
  | {
      type: "transcript.chunk";
      turnId: string;
      speakerId: string;
      speakerDisplayName: string;
      sourceLanguage: SupportedLanguage;
      targetLanguage: SupportedLanguage;
      translatedText: string;
      originalText: string;
      isFinal: boolean;
      timestamp: number;
      debug?: {
        transcriptionPath: string;
        transcriptionDetail?: string;
        translationPath: string;
        translationDetail?: string;
        ttsPath?: string;
        ttsDetail?: string;
      };
    }
  /**
   * Streaming partial: **speaker only** — debounced interim STT (same string in originalText and translatedText for passthrough).
   * Listeners do not receive this; they only get final `transcript.chunk` + `audio.chunk` after the utterance commits.
   */
  | {
      type: "transcript.live";
      turnId: string;
      speakerId: string;
      speakerDisplayName: string;
      sourceLanguage: SupportedLanguage;
      targetLanguage: SupportedLanguage;
      originalText: string;
      translatedText: string;
      liveSeq: number;
      timestamp: number;
    }
  | {
      type: "audio.chunk";
      turnId: string;
      targetLanguage: SupportedLanguage;
      mimeType: "audio/pcm" | "audio/wav";
      payloadBase64: string;
      sequence: number;
      isLast: boolean;
    }
  | {
      type: "providers.updated";
      stt: ProviderType;
      translation: ProviderType;
      tts: ProviderType;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "debug.turn";
      turnId: string;
      speakerId: string;
      sourceLanguage: SupportedLanguage;
      originalText: string;
      timestamp: number;
      transcription: {
        path: string;
        detail?: string;
        audioChunkCount: number;
        textHintCount: number;
        /** Set when server STT_BENCHMARK=1: parallel model timings and preview text. */
        sttBenchmark?: SttBenchmarkRow[];
      };
      participants: Array<{
        clientId: string;
        displayName: string;
        targetLanguage: SupportedLanguage;
        isSpeaker: boolean;
        hearAudio: boolean;
        translatedText: string;
        translationPath: string;
        translationDetail?: string;
        ttsPath?: string;
      }>;
    };

export type ClientEvent =
  | {
      type: "session.join";
      displayName: string;
      language: SupportedLanguage;
      mode: ClientMode;
      contextNotes: string;
      hearAudio: boolean;
    }
  | {
      type: "turn.start";
      turnId: string;
      speakerLanguage: SupportedLanguage;
    }
  | {
      type: "audio.input";
      turnId: string;
      payloadBase64: string;
      sequence: number;
      isLast: boolean;
    }
  | {
      type: "turn.stop";
      turnId: string;
    }
  | {
      type: "correction.submit";
      wrongText: string;
      rightText: string;
      context?: string;
    }
  | {
      type: "settings.providers";
      stt: ProviderType;
      translation: ProviderType;
      tts: ProviderType;
    };

export const isSupportedLanguage = (value: string): value is SupportedLanguage =>
  value === "en" || value === "ja";
