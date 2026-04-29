import { describe, expect, it, vi } from "vitest";

import {
  GLOSSARY_USER_ID_COOKIE,
  getOrCreateGlossaryUserId,
  readControlsExpandedPreference,
  shouldAutoConnectFromSavedSession,
  writeControlsExpandedPreference
} from "./session-ui";

describe("session-ui helpers", () => {
  it("auto-connects only when saved display name exists and no prior attempt", () => {
    expect(
      shouldAutoConnectFromSavedSession({
        displayName: "Alex",
        connected: false,
        alreadyAttempted: false
      })
    ).toBe(true);

    expect(
      shouldAutoConnectFromSavedSession({
        displayName: "   ",
        connected: false,
        alreadyAttempted: false
      })
    ).toBe(false);

    expect(
      shouldAutoConnectFromSavedSession({
        displayName: "Alex",
        connected: true,
        alreadyAttempted: false
      })
    ).toBe(false);

    expect(
      shouldAutoConnectFromSavedSession({
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

  it("returns stable glossary user id from cookie storage", () => {
    const store = new Map<string, string>();
    const getCookie = (name: string) => store.get(name) ?? "";
    const setCookie = (name: string, value: string) => {
      store.set(name, value);
    };
    const first = getOrCreateGlossaryUserId(getCookie, setCookie);
    expect(first.length).toBeGreaterThan(10);
    expect(store.get(GLOSSARY_USER_ID_COOKIE)).toBe(first);
    expect(getOrCreateGlossaryUserId(getCookie, setCookie)).toBe(first);
  });
});
