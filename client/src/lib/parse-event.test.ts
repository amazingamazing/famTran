import { describe, expect, it } from "vitest";

import { parseEvent } from "./parse-event";

describe("parseEvent", () => {
  it("returns parsed event for valid json", () => {
    const parsed = parseEvent(JSON.stringify({ type: "error", message: "bad packet" }));
    expect(parsed).toEqual({ type: "error", message: "bad packet" });
  });

  it("returns null for invalid json", () => {
    expect(parseEvent("not json")).toBeNull();
  });
});

