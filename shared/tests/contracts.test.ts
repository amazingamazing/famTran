import { describe, expect, it } from "vitest";

import { isSupportedLanguage } from "../src/index.js";

describe("shared contracts", () => {
  it("accepts only supported languages", () => {
    expect(isSupportedLanguage("en")).toBe(true);
    expect(isSupportedLanguage("ja")).toBe(true);
    expect(isSupportedLanguage("es")).toBe(false);
  });
});

