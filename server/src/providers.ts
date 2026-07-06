import { appConfig } from "./config.js";
import type { SttBenchmarkRow, SupportedLanguage, VoiceGender } from "@family-translation/shared";

export const TRANSLATION_FETCH_TIMEOUT_MS = 10_000;
export const TTS_FETCH_TIMEOUT_MS = 15_000;

export const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

export const isFetchTimeoutError = (err: unknown) =>
  err instanceof Error && err.name === "AbortError";

const CARTESIA_VOICES_JA = {
  male: ["30894953-bcce-41fe-892c-15ce19c843ff", "65209f8e-6140-4a20-b819-3cc2e21da19b"],
  female: ["d0ff6870-dd30-420d-8568-d756d806ea62", "498e7f37-7fa3-4e2c-b8e2-8b6e9276f956"]
} as const;

const CARTESIA_VOICES_EN = {
  male: ["630ed21c-2c5c-41cf-9d82-10a7fd668370", "47c38ca4-5f35-497b-b1a3-415245fb35e1"],
  female: ["db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", "f786b574-daa5-4673-aa0c-cbe3e8534c02"]
} as const;

const CARTESIA_VOICES_BY_LANG: Record<
  SupportedLanguage,
  { male: readonly string[]; female: readonly string[] }
> = {
  en: CARTESIA_VOICES_EN,
  ja: CARTESIA_VOICES_JA
};

export const hashSpeakerToVoiceIndex = (speakerId: string, poolSize: number): number => {
  let hash = 0;
  for (let i = 0; i < speakerId.length; i += 1) {
    hash = (hash * 31 + speakerId.charCodeAt(i)) >>> 0;
  }
  return hash % poolSize;
};

export const resolveSpeakerVoiceIndex = (
  speakerId: string,
  poolSize: number,
  usedIndices: ReadonlySet<number>,
  cachedIndex?: number
): number => {
  if (cachedIndex !== undefined) {
    return cachedIndex;
  }
  for (let i = 0; i < poolSize; i += 1) {
    if (!usedIndices.has(i)) {
      return i;
    }
  }
  return hashSpeakerToVoiceIndex(speakerId, poolSize);
};

export const isGemini3FamilyModel = (model: string) => model.startsWith("gemini-3");

export const buildGeminiGenerateContentBody = (prompt: string, model: string) => {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  };
  if (isGemini3FamilyModel(model)) {
    body.generationConfig = { thinkingConfig: { thinkingLevel: "minimal" } };
  }
  return body;
};

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
  voiceGender: VoiceGender;
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
export type SynthesisResult = PipelineResult<string> & { mimeType: "audio/pcm" | "audio/wav" };

export type TranscribeForTurnOutput = {
  result: TranscriptionResult;
  sttBenchmark?: SttBenchmarkRow[];
};

const linear16PcmToWavBuffer = (pcm: Buffer, sampleRate: number): Buffer => {
  const dataLen = pcm.length;
  const out = Buffer.alloc(44 + dataLen);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataLen, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataLen, 40);
  pcm.copy(out, 44);
  return out;
};

