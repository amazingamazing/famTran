export type SupportedLanguage = "en" | "ja";

export type ProviderType = "deepgram" | "openai" | "gemini" | "cartesia";

export type ClientMode = "text_only" | "full_audio";

export type ServerEvent =
  | {
      type: "session.joined";
      clientId: string;
      roomId: string;
    }
  | {
      type: "transcript.chunk";
      turnId: string;
      speakerId: string;
      sourceLanguage: SupportedLanguage;
      targetLanguage: SupportedLanguage;
      translatedText: string;
      originalText: string;
      isFinal: boolean;
      timestamp: number;
    }
  | {
      type: "audio.chunk";
      turnId: string;
      targetLanguage: SupportedLanguage;
      mimeType: "audio/pcm";
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
    };

export type ClientEvent =
  | {
      type: "session.join";
      roomId: string;
      displayName: string;
      language: SupportedLanguage;
      mode: ClientMode;
      contextNotes: string;
      hearAudio: boolean;
    }
  | {
      type: "turn.start";
      turnId: string;
      roomId: string;
      speakerLanguage: SupportedLanguage;
    }
  | {
      type: "audio.input";
      turnId: string;
      roomId: string;
      payloadBase64: string;
      sequence: number;
      isLast: boolean;
    }
  | {
      type: "turn.stop";
      turnId: string;
      roomId: string;
    }
  | {
      type: "correction.submit";
      roomId: string;
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

