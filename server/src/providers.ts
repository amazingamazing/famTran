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

type PipelineResult<T> = {
  value: T;
  path: string;
  detail?: string;
};

export type TranscriptionResult = PipelineResult<string>;
export type TranslationResult = PipelineResult<string>;
export type SynthesisResult = PipelineResult<string>;

export interface ProviderPipeline {
  setProviders(next: ProviderSelection): ProviderSelection;
  getProviders(): ProviderSelection;
  transcribeSpeech(input: TranscriptionInput): Promise<TranscriptionResult>;
  translateText(args: {
    sourceText: string;
    sourceLanguage: SupportedLanguage;
    targetLanguage: SupportedLanguage;
    context: TranslationContext;
  }): Promise<TranslationResult>;
  synthesizeSpeech(args: SynthInput): Promise<SynthesisResult>;
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

  async transcribeSpeech(input: TranscriptionInput): Promise<TranscriptionResult> {
    // Typed-message simulator uses UTF-8 payloads as text hints.
    const hinted = input.textHints.join(" ").trim();
    if (hinted.length > 0) {
      return { value: hinted, path: "stt.hint_utf8" };
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
          return { value: "", path: "stt.deepgram_http_error", detail: `status=${response.status}` };
        }
        const payload = (await response.json()) as {
          results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
        };
        const transcript = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
        if (transcript.length > 0) {
          return { value: transcript, path: "stt.deepgram_api" };
        }
        return { value: "", path: "stt.deepgram_empty" };
      } catch {
        return { value: "", path: "stt.deepgram_exception" };
      }
    }

    return { value: "", path: "stt.no_input" };
  }

  async translateText(args: {
    sourceText: string;
    sourceLanguage: SupportedLanguage;
    targetLanguage: SupportedLanguage;
    context: TranslationContext;
  }): Promise<TranslationResult> {
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
      let geminiFailureDetail = "unknown";
      for (const model of modelsToTry) {
        let lastStatus = 0;
        let lastDetail = "";
        for (let attempt = 1; attempt <= 3; attempt += 1) {
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
              lastStatus = response.status;
              const responseText = await response.text();
              lastDetail = `model=${model} status=${response.status} body=${responseText.slice(0, 180)}`;
              geminiFailureDetail = lastDetail;
              if (response.status === 429 || response.status >= 500) {
                const waitMs = 300 * attempt;
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                continue;
              }
              break;
            }
            const payload = (await response.json()) as {
              candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            };
            const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
            if (text) {
              return { value: text, path: `translation.gemini_api:${model}` };
            }
            lastDetail = `model=${model} empty_candidate`;
            geminiFailureDetail = lastDetail;
          } catch {
            lastDetail = `model=${model} exception`;
            geminiFailureDetail = lastDetail;
            const waitMs = 300 * attempt;
            await new Promise((resolve) => setTimeout(resolve, waitMs));
          }
        }

        if (model === modelsToTry[modelsToTry.length - 1]) {
          break;
        }
      }

      if (this.secrets.openAiApiKey) {
        const rescue = await this.translateWithOpenAi(args);
        if (rescue) {
          return {
            value: rescue,
            path: "translation.openai_fallback_after_gemini_error",
            detail: geminiFailureDetail
          };
        }
      }

      return {
        value: args.sourceText,
        path: "translation.gemini_http_error",
        detail: geminiFailureDetail
      };
    }

    if (this.providers.translation === "openai" && this.secrets.openAiApiKey) {
      const translated = await this.translateWithOpenAi(args);
      if (translated) {
        return { value: translated, path: "translation.openai_api" };
      }
      return { value: args.sourceText, path: "translation.openai_error" };
    }

    return { value: args.sourceText, path: "translation.passthrough" };
  }

  async synthesizeSpeech(args: SynthInput): Promise<SynthesisResult> {
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
          return { value: Buffer.from(bytes).toString("base64"), path: "tts.cartesia_api" };
        }
        return { value: Buffer.from(args.text).toString("base64"), path: "tts.cartesia_http_error", detail: `status=${response.status}` };
      } catch {
        return { value: Buffer.from(args.text).toString("base64"), path: "tts.cartesia_exception" };
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
          return { value: Buffer.from(bytes).toString("base64"), path: "tts.openai_api" };
        }
        return { value: Buffer.from(args.text).toString("base64"), path: "tts.openai_http_error", detail: `status=${response.status}` };
      } catch {
        return { value: Buffer.from(args.text).toString("base64"), path: "tts.openai_exception" };
      }
    }

    return { value: Buffer.from(args.text).toString("base64"), path: "tts.passthrough_text_base64" };
  }

  private async translateWithOpenAi(args: {
    sourceText: string;
    sourceLanguage: SupportedLanguage;
    targetLanguage: SupportedLanguage;
  }): Promise<string | null> {
    if (!this.secrets.openAiApiKey) {
      return null;
    }
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
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = payload.choices?.[0]?.message?.content?.trim();
      return text && text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }
}

