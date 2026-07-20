export type SupportedLanguage = "en" | "ja";

export type VoiceGender = "male" | "female";

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

/** Shared multi-device family session vs ephemeral single-phone quick-chat. */
export type RoomType = "family" | "solo";

export type ServerEvent =
  | {
      type: "session.joined";
      clientId: string;
      roomType?: RoomType;
      roomId?: string;
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
      type: "transcript.edited";
      turnId: string;
      speakerId: string;
      speakerDisplayName: string;
      sourceLanguage: SupportedLanguage;
      targetLanguage: SupportedLanguage;
      originalText: string;
      translatedText: string;
      timestamp: number;
      editedAt: number;
    }
  | {
      type: "audio.chunk";
      turnId: string;
      targetLanguage: SupportedLanguage;
      mimeType: "audio/pcm" | "audio/wav";
      payloadBase64: string;
      sequence: number;
      isLast: boolean;
      debug?: {
        ttsPath?: string;
        ttsDetail?: string;
      };
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
        /**
         * Phrase-stream turns only: why the server skipped a full-utterance `transcript.chunk` replay at turn end
         * (avoids duplicate delivery when close() text differs only by punctuation/casing from streamed finals).
         */
        reconcile?: {
          committedCanonKeyEqClose: boolean;
          committedNormEqClose: boolean;
          exitReason: "canon_key_match" | "norm_key_match" | "empty_remainder";
        };
      };
      participants: Array<{
        clientId: string;
        displayName: string;
        targetLanguage: SupportedLanguage;
        isSpeaker: boolean;
        hearAudio: boolean;
        voiceGender: VoiceGender;
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
      voiceGender?: VoiceGender;
      /** Defaults to "family". Solo creates an ephemeral private room (no QR/join). */
      roomType?: RoomType;
    }
  | {
      type: "turn.start";
      turnId: string;
      speakerLanguage: SupportedLanguage;
      /**
       * Solo rooms: TTS gender for the *target* language on this utterance.
       * Family rooms ignore this and use the speaker's join voiceGender.
       */
      voiceGender?: VoiceGender;
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
    }
  | {
      type: "turn.edit";
      turnId: string;
      sourceText: string;
    }
  | {
      type: "turn.edit_translation";
      turnId: string;
      translatedText: string;
    };

export const isSupportedLanguage = (value: string): value is SupportedLanguage =>
  value === "en" || value === "ja";
