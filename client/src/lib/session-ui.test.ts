import { describe, expect, it, vi } from "vitest";

import {
  readControlsExpandedPreference,
  shouldAutoConnectFromSavedSession,
  writeControlsExpandedPreference
} from "./session-ui";

describe("session-ui helpers", () => {
  it("auto-connects only when saved identity exists and no prior attempt", () => {
    expect(
      shouldAutoConnectFromSavedSession({
        roomId: "ANACORN",
        displayName: "Alex",
        connected: false,
        alreadyAttempted: false
      })
    ).toBe(true);

    expect(
      shouldAutoConnectFromSavedSession({
        roomId: "   ",
        displayName: "Alex",
        connected: false,
        alreadyAttempted: false
      })
    ).toBe(false);

    expect(
      shouldAutoConnectFromSavedSession({
        roomId: "ANACORN",
        displayName: "Alex",
        connected: true,
        alreadyAttempted: false
      })
    ).toBe(false);

    expect(
      shouldAutoConnectFromSavedSession({
        roomId: "ANACORN",
        displayName: "Alex",
        connected: false,
        alreadyAttempted: true
      })
    ).toBe(false);
  });

  it("reads controls expanded preference with fallback", () => {
    const getItem = vi.fn().mockReturnValueOnce("true").mockReturnValueOnce("false").mockReturnValueOnce("invalid");
    const storage = { getItem } as Pick<Storage, "getItem">;

    expect(readControlsExpandedPreference(storage, false)).toBe(true);
    expect(readControlsExpandedPreference(storage, true)).toBe(false);
    expect(readControlsExpandedPreference(storage, true)).toBe(true);
  });

  it("writes controls expanded preference when storage exists", () => {
    const setItem = vi.fn();
    const storage = { setItem } as Pick<Storage, "setItem">;

    writeControlsExpandedPreference(storage, true);

    expect(setItem).toHaveBeenCalledWith("family_translation_controls_expanded", "true");
  });
});
