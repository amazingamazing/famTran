import type { SupportedLanguage } from "@family-translation/shared";

export type ProviderSelection = {
  stt: "deepgram" | "openai";
  translation: "gemini" | "openai";
  tts: "cartesia" | "openai";
};

export type TranslationContext = {
  glossaryLines: string[];
  correctionLines: string[];
  recentTurns: Array<{ sourceText: string; targetText: string }>;
};

export type TranscriptionInput = {
  sourceLanguage: SupportedLanguage;
  chunks: Buffer[];
  textHints: string[];
};

type SynthInput = {
  text: string;
  targetLanguage: SupportedLanguage;
  speakerId: string;
};

type ProviderSecrets = {
  deepgramApiKey?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  cartesiaApiKey?: string;
  cartesiaModelId?: string;
  openAiApiKey?: string;
};

export interface ProviderPipeline {
  setProviders(next: ProviderSelection): ProviderSelection;
  getProviders(): ProviderSelection;
  transcribeSpeech(input: TranscriptionInput): Promise<string>;
  translateText(args: {
    sourceText: string;
    sourceLanguage: SupportedLanguage;
    targetLanguage: SupportedLanguage;
    context: TranslationContext;
  }): Promise<string>;
  synthesizeSpeech(args: SynthInput): Promise<string>;
}

export class InMemoryProviderPipeline implements ProviderPipeline {
  private providers: ProviderSelection;
  private readonly secrets: ProviderSecrets;

  constructor(initial: ProviderSelection, secrets: ProviderSecrets = {}) {
    this.providers = initial;
    this.secrets = secrets;
  }

  setProviders(next: ProviderSelection): ProviderSelection {
    this.providers = next;
    return this.providers;
  }

  getProviders(): ProviderSelection {
    return this.providers;
  }

  async transcribeSpeech(input: TranscriptionInput): Promise<string> {
    // Typed-message simulator uses UTF-8 payloads as text hints.
    const hinted = input.textHints.join(" ").trim();
    if (hinted.length > 0) {
      return hinted;
    }

    if (this.providers.stt === "deepgram" && this.secrets.deepgramApiKey && input.chunks.length > 0) {
      try {
        const buffer = Buffer.concat(input.chunks);
        const language = input.sourceLanguage === "ja" ? "ja" : "en";
        const response = await fetch(
          `https://api.deepgram.com/v1/listen?model=nova-3&language=${language}&encoding=linear16&sample_rate=16000&channels=1&smart_format=true`,
          {
            method: "POST",
            headers: {
              Authorization: `Token ${this.secrets.deepgramApiKey}`,
              "Content-Type": "application/octet-stream"
            },
            body: buffer
          }
        );
        if (!response.ok) {
          return "";
        }
        const payload = (await response.json()) as {
          results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
        };
        return payload.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
      } catch {
        return "";
      }
    }

    return "";
  }

  async translateText(args: {
    sourceText: string;
    sourceLanguage: SupportedLanguage;
    targetLanguage: SupportedLanguage;
    context: TranslationContext;
  }) {
    if (this.providers.translation === "gemini" && this.secrets.geminiApiKey) {
      const prompt = [
        `Translate from ${args.sourceLanguage} to ${args.targetLanguage}.`,
        "Output translation only, no explanation.",
        "",
        "Glossary:",
        ...args.context.glossaryLines.slice(0, 20),
        "",
        "Corrections:",
        ...args.context.correctionLines.slice(0, 20),
        "",
        "Recent turns:",
        ...args.context.recentTurns
          .slice(0, 3)
          .map((turn) => `source: ${turn.sourceText}\ntarget: ${turn.targetText}`),
        "",
        `Text: ${args.sourceText}`
      ].join("\n");

      const modelsToTry = [this.secrets.geminiModel ?? "gemini-2.5-flash", "gemini-2.0-flash"];
      for (const model of modelsToTry) {
        try {
          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.secrets.geminiApiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: prompt }] }]
              })
            }
          );
          if (!response.ok) {
            continue;
          }
          const payload = (await response.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
          if (text) {
            return text;
          }
        } catch {
          // Try fallback model.
        }
      }
    }

    if (this.providers.translation === "openai" && this.secrets.openAiApiKey) {
      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.secrets.openAiApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            temperature: 0.2,
            messages: [
              {
                role: "system",
                content: `Translate from ${args.sourceLanguage} to ${args.targetLanguage}. Output translation only.`
              },
              { role: "user", content: args.sourceText }
            ]
          })
        });
        if (response.ok) {
          const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
          return payload.choices?.[0]?.message?.content?.trim() ?? args.sourceText;
        }
      } catch {
        // Fall through to passthrough.
      }
    }

    return args.sourceText;
  }

  async synthesizeSpeech(args: SynthInput): Promise<string> {
    if (this.providers.tts === "cartesia" && this.secrets.cartesiaApiKey) {
      try {
        const response = await fetch("https://api.cartesia.ai/tts/bytes", {
          method: "POST",
          headers: {
            "X-API-Key": this.secrets.cartesiaApiKey,
            "Content-Type": "application/json",
            "Cartesia-Version": "2024-06-10"
          },
          body: JSON.stringify({
            model_id: this.secrets.cartesiaModelId ?? "sonic-2",
            transcript: args.text,
            language: args.targetLanguage === "ja" ? "ja" : "en",
            output_format: {
              container: "raw",
              encoding: "pcm_s16le",
              sample_rate: 22050
            },
            voice: {
              mode: "id",
              id: args.targetLanguage === "ja" ? "694f9389-aac1-45b6-b726-9d9369183238" : "f9836c6e-a0bd-460e-9d3c-f7299fa60f94"
            }
          })
        });
        if (response.ok) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          return Buffer.from(bytes).toString("base64");
        }
      } catch {
        // Fall through to fallback payload.
      }
    }

    if (this.providers.tts === "openai" && this.secrets.openAiApiKey) {
      try {
        const response = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.secrets.openAiApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "gpt-4o-mini-tts",
            voice: "alloy",
            input: args.text,
            format: "wav"
          })
        });
        if (response.ok) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          return Buffer.from(bytes).toString("base64");
        }
      } catch {
        // Fall through to fallback payload.
      }
    }

    return Buffer.from(args.text).toString("base64");
  }
}

