export const CONTROLS_EXPANDED_STORAGE_KEY = "family_translation_controls_expanded";

/** TTS gender when translating into Japanese (Quick Chat left button badge). */
export const QC_TTS_GENDER_JA_KEY = "family_translation_qc_tts_gender_ja";
/** TTS gender when translating into English (Quick Chat right button badge). */
export const QC_TTS_GENDER_EN_KEY = "family_translation_qc_tts_gender_en";

export const ONBOARDING_DONE_COOKIE = "family_translation_onboarding_done";
export const GLOSSARY_USER_ID_COOKIE = "family_translation_glossary_user_id";

export const parseStoredVoiceGender = (value: string | null | undefined): "male" | "female" =>
  value === "male" ? "male" : "female";

export const readQcTtsGender = (
  storage: Pick<Storage, "getItem"> | null,
  key: string,
  fallback: "male" | "female"
): "male" | "female" => {
  if (!storage) {
    return fallback;
  }
  return parseStoredVoiceGender(storage.getItem(key) ?? fallback);
};

export const writeQcTtsGender = (
  storage: Pick<Storage, "setItem"> | null,
  key: string,
  gender: "male" | "female"
) => {
  if (!storage) {
    return;
  }
  storage.setItem(key, gender);
};

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

export const MIC_STOP_GRACE_MS = 500;

export const canStartMicCapture = (args: { micTestActive: boolean; micFinishing: boolean }) =>
  !args.micTestActive && !args.micFinishing;

export const shouldRunMicStop = (args: {
  micTestActive: boolean;
  micTurnId: string | null;
  micFinishing: boolean;
}) => args.micTestActive || args.micTurnId !== null;

export const isMicStopNoOp = (args: { micFinishing: boolean; immediate: boolean }) =>
  args.micFinishing && !args.immediate;
