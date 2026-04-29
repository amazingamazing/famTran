export const CONTROLS_EXPANDED_STORAGE_KEY = "family_translation_controls_expanded";

export const ONBOARDING_DONE_COOKIE = "family_translation_onboarding_done";
export const GLOSSARY_USER_ID_COOKIE = "family_translation_glossary_user_id";

export const getOrCreateGlossaryUserId = (
  getCookie: (name: string) => string,
  setCookie: (name: string, value: string) => void
): string => {
  const existing = getCookie(GLOSSARY_USER_ID_COOKIE).trim();
  if (existing) {
    return existing;
  }
  const created = crypto.randomUUID();
  setCookie(GLOSSARY_USER_ID_COOKIE, created);
  return created;
};

type AutoConnectArgs = {
  displayName: string;
  connected: boolean;
  alreadyAttempted: boolean;
};

export const shouldAutoConnectFromSavedSession = (args: AutoConnectArgs): boolean => {
  const hasSavedIdentity = args.displayName.trim().length > 0;
  return hasSavedIdentity && !args.connected && !args.alreadyAttempted;
};

export const readControlsExpandedPreference = (
  storage: Pick<Storage, "getItem"> | null,
  fallbackExpanded: boolean
): boolean => {
  if (!storage) {
    return fallbackExpanded;
  }

  const value = storage.getItem(CONTROLS_EXPANDED_STORAGE_KEY);
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallbackExpanded;
};

export const writeControlsExpandedPreference = (
  storage: Pick<Storage, "setItem"> | null,
  expanded: boolean
) => {
  if (!storage) {
    return;
  }
  storage.setItem(CONTROLS_EXPANDED_STORAGE_KEY, expanded ? "true" : "false");
};
