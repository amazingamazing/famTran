import { describe, expect, it } from "vitest";

import { buildGeminiGenerateContentBody, isGemini3FamilyModel } from "../src/providers.js";

describe("Gemini provider helpers", () => {
  it("detects Gemini 3 family models by prefix", () => {
    expect(isGemini3FamilyModel("gemini-3.1-flash-lite")).toBe(true);
    expect(isGemini3FamilyModel("gemini-3-flash-preview")).toBe(true);
    expect(isGemini3FamilyModel("gemini-2.5-flash")).toBe(false);
    expect(isGemini3FamilyModel("gemini-2.0-flash")).toBe(false);
  });

  it("adds minimal thinkingConfig for Gemini 3 models", () => {
    const body = buildGeminiGenerateContentBody("Hello", "gemini-3.1-flash-lite") as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string } };
    };
    expect(body.generationConfig?.thinkingConfig?.thinkingLevel).toBe("minimal");
  });

  it("omits generationConfig for Gemini 2.5 models", () => {
    const body = buildGeminiGenerateContentBody("Hello", "gemini-2.5-flash") as {
      generationConfig?: unknown;
    };
    expect(body.generationConfig).toBeUndefined();
  });
});