export interface ProviderPipeline {
  setProviders(next: ProviderSelection): ProviderSelection;
  getProviders(): ProviderSelection;
  transcribeSpeech(input: TranscriptionInput): Promise<TranscriptionResult>;
  transcribeForTurn(input: TranscriptionInput): Promise<TranscribeForTurnOutput>;
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
  private cartesiaVoiceIndexBySpeakerLang = new Map<string, number>();
  private cartesiaUsedIndicesByLangGender: Record<
    SupportedLanguage,
    Record<VoiceGender, Set<number>>
  > = {
    en: { male: new Set(), female: new Set() },
    ja: { male: new Set(), female: new Set() }
  };

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
    const hinted = input.textHints.join(" ").trim();
    if (hinted.length > 0) {
      return { value: hinted, path: "stt.hint_utf8" };
    }
    if (input.chunks.length === 0) {
      return { value: "", path: "stt.no_input" };
    }
    const buffer = Buffer.concat(input.chunks);
    if (this.providers.stt === "deepgram" && this.secrets.deepgramApiKey) {
      const r = await this.callDeepgramListen(buffer, input.sourceLanguage, "nova-3");
      if (r.value.trim().length > 0) {
        return { value: r.value, path: "stt.deepgram_api", detail: r.detail };
      }
      return { value: r.value, path: r.path, detail: r.detail };
    }
    if (this.providers.stt === "openai" && this.secrets.openAiApiKey) {
      const r = await this.callOpenAiWhisper(buffer, input.sourceLanguage);
      if (r.value.trim().length > 0) {
        return { value: r.value, path: "stt.openai_api", detail: r.detail };
      }
      return { value: r.value, path: r.path, detail: r.detail };
    }
    return { value: "", path: "stt.no_input" };
  }

  async transcribeForTurn(input: TranscriptionInput): Promise<TranscribeForTurnOutput> {
    const hinted = input.textHints.join(" ").trim();
    if (hinted.length > 0) {
      return { result: { value: hinted, path: "stt.hint_utf8" } };
    }
    if (!appConfig.sttBenchmark || input.chunks.length === 0) {
      return { result: await this.transcribeSpeech(input) };
    }
    return this.transcribeWithParallelSttBenchmark(input);
  }

  private async callDeepgramListen(
    buffer: Buffer,
    sourceLanguage: SupportedLanguage,
    model: "nova-2" | "nova-3"
  ): Promise<TranscriptionResult> {
    if (!this.secrets.deepgramApiKey) {
      return { value: "", path: "stt.deepgram_no_key" };
    }
    try {
      const language = sourceLanguage === "ja" ? "ja" : "en";
      const response = await fetch(
        `https://api.deepgram.com/v1/listen?model=${model}&language=${language}&encoding=linear16&sample_rate=16000&channels=1&smart_format=true`,
        {
          method: "POST",
          headers: {
            Authorization: `Token ${this.secrets.deepgramApiKey}`,
            "Content-Type": "application/octet-stream"
          },
          body: new Uint8Array(buffer)
        }
      );
      if (!response.ok) {
        return { value: "", path: `stt.deepgram_${model}_http_error`, detail: `status=${response.status}` };
      }
      const payload = (await response.json()) as {
        results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
      };
      const transcript = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
      if (transcript.length > 0) {
        return { value: transcript, path: `stt.deepgram_${model}` };
      }
      return { value: "", path: "stt.deepgram_empty" };
    } catch {
      return { value: "", path: "stt.deepgram_exception" };
    }
  }

  private async callOpenAiWhisper(buffer: Buffer, sourceLanguage: SupportedLanguage): Promise<TranscriptionResult> {
    if (!this.secrets.openAiApiKey) {
      return { value: "", path: "stt.openai_no_key" };
    }
    try {
      const wav = linear16PcmToWavBuffer(buffer, 16000);
      const language = sourceLanguage === "ja" ? "ja" : "en";
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
      form.append("model", "whisper-1");
      form.append("language", language);
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.secrets.openAiApiKey}` },
        body: form
      });
      if (!response.ok) {
        const body = await response.text();
        return {
          value: "",
          path: "stt.openai_whisper_http_error",
          detail: `status=${response.status} ${body.slice(0, 120)}`
        };
      }
      const payload = (await response.json()) as { text?: string };
      const text = payload.text?.trim() ?? "";
      if (text.length > 0) {
        return { value: text, path: "stt.openai_whisper-1" };
      }
      return { value: "", path: "stt.openai_whisper_empty" };
    } catch (err) {
      return { value: "", path: "stt.openai_whisper_exception", detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private rowFromBench(
    id: string,
    started: number,
    r: TranscriptionResult
  ): { row: SttBenchmarkRow; ok: boolean; result: TranscriptionResult } {
    const text = r.value;
    const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    return {
      row: {
        id,
        path: r.path,
        durationMs: Date.now() - started,
        text: preview,
        error: text.trim().length > 0 ? undefined : (r.detail ?? "empty")
      },
      ok: text.trim().length > 0,
      result: r
    };
  }

  private async transcribeWithParallelSttBenchmark(input: TranscriptionInput): Promise<TranscribeForTurnOutput> {
    const buffer = Buffer.concat(input.chunks);
    const lang = input.sourceLanguage;
    const tasks: Array<Promise<{ row: SttBenchmarkRow; ok: boolean; result: TranscriptionResult; id: string }>> = [];

    const timed = (id: string, run: () => Promise<TranscriptionResult>) => {
      return (async () => {
        const t0 = Date.now();
        try {
          const r = await run();
          return { ...this.rowFromBench(id, t0, r), id };
        } catch (err) {
          return {
            id,
            row: {
              id,
              path: "stt.benchmark_error",
              durationMs: Date.now() - t0,
              text: "",
              error: err instanceof Error ? err.message : String(err)
            },
            ok: false,
            result: { value: "", path: "stt.benchmark_error" }
          };
        }
      })();
    };

    if (this.secrets.deepgramApiKey) {
      tasks.push(timed("deepgram_nova-3", () => this.callDeepgramListen(buffer, lang, "nova-3")));
      tasks.push(timed("deepgram_nova-2", () => this.callDeepgramListen(buffer, lang, "nova-2")));
    }
    if (this.secrets.openAiApiKey) {
      tasks.push(timed("openai_whisper-1", () => this.callOpenAiWhisper(buffer, lang)));
    }

    if (tasks.length === 0) {
      return { result: await this.transcribeSpeech(input) };
    }

    const settled = await Promise.all(tasks);
    const sttBenchmark: SttBenchmarkRow[] = settled.map((s) => s.row);

    const find = (id: string) => settled.find((s) => s.id === id);
    let result: TranscriptionResult | null = null;
    if (this.providers.stt === "openai") {
      const s = find("openai_whisper-1");
      if (s?.ok) {
        result = { value: s.result.value, path: "stt.openai_api", detail: s.result.detail };
      }
    } else {
      const s = find("deepgram_nova-3");
      if (s?.ok) {
        result = { value: s.result.value, path: "stt.deepgram_api", detail: s.result.detail };
      }
    }
    if (!result) {
      const fallback = await this.transcribeSpeech(input);
      return { result: fallback, sttBenchmark };
    }
    return { result, sttBenchmark };
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

      const modelsToTry = [this.secrets.geminiModel ?? "gemini-3.1-flash-lite", "gemini-2.5-flash"];
      let geminiFailureDetail = "unknown";
      for (const model of modelsToTry) {
        let lastDetail = "";
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            const t0 = Date.now();
            const response = await fetchWithTimeout(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.secrets.geminiApiKey}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(buildGeminiGenerateContentBody(prompt, model))
              },
              TRANSLATION_FETCH_TIMEOUT_MS
            );
            if (!response.ok) {
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
              return { value: text, path: `translation.gemini_api:${model}:${Date.now() - t0}ms` };
            }
            lastDetail = `model=${model} empty_candidate`;
            geminiFailureDetail = lastDetail;
          } catch (err) {
            lastDetail = isFetchTimeoutError(err)
              ? `model=${model} timeout=${TRANSLATION_FETCH_TIMEOUT_MS}ms`
              : `model=${model} exception`;
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
        const modelId = this.secrets.cartesiaModelId ?? "sonic-3.5";
        const { voiceId, voiceIndex, voiceGender } = this.pickCartesiaVoice(
          args.targetLanguage,
          args.speakerId,
          args.voiceGender
        );
        const t0 = Date.now();
        const response = await fetchWithTimeout(
          "https://api.cartesia.ai/tts/bytes",
          {
            method: "POST",
            headers: {
              "X-API-Key": this.secrets.cartesiaApiKey,
              "Content-Type": "application/json",
              "Cartesia-Version": "2026-03-01"
            },
            body: JSON.stringify({
              model_id: modelId,
              transcript: args.text,
              language: args.targetLanguage === "ja" ? "ja" : "en",
              output_format: {
                container: "raw",
                encoding: "pcm_s16le",
                sample_rate: 22050
              },
              voice: {
                mode: "id",
                id: voiceId
              }
            })
          },
          TTS_FETCH_TIMEOUT_MS
        );
        if (response.ok) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          return {
            value: Buffer.from(bytes).toString("base64"),
            path: `tts.cartesia_api:${modelId}:${voiceGender}-v${voiceIndex}:${Date.now() - t0}ms`,
            mimeType: "audio/pcm"
          };
        }
        return {
          value: "",
          path: "tts.cartesia_http_error",
          detail: `status=${response.status}`,
          mimeType: "audio/pcm"
        };
      } catch (err) {
        return {
          value: "",
          path: "tts.cartesia_exception",
          detail: isFetchTimeoutError(err) ? `timeout=${TTS_FETCH_TIMEOUT_MS}ms` : undefined,
          mimeType: "audio/pcm"
        };
      }
    }

    if (this.providers.tts === "openai" && this.secrets.openAiApiKey) {
      try {
        const response = await fetchWithTimeout(
          "https://api.openai.com/v1/audio/speech",
          {
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
          },
          TTS_FETCH_TIMEOUT_MS
        );
        if (response.ok) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          return { value: Buffer.from(bytes).toString("base64"), path: "tts.openai_api", mimeType: "audio/wav" };
        }
        return {
          value: Buffer.from(args.text).toString("base64"),
          path: "tts.openai_http_error",
          detail: `status=${response.status}`,
          mimeType: "audio/wav"
        };
      } catch (err) {
        return {
          value: Buffer.from(args.text).toString("base64"),
          path: "tts.openai_exception",
          detail: isFetchTimeoutError(err) ? `timeout=${TTS_FETCH_TIMEOUT_MS}ms` : undefined,
          mimeType: "audio/wav"
        };
      }
    }

    return { value: Buffer.from(args.text).toString("base64"), path: "tts.passthrough_text_base64", mimeType: "audio/pcm" };
  }

  private invalidateSpeakerVoiceCacheForOtherGenders(
    targetLanguage: SupportedLanguage,
    speakerId: string,
    voiceGender: VoiceGender
  ): void {
    for (const gender of ["male", "female"] as const) {
      if (gender === voiceGender) {
        continue;
      }
      const oldKey = `${targetLanguage}:${gender}:${speakerId}`;
      const oldIndex = this.cartesiaVoiceIndexBySpeakerLang.get(oldKey);
      if (oldIndex === undefined) {
        continue;
      }
      this.cartesiaVoiceIndexBySpeakerLang.delete(oldKey);
      this.cartesiaUsedIndicesByLangGender[targetLanguage][gender].delete(oldIndex);
    }
  }

  private pickCartesiaVoice(
    targetLanguage: SupportedLanguage,
    speakerId: string,
    voiceGender: VoiceGender
  ): { voiceId: string; voiceIndex: number; voiceGender: VoiceGender } {
    this.invalidateSpeakerVoiceCacheForOtherGenders(targetLanguage, speakerId, voiceGender);

    const pool = CARTESIA_VOICES_BY_LANG[targetLanguage][voiceGender];
    const cacheKey = `${targetLanguage}:${voiceGender}:${speakerId}`;
    const cachedIndex = this.cartesiaVoiceIndexBySpeakerLang.get(cacheKey);
    const usedIndices = this.cartesiaUsedIndicesByLangGender[targetLanguage][voiceGender];
    const voiceIndex = resolveSpeakerVoiceIndex(speakerId, pool.length, usedIndices, cachedIndex);
    if (cachedIndex === undefined) {
      this.cartesiaVoiceIndexBySpeakerLang.set(cacheKey, voiceIndex);
      usedIndices.add(voiceIndex);
    }
    return { voiceId: pool[voiceIndex], voiceIndex, voiceGender };
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
      const response = await fetchWithTimeout(
        "https://api.openai.com/v1/chat/completions",
        {
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
        },
        TRANSLATION_FETCH_TIMEOUT_MS
      );
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

