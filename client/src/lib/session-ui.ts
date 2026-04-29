export const CONTROLS_EXPANDED_STORAGE_KEY = "family_translation_controls_expanded";

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
