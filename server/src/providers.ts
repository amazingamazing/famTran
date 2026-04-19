import type { SupportedLanguage } from "@family-translation/shared";

type ProviderSelection = {
  stt: "deepgram" | "openai";
  translation: "gemini" | "openai";
  tts: "cartesia" | "openai";
};

export type TranslationContext = {
  glossaryLines: string[];
  correctionLines: string[];
  recentTurns: Array<{ sourceText: string; targetText: string }>;
};

export interface ProviderPipeline {
  setProviders(next: ProviderSelection): ProviderSelection;
  getProviders(): ProviderSelection;
  translateText(args: {
    sourceText: string;
    sourceLanguage: SupportedLanguage;
    targetLanguage: SupportedLanguage;
    context: TranslationContext;
  }): Promise<string>;
}

export class InMemoryProviderPipeline implements ProviderPipeline {
  private providers: ProviderSelection;

  constructor(initial: ProviderSelection) {
    this.providers = initial;
  }

  setProviders(next: ProviderSelection): ProviderSelection {
    this.providers = next;
    return this.providers;
  }

  getProviders(): ProviderSelection {
    return this.providers;
  }

  async translateText(args: {
    sourceText: string;
    sourceLanguage: SupportedLanguage;
    targetLanguage: SupportedLanguage;
    context: TranslationContext;
  }) {
    const header = `[${this.providers.translation}:${args.sourceLanguage}->${args.targetLanguage}]`;
    const contextTag = args.context.glossaryLines.length > 0 ? "ctx" : "plain";
    // Stub while provider APIs are wired; keeps routing and testing stable.
    return `${header}(${contextTag}) ${args.sourceText}`;
  }
}

