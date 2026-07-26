import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ProviderType,
  RoomType,
  ServerEvent,
  SupportedLanguage,
  VoiceGender
} from "@family-translation/shared";

import "./App.css";
import { appStrings } from "./lib/app-strings";
import {
  audioPayloadToObjectUrl,
  audioPayloadToWavBytes,
  ensurePlaybackAudioContext,
  panForTargetLanguage,
  playPannedWavBytes
} from "./lib/audio-playback";
import { startMicCapture, type MicCaptureHandle } from "./lib/mic-capture";
import { parseEvent } from "./lib/parse-event";
import {
  canStartMicCapture,
  getOrCreateGlossaryUserId,
  isMicStopNoOp,
  MIC_START_WARMUP_MS,
  MIC_STOP_GRACE_MS,
  ONBOARDING_DONE_COOKIE,
  QC_TTS_GENDER_EN_KEY,
  QC_TTS_GENDER_JA_KEY,
  readQcTtsGender,
  shouldAutoConnectFromSavedSession,
  shouldRunMicStop,
  writeQcTtsGender
} from "./lib/session-ui";

type AppMode = "rooms" | "quickChat";

type HistoryApiMessage = {
  id: number;
  turnId: string;
  speakerId: string;
  speakerName: string;
  sourceLanguage: SupportedLanguage;
  originalText: string;
  targetLanguage: SupportedLanguage;
  translatedText: string;
  createdAt: number;
  editedAt?: number;
};

type TranscriptRow = {
  historyId?: number;
  turnId: string;
  speakerId: string;
  speakerDisplayName: string;
  translatedText: string;
  originalText: string;
  targetLanguage: SupportedLanguage;
  timestamp: number;
  editedAt?: number;
  debug?: {
    transcriptionPath: string;
    transcriptionDetail?: string;
    translationPath: string;
    translationDetail?: string;
    ttsPath?: string;
    ttsDetail?: string;
  };
};

type LiveCaptionRow = {
  turnId: string;
  speakerId: string;
  speakerDisplayName: string;
  translatedText: string;
  originalText: string;
  targetLanguage: SupportedLanguage;
  liveSeq: number;
  timestamp: number;
};

type DebugTurnRow = Extract<ServerEvent, { type: "debug.turn" }>;

const mapHistoryToTranscriptRow = (m: HistoryApiMessage): TranscriptRow => ({
  historyId: m.id,
  turnId: m.turnId,
  speakerId: m.speakerId,
  speakerDisplayName: m.speakerName,
  translatedText: m.translatedText,
  originalText: m.originalText,
  targetLanguage: m.targetLanguage,
  timestamp: m.createdAt,
  editedAt: m.editedAt
});

const messageSortKey = (row: TranscriptRow) => row.timestamp;

function ChatMessageRow({
  item,
  showOriginalLabel,
  hideOriginalLabel,
  timeLocale,
  canEditSource,
  canEditTranslation,
  onSubmitSourceEdit,
  onSubmitTranslationEdit,
  editMessageLabel,
  editTranslationLabel,
  saveEditLabel,
  cancelEditLabel,
  editedLabel,
  alwaysShowOriginal = false,
  hideSpeakerMeta = false
}: {
  item: TranscriptRow;
  showOriginalLabel: string;
  hideOriginalLabel: string;
  timeLocale: string;
  canEditSource: boolean;
  canEditTranslation: boolean;
  onSubmitSourceEdit: (turnId: string, sourceText: string) => void;
  onSubmitTranslationEdit: (turnId: string, translatedText: string) => void;
  editMessageLabel: string;
  editTranslationLabel: string;
  saveEditLabel: string;
  cancelEditLabel: string;
  editedLabel: string;
  /** Quick Chat: always show muted original under the translation. */
  alwaysShowOriginal?: boolean;
  /** Quick Chat: omit speaker/edit chrome. */
  hideSpeakerMeta?: boolean;
}) {
  const [metaOpen, setMetaOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<"source" | "translation">("source");
  const [draft, setDraft] = useState(item.originalText);
  const hasOriginal =
    item.originalText.trim().length > 0 && item.originalText.trim() !== item.translatedText.trim();
  const isEdited = item.editedAt != null;
  const showOriginal = alwaysShowOriginal ? hasOriginal : hasOriginal && metaOpen;
  return (
    <li className={`chatMessage ${isEdited ? "chatMessageEdited" : ""}`} data-turn-id={item.turnId}>
      {hideSpeakerMeta ? null : (
        <div className="chatMeta">
          <div className="chatMetaLeft">
            <span className="chatSpeaker">{item.speakerDisplayName}</span>
            {isEdited ? <span className="chatEditedBadge">{editedLabel}</span> : null}
            {hasOriginal && !alwaysShowOriginal ? (
              <button
                type="button"
                className="chatToggleOriginalIcon"
                onClick={() => setMetaOpen((open) => !open)}
                aria-expanded={metaOpen}
                aria-label={metaOpen ? hideOriginalLabel : showOriginalLabel}
                title={metaOpen ? hideOriginalLabel : showOriginalLabel}
              >
                <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            ) : null}
            {canEditSource ? (
              <button
                type="button"
                className="chatToggleOriginalIcon"
                onClick={() => {
                  setDraft(item.originalText);
                  setEditTarget("source");
                  setEditOpen(true);
                }}
                aria-expanded={editOpen}
                aria-label={editMessageLabel}
                title={editMessageLabel}
              >
                <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
            ) : null}
            {canEditTranslation ? (
              <button
                type="button"
                className="chatToggleOriginalIcon"
                onClick={() => {
                  setDraft(item.translatedText);
                  setEditTarget("translation");
                  setEditOpen(true);
                }}
                aria-expanded={editOpen}
                aria-label={editTranslationLabel}
                title={editTranslationLabel}
              >
                <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 8h14M5 12h8M5 16h10" />
                  <path d="M17 3l4 4-7 7-4 1 1-4 6-8Z" />
                </svg>
              </button>
            ) : null}
          </div>
          <time className="chatTime" dateTime={new Date(item.timestamp).toISOString()}>
            {new Date(item.timestamp).toLocaleString(timeLocale)}
          </time>
        </div>
      )}
      <p className="chatBubbleMain">{item.translatedText}</p>
      {showOriginal ? <p className="chatBubbleOriginal">{item.originalText}</p> : null}
      {editOpen ? (
        <div className="chatEditBox">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} />
          <div className="actions">
            <button
              type="button"
              onClick={() => {
                if (editTarget === "source") {
                  onSubmitSourceEdit(item.turnId, draft.trim());
                } else {
                  onSubmitTranslationEdit(item.turnId, draft.trim());
                }
                setEditOpen(false);
              }}
              disabled={!draft.trim()}
            >
              {saveEditLabel}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditOpen(false);
                setDraft(editTarget === "source" ? item.originalText : item.translatedText);
              }}
            >
              {cancelEditLabel}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function AudioUnlockButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="transcriptAudioUnlock" onClick={onClick} aria-label={label}>
      <svg
        className="transcriptAudioUnlockIcon"
        viewBox="0 0 24 24"
        width={22}
        height={22}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      </svg>
    </button>
  );
}

const WS_BASE_URL =
  window.location.hostname === "localhost"
    ? "ws://localhost:8787"
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;

const HTTP_BASE_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:8787"
    : `${window.location.protocol}//${window.location.host}`;

const createTurnId = () => `turn-${crypto.randomUUID()}`;

const CHAT_PIN_THRESHOLD = 80;

const encodeStringAsBase64 = (value: string) => btoa(unescape(encodeURIComponent(value)));
const AUTOPILOT_MIN_MS = 15_000;
const AUTOPILOT_MAX_MS = 45_000;
const MAX_DEBUG_EVENTS = 120;
const MAX_DEBUG_TURNS = 80;

const AUTO_MESSAGES_EN = [
  "How is everyone feeling this afternoon?",
  "I am going to make tea in a few minutes.",
  "Pepe is sleeping on the couch again.",
  "Can we plan dinner for tonight?",
  "I need to leave for the store soon.",
  "This is a simulator message for latency testing.",
  "Let's talk about travel plans for next week.",
  "Please remind me to charge my earbuds.",
  "I am checking whether reconnection still works.",
  "The weather looks good for a walk later."
];

const AUTO_MESSAGES_JA = [
  "みんな、今日の午後はどんな気分ですか？",
  "あとでお茶をいれます。",
  "ペペはまたソファで寝ています。",
  "今夜の夕ご飯の予定を決めましょう。",
  "これから少し買い物に行きます。",
  "これはレイテンシーテスト用のシミュレーターメッセージです。",
  "来週の予定について話しましょう。",
  "イヤホンの充電を忘れないでください。",
  "再接続がまだうまくいくか確認しています。",
  "あとで散歩するのに良い天気ですね。"
];

const randomDelayMs = () =>
  Math.floor(Math.random() * (AUTOPILOT_MAX_MS - AUTOPILOT_MIN_MS + 1)) + AUTOPILOT_MIN_MS;

const randomAutoMessage = (language: SupportedLanguage) => {
  const pool = language === "ja" ? AUTO_MESSAGES_JA : AUTO_MESSAGES_EN;
  return pool[Math.floor(Math.random() * pool.length)];
};

const getCookie = (name: string): string => {
  const encodedName = `${encodeURIComponent(name)}=`;
  const cookieParts = document.cookie.split(";");
  for (const part of cookieParts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(encodedName)) {
      return decodeURIComponent(trimmed.slice(encodedName.length));
    }
  }
  return "";
};

const setCookie = (name: string, value: string, days = 180) => {
  const maxAge = days * 24 * 60 * 60;
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
};

const getCookieBoolean = (name: string, fallback: boolean) => {
  const raw = getCookie(name);
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return fallback;
};

const parseVoiceGender = (raw: string): VoiceGender => (raw === "male" ? "male" : "female");

const cookieProviderStt = getCookie("family_translation_provider_stt");
const initialProviderStt: ProviderType = cookieProviderStt === "openai" ? "openai" : "deepgram";

const cookieProviderTranslation = getCookie("family_translation_provider_translation");
const initialProviderTranslation: ProviderType = cookieProviderTranslation === "openai" ? "openai" : "gemini";

const cookieProviderTts = getCookie("family_translation_provider_tts");
const initialProviderTts: ProviderType = cookieProviderTts === "openai" ? "openai" : "cartesia";

const uint8ToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

function App() {
  const wsRef = useRef<WebSocket | null>(null);
  const audioQueueRef = useRef<
    Array<{
      payloadBase64: string;
      mimeType: "audio/pcm" | "audio/wav";
      isLast: boolean;
      targetLanguage?: SupportedLanguage;
    }>
  >([]);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const sharedPlaybackBlobUrlRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  const [qcPlaybackDebug, setQcPlaybackDebug] = useState("");
  const autopilotTimeoutRef = useRef<number | null>(null);
  const autoPilotEnabledRef = useRef(false);
  const debugEventsRef = useRef<string[]>([]);
  const debugTurnsRef = useRef<DebugTurnRow[]>([]);
  const micCaptureRef = useRef<MicCaptureHandle | null>(null);
  const micTurnIdRef = useRef<string | null>(null);
  const micSequenceRef = useRef(0);
  const micFinishingRef = useRef(false);
  const micStopGraceTimerRef = useRef<number | null>(null);
  const autoConnectAttemptedRef = useRef(false);
  const connectRef = useRef<(opts?: { roomType?: RoomType }) => void>(() => undefined);
  const stopMicTestRef = useRef<(opts?: { immediate?: boolean }) => Promise<void>>(async () => {});
  const onboardingDoneInit = getCookie(ONBOARDING_DONE_COOKIE) === "true";
  const [onboardingDone, setOnboardingDone] = useState(onboardingDoneInit);
  const [onboardingStep, setOnboardingStep] = useState<0 | 1 | 2 | 3>(0);
  const [onboardingNameDraft, setOnboardingNameDraft] = useState("");
  const [onboardingError, setOnboardingError] = useState("");

  const [displayName, setDisplayName] = useState(() =>
    onboardingDoneInit ? getCookie("family_translation_display_name") : ""
  );
  const [language, setLanguage] = useState<SupportedLanguage>(() => {
    if (!onboardingDoneInit) {
      return "en";
    }
    return getCookie("family_translation_language") === "ja" ? "ja" : "en";
  });
  const [contextNotes, setContextNotes] = useState(() => getCookie("family_translation_context_notes"));
  const [hearAudio, setHearAudio] = useState(() =>
    onboardingDoneInit ? getCookieBoolean("family_translation_hear_audio", true) : true
  );
  const [voiceGender, setVoiceGender] = useState<VoiceGender>(() =>
    onboardingDoneInit ? parseVoiceGender(getCookie("family_translation_voice_gender")) : "female"
  );
  const [appMode, setAppMode] = useState<AppMode>("quickChat");
  const appModeRef = useRef<AppMode>("quickChat");
  const [qcSpeaking, setQcSpeaking] = useState<SupportedLanguage | null>(null);
  const [qcGenderJa, setQcGenderJa] = useState<VoiceGender>(() =>
    readQcTtsGender(
      typeof localStorage === "undefined" ? null : localStorage,
      QC_TTS_GENDER_JA_KEY,
      onboardingDoneInit ? parseVoiceGender(getCookie("family_translation_voice_gender")) : "female"
    )
  );
  const [qcGenderEn, setQcGenderEn] = useState<VoiceGender>(() =>
    readQcTtsGender(
      typeof localStorage === "undefined" ? null : localStorage,
      QC_TTS_GENDER_EN_KEY,
      onboardingDoneInit ? parseVoiceGender(getCookie("family_translation_voice_gender")) : "female"
    )
  );
  const [connected, setConnected] = useState(false);
  const [clientId, setClientId] = useState("");
  const clientIdRef = useRef("");
  const [textInput, setTextInput] = useState("");
  const [transcripts, setTranscripts] = useState<TranscriptRow[]>([]);
  const [liveCaption, setLiveCaption] = useState<LiveCaptionRow | null>(null);
  const [providerStt, setProviderStt] = useState<ProviderType>(initialProviderStt);
  const [providerTranslation, setProviderTranslation] = useState<ProviderType>(initialProviderTranslation);
  const [providerTts, setProviderTts] = useState<ProviderType>(initialProviderTts);
  const [correctionWrong, setCorrectionWrong] = useState("");
  const [correctionRight, setCorrectionRight] = useState("");
  const [correctionContext, setCorrectionContext] = useState("");
  const [manualTerm, setManualTerm] = useState("");
  const [manualTranslation, setManualTranslation] = useState("");
  const [manualNotes, setManualNotes] = useState("");
  const [networkOnline, setNetworkOnline] = useState(navigator.onLine);
  const [statusMessage, setStatusMessage] = useState(() =>
    appStrings(
      getCookie(ONBOARDING_DONE_COOKIE) === "true" && getCookie("family_translation_language") === "ja"
        ? "ja"
        : "en"
    ).statusNotConnected
  );
  const [autoPilotEnabled, setAutoPilotEnabled] = useState(false);
  const [autoPilotRuns, setAutoPilotRuns] = useState(0);
  const [nextAutoDelaySeconds, setNextAutoDelaySeconds] = useState<number | null>(null);
  const [micTestActive, setMicTestActive] = useState(false);
  const [micFinishing, setMicFinishing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [playbackUnlocked, setPlaybackUnlocked] = useState(false);
  const [permissionReady, setPermissionReady] = useState(false);
  const [hasUnseenEditedAbove, setHasUnseenEditedAbove] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingOlderRef = useRef(false);
  const pinnedToBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const updateChatScrollPin = useCallback(() => {
    const el = threadRef.current;
    if (!el) {
      return;
    }
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = gap <= CHAT_PIN_THRESHOLD;
    pinnedToBottomRef.current = pinned;
    const scrollable = el.scrollHeight > el.clientHeight + 4;
    setShowJumpToLatest(!pinned && scrollable);
  }, []);

  const addDebugEvent = useCallback((message: string) => {
    const entry = `${new Date().toISOString()} ${message}`;
    debugEventsRef.current = [entry, ...debugEventsRef.current].slice(0, MAX_DEBUG_EVENTS);
  }, []);

  const clearAutoPilotTimer = () => {
    if (autopilotTimeoutRef.current !== null) {
      window.clearTimeout(autopilotTimeoutRef.current);
      autopilotTimeoutRef.current = null;
    }
    setNextAutoDelaySeconds(null);
  };

  const playQueue = () => {
    if (playingRef.current) {
      return;
    }
    const next = audioQueueRef.current.shift();
    if (!next) {
      return;
    }
    playingRef.current = true;

    if (appModeRef.current === "quickChat") {
      void (async () => {
        try {
          const ctx = await ensurePlaybackAudioContext();
          const micLive = micCaptureRef.current?.isLive() ?? false;
          setQcPlaybackDebug(
            `ch=${ctx.destination.channelCount} (max ${ctx.destination.maxChannelCount}) micLive=${micLive}`
          );
          addDebugEvent(
            `audio.qc.play ch=${ctx.destination.channelCount} micLive=${micLive} panLang=${next.targetLanguage ?? "n/a"}`
          );
          const pan = panForTargetLanguage(next.targetLanguage);
          const wavBytes = audioPayloadToWavBytes(next.payloadBase64, next.mimeType);
          // Play even if mic is still live (iOS may mono-downmix); never block on mic state.
          await playPannedWavBytes(ctx, wavBytes, pan);
        } catch {
          addDebugEvent(`audio.qc.playback.failed mime=${next.mimeType}`);
        } finally {
          playingRef.current = false;
          playQueue();
        }
      })();
      return;
    }

    try {
      const playable = audioPayloadToObjectUrl(next.payloadBase64, next.mimeType);
      const url = playable.url;
      const shared = playbackAudioRef.current;

      const finishShared = (revokeUrl: string) => {
        if (sharedPlaybackBlobUrlRef.current === revokeUrl) {
          URL.revokeObjectURL(revokeUrl);
          sharedPlaybackBlobUrlRef.current = null;
        }
      };

      if (shared) {
        if (sharedPlaybackBlobUrlRef.current) {
          URL.revokeObjectURL(sharedPlaybackBlobUrlRef.current);
          sharedPlaybackBlobUrlRef.current = null;
        }
        sharedPlaybackBlobUrlRef.current = url;

        let finished = false;
        const onDone = (debug?: string) => {
          if (finished) {
            return;
          }
          finished = true;
          if (debug) {
            addDebugEvent(debug);
          }
          finishShared(url);
          playingRef.current = false;
          playQueue();
        };

        shared.onended = () => onDone();
        shared.onerror = () => onDone(`audio.playback.error mime=${next.mimeType}`);
        shared.src = url;
        shared.load();
        void shared.play().catch(() => onDone(`audio.playback.blocked mime=${next.mimeType}`));
        return;
      }

      const audio = new Audio(url);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        playingRef.current = false;
        playQueue();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        playingRef.current = false;
        addDebugEvent(`audio.playback.error mime=${next.mimeType}`);
        playQueue();
      };
      void audio.play().catch(() => {
        URL.revokeObjectURL(url);
        playingRef.current = false;
        addDebugEvent(`audio.playback.blocked mime=${next.mimeType}`);
        playQueue();
      });
    } catch {
      playingRef.current = false;
      addDebugEvent(`audio.playback.decode_failed mime=${next.mimeType}`);
      playQueue();
    }
  };

  const unlockPlaybackAudio = useCallback(async () => {
    if (playbackUnlocked && playbackAudioRef.current) {
      try {
        await ensurePlaybackAudioContext();
      } catch {
        /* ignore — HTML audio unlock already done */
      }
      return;
    }
    try {
      const silentPcm = new Int16Array(1200);
      const bytes = new Uint8Array(silentPcm.buffer);
      const b64 = uint8ToBase64(bytes);
      const playable = audioPayloadToObjectUrl(b64, "audio/pcm");
      const url = playable.url;

      if (!playbackAudioRef.current) {
        playbackAudioRef.current = new Audio();
      }
      const el = playbackAudioRef.current;
      el.src = url;
      el.load();
      await el.play();
      URL.revokeObjectURL(url);
      el.removeAttribute("src");
      el.load();

      await ensurePlaybackAudioContext();

      setPlaybackUnlocked(true);
      addDebugEvent("audio.unlock.ok");
    } catch {
      addDebugEvent("audio.unlock.failed");
    }
  }, [addDebugEvent, playbackUnlocked]);

  useEffect(() => {
    const onOnline = () => setNetworkOnline(true);
    const onOffline = () => setNetworkOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(
    () => () => {
      clearAutoPilotTimer();
    },
    []
  );

  useEffect(
    () => () => {
      if (micStopGraceTimerRef.current !== null) {
        window.clearTimeout(micStopGraceTimerRef.current);
        micStopGraceTimerRef.current = null;
      }
      void stopMicTestRef.current({ immediate: true });
    },
    []
  );

  useEffect(() => {
    autoPilotEnabledRef.current = autoPilotEnabled;
  }, [autoPilotEnabled]);

  useEffect(() => {
    if (displayName.trim()) {
      setCookie("family_translation_display_name", displayName.trim());
    }
  }, [displayName]);

  useEffect(() => {
    setCookie("family_translation_language", language);
  }, [language]);

  useEffect(() => {
    setCookie("family_translation_hear_audio", String(hearAudio));
  }, [hearAudio]);

  useEffect(() => {
    setCookie("family_translation_voice_gender", voiceGender);
  }, [voiceGender]);

  useEffect(() => {
    appModeRef.current = appMode;
  }, [appMode]);

  useEffect(() => {
    writeQcTtsGender(
      typeof localStorage === "undefined" ? null : localStorage,
      QC_TTS_GENDER_JA_KEY,
      qcGenderJa
    );
  }, [qcGenderJa]);

  useEffect(() => {
    writeQcTtsGender(
      typeof localStorage === "undefined" ? null : localStorage,
      QC_TTS_GENDER_EN_KEY,
      qcGenderEn
    );
  }, [qcGenderEn]);

  useEffect(() => {
    setCookie("family_translation_context_notes", contextNotes);
  }, [contextNotes]);

  useEffect(() => {
    setCookie("family_translation_provider_stt", providerStt);
  }, [providerStt]);

  useEffect(() => {
    setCookie("family_translation_provider_translation", providerTranslation);
  }, [providerTranslation]);

  useEffect(() => {
    setCookie("family_translation_provider_tts", providerTts);
  }, [providerTts]);

  useEffect(() => {
    if (!onboardingDone || appMode === "quickChat") {
      if (appMode === "quickChat") {
        setHistoryLoading(false);
        setHistoryHasMore(false);
      }
      return;
    }
    let cancelled = false;
    (async () => {
      setHistoryLoading(true);
      setTranscripts([]);
      setHistoryHasMore(false);
      try {
        const response = await fetch(`${HTTP_BASE_URL}/api/history?language=${language}&limit=50`);
        const data = (await response.json()) as { messages?: HistoryApiMessage[]; hasMore?: boolean };
        if (cancelled) {
          return;
        }
        setTranscripts((data.messages ?? []).map(mapHistoryToTranscriptRow));
        setHistoryHasMore(data.hasMore === true);
      } catch {
        if (!cancelled) {
          setTranscripts([]);
          setHistoryHasMore(false);
        }
      } finally {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onboardingDone, language, appMode]);

  useEffect(() => {
    if (historyLoading || !onboardingDone) {
      return;
    }
    const el = threadRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    pinnedToBottomRef.current = true;
    requestAnimationFrame(() => {
      setShowJumpToLatest(false);
    });
  }, [historyLoading, onboardingDone, language]);

  const loadOlderHistory = useCallback(async () => {
    if (!onboardingDone || appMode === "quickChat" || !historyHasMore || loadingOlderRef.current) {
      return;
    }
    const ids = transcripts.map((row) => row.historyId).filter((id): id is number => id != null);
    if (ids.length === 0) {
      return;
    }
    const minId = Math.min(...ids);
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const root = threadRef.current;
    const prevHeight = root?.scrollHeight ?? 0;
    try {
      const response = await fetch(
        `${HTTP_BASE_URL}/api/history?language=${language}&beforeId=${minId}&limit=40`
      );
      const data = (await response.json()) as { messages?: HistoryApiMessage[]; hasMore?: boolean };
      const older = (data.messages ?? []).map(mapHistoryToTranscriptRow);
      setTranscripts((previous) => [...older, ...previous]);
      setHistoryHasMore(data.hasMore === true);
      requestAnimationFrame(() => {
        const el = threadRef.current;
        if (el) {
          el.scrollTop += el.scrollHeight - prevHeight;
        }
        updateChatScrollPin();
      });
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [appMode, historyHasMore, language, onboardingDone, transcripts, updateChatScrollPin]);

  useEffect(() => {
    if (!onboardingDone) {
      return;
    }
    const root = threadRef.current;
    const target = topSentinelRef.current;
    if (!root || !target) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadOlderHistory();
        }
      },
      { root, rootMargin: "120px 0px 0px 0px", threshold: 0 }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [onboardingDone, historyHasMore, language, transcripts, historyLoading, loadOlderHistory]);

  const S = useMemo(() => appStrings(language), [language]);

  const runPermissionWarmup = useCallback(async () => {
    try {
      await unlockPlaybackAudio();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1
        }
      });
      stream.getTracks().forEach((track) => track.stop());
      setPermissionReady(true);
      addDebugEvent("permissions.warmup.ok");
    } catch {
      addDebugEvent("permissions.warmup.failed");
    }
  }, [addDebugEvent, unlockPlaybackAudio]);

  const completeOnboardingWithName = async () => {
    const name = onboardingNameDraft.trim();
    const copy = appStrings(language);
    if (!name) {
      setOnboardingError(copy.onboardingNameRequired);
      return;
    }
    setOnboardingError("");
    const glossaryUserId = getOrCreateGlossaryUserId(getCookie, setCookie);
    const notes =
      language === "ja"
        ? "家族の表示名。翻訳で置き換え・言い換えしない。Family display name; preserve exactly in EN/JA."
        : "Family display name; preserve exactly in EN/JA. 家族の表示名—翻訳で置き換え・言い換えしない。";
    let glossaryOk = false;
    try {
      const response = await fetch(`${HTTP_BASE_URL}/api/glossary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: glossaryUserId,
          term: name,
          translation: name,
          notes
        })
      });
      glossaryOk = response.ok;
    } catch {
      glossaryOk = false;
    }
    setCookie(ONBOARDING_DONE_COOKIE, "true");
    setDisplayName(name);
    setOnboardingDone(true);
    setOnboardingStep(0);
    setOnboardingNameDraft("");
    if (!glossaryOk) {
      setStatusMessage(copy.onboardingGlossaryWarning);
    } else {
      setStatusMessage(copy.statusNotConnected);
    }
  };

  const sendTurn = (messageText: string, source: "manual" | "autopilot") => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !messageText.trim() || !connected) {
      return false;
    }
    const turnId = createTurnId();
    wsRef.current.send(
      JSON.stringify({
        type: "turn.start",
        turnId,
        speakerLanguage: language
      })
    );
    wsRef.current.send(
      JSON.stringify({
        type: "audio.input",
        turnId,
        payloadBase64: encodeStringAsBase64(messageText.trim()),
        sequence: 0,
        isLast: true
      })
    );
    wsRef.current.send(
      JSON.stringify({
        type: "turn.stop",
        turnId
      })
    );
    addDebugEvent(`turn.sent source=${source} turnId=${turnId} chars=${messageText.trim().length}`);
    return true;
  };

  const scheduleAutoPilot = () => {
    if (!autoPilotEnabledRef.current) {
      return;
    }
    const delay = randomDelayMs();
    setNextAutoDelaySeconds(Math.round(delay / 1000));
    autopilotTimeoutRef.current = window.setTimeout(() => {
      const sent = sendTurn(randomAutoMessage(language), "autopilot");
      if (sent) {
        setAutoPilotRuns((previous) => previous + 1);
      }
      scheduleAutoPilot();
    }, delay);
  };

  const connect = (opts?: { roomType?: RoomType }) => {
    if (!displayName.trim()) {
      setStatusMessage(S.statusSetNameFirst);
      return;
    }
    const roomType: RoomType =
      opts?.roomType ?? (appModeRef.current === "quickChat" ? "solo" : "family");
    const solo = roomType === "solo";
    wsRef.current?.close();
    const ws = new WebSocket(WS_BASE_URL);
    wsRef.current = ws;
    addDebugEvent(`socket.connecting lang=${language} roomType=${roomType}`);

    ws.onopen = () => {
      setStatusMessage(S.statusSocketConnected);
      addDebugEvent("socket.open");
      ws.send(
        JSON.stringify({
          type: "session.join",
          displayName,
          language,
          mode: solo ? "full_audio" : "text_only",
          contextNotes,
          hearAudio: solo ? true : hearAudio,
          voiceGender,
          roomType
        })
      );
    };

    ws.onmessage = (rawEvent) => {
      const event = parseEvent((rawEvent as MessageEvent<string>).data);
      if (!event) {
        addDebugEvent("socket.message.invalid");
        return;
      }
      if (event.type === "session.joined") {
        setConnected(true);
        clientIdRef.current = event.clientId;
        setClientId(event.clientId);
        setStatusMessage(S.statusConnected);
        addDebugEvent(`session.joined client=${event.clientId}`);
        if (autoPilotEnabled) {
          clearAutoPilotTimer();
          scheduleAutoPilot();
        }
        return;
      }
      if (event.type === "providers.updated") {
        setProviderStt(event.stt);
        setProviderTranslation(event.translation);
        setProviderTts(event.tts);
        addDebugEvent(
          `providers.updated stt=${event.stt} translation=${event.translation} tts=${event.tts}`
        );
        return;
      }
      if (event.type === "transcript.live") {
        if (event.speakerId !== clientIdRef.current) {
          return;
        }
        setLiveCaption((previous) => {
          if (previous && previous.turnId === event.turnId && event.liveSeq < previous.liveSeq) {
            return previous;
          }
          return {
            turnId: event.turnId,
            speakerId: event.speakerId,
            speakerDisplayName: event.speakerDisplayName,
            translatedText: event.translatedText,
            originalText: event.originalText,
            targetLanguage: event.targetLanguage,
            liveSeq: event.liveSeq,
            timestamp: event.timestamp
          };
        });
        addDebugEvent(
          `transcript.live turn=${event.turnId} seq=${event.liveSeq} target=${event.targetLanguage}`
        );
        return;
      }
      if (event.type === "transcript.chunk") {
        setLiveCaption((previous) => (previous?.turnId === event.turnId ? null : previous));
        setTranscripts((previous) => [
          ...previous,
          {
            turnId: event.turnId,
            speakerId: event.speakerId,
            speakerDisplayName: event.speakerDisplayName,
            translatedText: event.translatedText,
            originalText: event.originalText,
            targetLanguage: event.targetLanguage,
            timestamp: event.timestamp,
            debug: event.debug
          }
        ]);
        requestAnimationFrame(() => {
          const el = threadRef.current;
          if (!el) {
            return;
          }
          if (pinnedToBottomRef.current) {
            el.scrollTop = el.scrollHeight;
            setShowJumpToLatest(false);
          } else if (el.scrollHeight > el.clientHeight + 4) {
            setShowJumpToLatest(true);
          }
        });
        addDebugEvent(
          `transcript.chunk turn=${event.turnId} final=${event.isFinal} stt=${event.debug?.transcriptionPath ?? "n/a"} tx=${event.debug?.translationPath ?? "n/a"} tts=${event.debug?.ttsPath ?? "n/a"}`
        );
        return;
      }
      if (event.type === "transcript.edited") {
        setTranscripts((previous) =>
          previous.map((row) =>
            row.turnId === event.turnId
              ? {
                  ...row,
                  speakerDisplayName: event.speakerDisplayName,
                  originalText: event.originalText,
                  translatedText: event.translatedText,
                  timestamp: event.timestamp,
                  editedAt: event.editedAt
                }
              : row
          )
        );
        requestAnimationFrame(() => {
          const scroller = threadRef.current;
          if (pinnedToBottomRef.current && scroller) {
            scroller.scrollTop = scroller.scrollHeight;
            setShowJumpToLatest(false);
          }
          const row = scroller?.querySelector(`[data-turn-id="${event.turnId}"]`) as HTMLElement | null;
          if (!scroller || !row) {
            updateChatScrollPin();
            return;
          }
          const s = scroller.getBoundingClientRect();
          const r = row.getBoundingClientRect();
          if (r.top < s.top) {
            setHasUnseenEditedAbove(true);
          }
          updateChatScrollPin();
        });
        return;
      }
      if (event.type === "audio.chunk") {
        audioQueueRef.current.push({
          payloadBase64: event.payloadBase64,
          mimeType: event.mimeType,
          isLast: event.isLast,
          targetLanguage: event.targetLanguage
        });
        playQueue();
        addDebugEvent(
          `audio.chunk turn=${event.turnId} lang=${event.targetLanguage} mime=${event.mimeType} last=${event.isLast} tts=${event.debug?.ttsPath ?? "n/a"}`
        );
        return;
      }
      if (event.type === "debug.turn") {
        debugTurnsRef.current = [event, ...debugTurnsRef.current].slice(0, MAX_DEBUG_TURNS);
        const participantSummary = event.participants
          .map((participant) => `${participant.displayName}:${participant.targetLanguage}`)
          .join(",");
        addDebugEvent(
          `debug.turn turn=${event.turnId} stt=${event.transcription.path} participants=${participantSummary}`
        );
        if (event.transcription.sttBenchmark?.length) {
          for (const row of event.transcription.sttBenchmark) {
            addDebugEvent(
              `stt.bench turn=${event.turnId} id=${row.id} ${row.durationMs}ms path=${row.path}${
                row.error ? ` err=${row.error}` : ""
              }`
            );
          }
        }
        return;
      }
      if (event.type === "error") {
        setStatusMessage(event.message);
        addDebugEvent(`server.error message=${event.message}`);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setStatusMessage(S.statusSocketDisconnected);
      addDebugEvent("socket.closed");
      clearAutoPilotTimer();
      autoPilotEnabledRef.current = false;
      setAutoPilotEnabled(false);
      void stopMicTestRef.current({ immediate: true });
    };

    ws.onerror = () => {
      addDebugEvent("socket.error");
    };
  };

  useEffect(() => {
    connectRef.current = connect;
  });

  useEffect(() => {
    const shouldAutoConnect = shouldAutoConnectFromSavedSession({
      displayName,
      connected,
      alreadyAttempted: autoConnectAttemptedRef.current
    });
    if (!shouldAutoConnect) {
      return;
    }
    autoConnectAttemptedRef.current = true;
    addDebugEvent("session.auto_connect.attempt");
    connectRef.current();
  }, [addDebugEvent, connected, displayName]);

  const disconnect = () => {
    clearAutoPilotTimer();
    autoPilotEnabledRef.current = false;
    setAutoPilotEnabled(false);
    void stopMicTest({ immediate: true });
    wsRef.current?.close();
    wsRef.current = null;
  };

  const clearMicStopGraceTimer = () => {
    if (micStopGraceTimerRef.current !== null) {
      window.clearTimeout(micStopGraceTimerRef.current);
      micStopGraceTimerRef.current = null;
    }
  };

  const tearDownMicCapture = async () => {
    const capture = micCaptureRef.current;
    micCaptureRef.current = null;
    if (capture) {
      await capture.stop();
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && micTurnIdRef.current) {
      wsRef.current.send(
        JSON.stringify({
          type: "turn.stop",
          turnId: micTurnIdRef.current
        })
      );
    }

    addDebugEvent(`mic.stop turn=${micTurnIdRef.current ?? "n/a"} live=false`);
    micTurnIdRef.current = null;
    micFinishingRef.current = false;
    setMicFinishing(false);
    setMicTestActive(false);
    setQcSpeaking(null);
  };

  const stopMicTest = async (options?: { immediate?: boolean }) => {
    const immediate = options?.immediate ?? false;

    if (
      !shouldRunMicStop({
        micTestActive,
        micTurnId: micTurnIdRef.current,
        micFinishing: micFinishingRef.current
      })
    ) {
      return;
    }

    if (isMicStopNoOp({ micFinishing: micFinishingRef.current, immediate })) {
      return;
    }

    if (immediate) {
      clearMicStopGraceTimer();
      await tearDownMicCapture();
      return;
    }

    micFinishingRef.current = true;
    setMicFinishing(true);
    addDebugEvent(`mic.stop.requested turn=${micTurnIdRef.current ?? "n/a"}`);
    clearMicStopGraceTimer();
    micStopGraceTimerRef.current = window.setTimeout(() => {
      micStopGraceTimerRef.current = null;
      void tearDownMicCapture();
    }, MIC_STOP_GRACE_MS);
  };

  useEffect(() => {
    stopMicTestRef.current = stopMicTest;
  });

  const startMicTest = async (opts?: {
    sourceLanguage?: SupportedLanguage;
    voiceGender?: VoiceGender;
  }) => {
    if (!connected || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setStatusMessage(S.statusConnectBeforeMic);
      return;
    }
    if (!permissionReady) {
      setStatusMessage(S.micEnableFirst);
      return;
    }
    if (!canStartMicCapture({ micTestActive, micFinishing: micFinishingRef.current })) {
      return;
    }

    try {
      const turnId = createTurnId();
      micTurnIdRef.current = turnId;
      micSequenceRef.current = 0;
      const speakerLanguage = opts?.sourceLanguage ?? language;
      const turnVoiceGender = opts?.voiceGender ?? voiceGender;
      const solo = appModeRef.current === "quickChat";
      const wsForChunks = wsRef.current;

      if (solo && opts?.sourceLanguage) {
        // Show active state during getUserMedia + start warm-up (PCM still gated).
        setQcSpeaking(opts.sourceLanguage);
        setMicTestActive(true);
      }

      const openMic = async () =>
        startMicCapture({
          onPcmChunk: (pcm16) => {
            if (!wsForChunks || wsForChunks.readyState !== WebSocket.OPEN || !micTurnIdRef.current) {
              return;
            }
            wsForChunks.send(
              JSON.stringify({
                type: "audio.input",
                turnId: micTurnIdRef.current,
                payloadBase64: uint8ToBase64(new Uint8Array(pcm16.buffer)),
                sequence: micSequenceRef.current,
                isLast: false
              })
            );
            micSequenceRef.current += 1;
          },
          ...(solo ? { warmupMs: MIC_START_WARMUP_MS } : {})
        });

      // Quick Chat: fully re-acquire + warm up before turn.start so the first word isn't clipped.
      // Room mode: keep prior order (turn.start then capture) — do not change that lifecycle.
      const capture = solo ? await openMic() : null;

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: "turn.start",
            turnId,
            speakerLanguage,
            ...(solo ? { voiceGender: turnVoiceGender } : {})
          })
        );
      }

      const readyCapture = capture ?? (await openMic());
      micCaptureRef.current = readyCapture;
      setMicTestActive(true);
      if (solo && opts?.sourceLanguage) {
        setQcSpeaking(opts.sourceLanguage);
      }
      addDebugEvent(
        `mic.start turn=${turnId} lang=${speakerLanguage} sampleRate=${readyCapture.sampleRate} warmupMs=${solo ? MIC_START_WARMUP_MS : 0} worklet=pcm-capture-processor`
      );
    } catch {
      setStatusMessage(S.statusMicFailed);
      addDebugEvent("mic.start.failed");
      await stopMicTest({ immediate: true });
    }
  };

  const togglePtt = async () => {
    if (micTestActive) {
      await stopMicTest();
    } else {
      await startMicTest();
    }
  };

  const toggleQcSpeak = async (sourceLanguage: SupportedLanguage) => {
    if (!connected) {
      setMenuOpen(true);
      return;
    }
    if (micFinishing) {
      return;
    }
    if (qcSpeaking === sourceLanguage) {
      await stopMicTest();
      return;
    }
    if (micTestActive || qcSpeaking) {
      return;
    }
    // TTS gender for the *target* language = badge on that language's button.
    const targetGender = sourceLanguage === "ja" ? qcGenderEn : qcGenderJa;
    if (!playbackUnlocked) {
      void unlockPlaybackAudio();
    }
    await startMicTest({ sourceLanguage, voiceGender: targetGender });
  };

  const discardSessionAndSwitchMode = async (next: AppMode) => {
    await stopMicTest({ immediate: true });
    autoPilotEnabledRef.current = false;
    setAutoPilotEnabled(false);
    clearAutoPilotTimer();
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
    clientIdRef.current = "";
    setClientId("");
    setTranscripts([]);
    setLiveCaption(null);
    setQcSpeaking(null);
    setMenuOpen(false);
    setAppMode(next);
    setStatusMessage(S.statusNotConnected);
    addDebugEvent(`app.mode=${next}`);
    queueMicrotask(() => {
      connect({ roomType: next === "quickChat" ? "solo" : "family" });
    });
  };

  const submitTurn = () => {
    const sent = sendTurn(textInput, "manual");
    if (sent) {
      setTextInput("");
    }
  };

  const submitEditedTurn = (turnId: string, sourceText: string) => {
    if (!connected || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !sourceText.trim()) {
      return;
    }
    wsRef.current.send(
      JSON.stringify({
        type: "turn.edit",
        turnId,
        sourceText: sourceText.trim()
      })
    );
  };

  const submitTranslatedEdit = (turnId: string, translatedText: string) => {
    if (!connected || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !translatedText.trim()) {
      return;
    }
    wsRef.current.send(
      JSON.stringify({
        type: "turn.edit_translation",
        turnId,
        translatedText: translatedText.trim()
      })
    );
  };

  const saveGlossary = async () => {
    if (!manualTerm.trim() || !manualTranslation.trim()) {
      return;
    }
    const glossaryUserId = getOrCreateGlossaryUserId(getCookie, setCookie);
    const termSaved = manualTerm.trim();
    const response = await fetch(`${HTTP_BASE_URL}/api/glossary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: glossaryUserId,
        term: termSaved,
        translation: manualTranslation.trim(),
        notes: manualNotes.trim()
      })
    });
    if (response.ok) {
      setManualTerm("");
      setManualTranslation("");
      setManualNotes("");
      setStatusMessage(S.statusGlossarySaved);
      addDebugEvent(`glossary.saved term=${termSaved}`);
    }
  };

  const submitCorrection = () => {
    if (!connected || !wsRef.current || !correctionWrong.trim() || !correctionRight.trim()) {
      return;
    }
    wsRef.current.send(
      JSON.stringify({
        type: "correction.submit",
        wrongText: correctionWrong.trim(),
        rightText: correctionRight.trim(),
        context: correctionContext.trim()
      })
    );
    setCorrectionWrong("");
    setCorrectionRight("");
    setCorrectionContext("");
    setStatusMessage(S.statusCorrectionSubmitted);
    addDebugEvent(`correction.submitted wrong=${correctionWrong.trim()}`);
  };

  const saveProviders = () => {
    wsRef.current?.send(
      JSON.stringify({
        type: "settings.providers",
        stt: providerStt,
        translation: providerTranslation,
        tts: providerTts
      })
    );
    addDebugEvent(`providers.sent stt=${providerStt} translation=${providerTranslation} tts=${providerTts}`);
  };

  const toggleAutoPilot = () => {
    if (!connected) {
      setStatusMessage(S.statusConnectForAutopilot);
      return;
    }
    if (autoPilotEnabled) {
      setAutoPilotEnabled(false);
      autoPilotEnabledRef.current = false;
      clearAutoPilotTimer();
      addDebugEvent("autopilot.disabled");
      return;
    }
    setAutoPilotEnabled(true);
    autoPilotEnabledRef.current = true;
    addDebugEvent("autopilot.enabled");
    clearAutoPilotTimer();
    const sent = sendTurn(randomAutoMessage(language), "autopilot");
    if (sent) {
      setAutoPilotRuns((previous) => previous + 1);
    }
    scheduleAutoPilot();
  };

  const copyDebugBlob = async () => {
    const payload = {
      capturedAt: new Date().toISOString(),
      app: {
        connected,
        networkOnline,
        statusMessage,
        clientId,
        displayName,
        language,
        hearAudio,
        voiceGender,
        autoPilotEnabled,
        autoPilotRuns,
        nextAutoDelaySeconds,
        transcriptCount: transcripts.length,
        liveCaption,
        providers: {
          stt: providerStt,
          translation: providerTranslation,
          tts: providerTts
        }
      },
      environment: {
        userAgent: navigator.userAgent,
        href: window.location.href,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        }
      },
      recentTranscriptSample: transcripts.slice(-5).map((item) => ({
        timestamp: item.timestamp,
        turnId: item.turnId,
        translatedText: item.translatedText,
        originalText: item.originalText,
        debug: item.debug
      })),
      recentDebugTurns: debugTurnsRef.current.slice(0, 20),
      recentEvents: debugEventsRef.current
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setStatusMessage(S.statusDebugCopied);
      addDebugEvent("debug.copied");
    } catch {
      setStatusMessage(S.statusDebugCopyFailed);
      addDebugEvent("debug.copy.failed");
    }
  };

  const orderedMessages = useMemo(
    () => [...transcripts].sort((a, b) => messageSortKey(a) - messageSortKey(b)),
    [transcripts]
  );

  const timeLocale = language === "ja" ? "ja-JP" : "en-US";

  if (!onboardingDone) {
    const lineEn = appStrings("en").onboardingLangLineEn;
    const lineJa = appStrings("ja").onboardingLangLineJa;
    const pick = appStrings(language);
    return (
      <main className="layout onboardingLayout">
        <div className="panel onboardingCard">
          {onboardingStep === 0 ? (
            <>
              <p className="onboardingLead">{lineEn}</p>
              <p className="onboardingLeadJa">{lineJa}</p>
              <div className="onboardingActions">
                <button
                  type="button"
                  className="onboardingPrimary"
                  onClick={() => {
                    setLanguage("en");
                    setOnboardingStep(1);
                  }}
                >
                  {appStrings("en").onboardingPickEnglish}
                </button>
                <button
                  type="button"
                  className="onboardingPrimary"
                  onClick={() => {
                    setLanguage("ja");
                    setOnboardingStep(1);
                  }}
                >
                  {appStrings("ja").onboardingPickJapanese}
                </button>
              </div>
            </>
          ) : null}
          {onboardingStep === 1 ? (
            <>
              <p className="onboardingPrompt">
                {language === "en" ? pick.onboardingUnderstandPromptFromEn : pick.onboardingUnderstandPromptFromJa}
              </p>
              <div className="onboardingActions">
                <button
                  type="button"
                  className="onboardingPrimary"
                  onClick={() => {
                    setHearAudio(false);
                    setOnboardingStep(2);
                  }}
                >
                  {pick.onboardingUnderstandYes}
                </button>
                <button
                  type="button"
                  className="onboardingPrimary"
                  onClick={() => {
                    setHearAudio(true);
                    setOnboardingStep(2);
                  }}
                >
                  {pick.onboardingUnderstandNo}
                </button>
              </div>
              <button type="button" className="onboardingBackButton" onClick={() => setOnboardingStep(0)}>
                {pick.onboardingBack}
              </button>
            </>
          ) : null}
          {onboardingStep === 2 ? (
            <>
              <p className="onboardingPrompt">{pick.onboardingVoicePrompt}</p>
              <div className="onboardingActions">
                <button
                  type="button"
                  className="onboardingPrimary"
                  onClick={() => {
                    setVoiceGender("male");
                    setOnboardingStep(3);
                  }}
                >
                  {pick.onboardingVoiceMale}
                </button>
                <button
                  type="button"
                  className="onboardingPrimary"
                  onClick={() => {
                    setVoiceGender("female");
                    setOnboardingStep(3);
                  }}
                >
                  {pick.onboardingVoiceFemale}
                </button>
              </div>
              <button type="button" className="onboardingBackButton" onClick={() => setOnboardingStep(1)}>
                {pick.onboardingBack}
              </button>
            </>
          ) : null}
          {onboardingStep === 3 ? (
            <>
              <p className="onboardingPrompt">{pick.onboardingNamePrompt}</p>
              <label className="onboardingNameField">
                <input
                  value={onboardingNameDraft}
                  onChange={(event) => {
                    setOnboardingNameDraft(event.target.value);
                    if (onboardingError) {
                      setOnboardingError("");
                    }
                  }}
                  placeholder={pick.onboardingNamePlaceholder}
                  autoComplete="name"
                />
              </label>
              {onboardingError ? <p className="onboardingError">{onboardingError}</p> : null}
              <div className="onboardingActions">
                <button type="button" className="onboardingPrimary" onClick={() => void completeOnboardingWithName()}>
                  {pick.onboardingContinue}
                </button>
              </div>
              <button
                type="button"
                className="onboardingBackButton"
                onClick={() => {
                  setOnboardingError("");
                  setOnboardingStep(2);
                }}
              >
                {pick.onboardingBack}
              </button>
            </>
          ) : null}
        </div>
      </main>
    );
  }

  if (appMode === "quickChat") {
    const jaRecording = qcSpeaking === "ja" && (micTestActive || micFinishing);
    const enRecording = qcSpeaking === "en" && (micTestActive || micFinishing);
    const jaDisabled = Boolean(qcSpeaking && qcSpeaking !== "ja") || micFinishing;
    const enDisabled = Boolean(qcSpeaking && qcSpeaking !== "en") || micFinishing;

    return (
      <main className="coreShell quickChatShell">
        <header className="coreHeader">
          <div className="coreStatusWrap">
            {connected ? (
              <span className="coreStatusOnline">{S.online}</span>
            ) : (
              <button
                type="button"
                className="coreStatusReconnect"
                onClick={() => connect({ roomType: "solo" })}
              >
                {S.reconnect}
              </button>
            )}
          </div>
          <div className="coreHeaderMain">
            <span className="coreBrand">{S.quickChatTitle}</span>
            <span className="coreUserName">{displayName.trim() || "—"}</span>
          </div>
          <button
            type="button"
            className="coreHamburger"
            onClick={() => setMenuOpen(true)}
            aria-label={S.menuAria}
          >
            <span className="coreHamburgerBars" aria-hidden>
              <span className="coreHamburgerBar" />
              <span className="coreHamburgerBar" />
              <span className="coreHamburgerBar" />
            </span>
          </button>
        </header>

        {!permissionReady ? (
          <div className="permissionPrompt">
            <p className="permissionPromptTitle">{S.micWarmupTitle}</p>
            <p className="permissionPromptBody">{S.micWarmupBody}</p>
            <button type="button" onClick={() => void runPermissionWarmup()}>
              {S.micWarmupAction}
            </button>
          </div>
        ) : null}

        <section className="quickChatTalk" aria-label={S.quickChatTitle}>
          <div
            className={`qcLangBtn ${
              !connected
                ? "qcLangBtnDisabled"
                : jaDisabled
                  ? "qcLangBtnLocked"
                  : jaRecording
                    ? micFinishing
                      ? "qcLangBtnFinishing"
                      : "qcLangBtnRecording"
                    : "qcLangBtnIdle"
            }`}
            role="button"
            tabIndex={connected && !jaDisabled ? 0 : -1}
            onClick={() => {
              if (jaDisabled && qcSpeaking !== "ja") {
                return;
              }
              void toggleQcSpeak("ja");
            }}
            onKeyDown={(event) => {
              if (jaDisabled && qcSpeaking !== "ja") {
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void toggleQcSpeak("ja");
              }
            }}
          >
            <button
              type="button"
              className="qcGenderBadge"
              aria-label={S.quickChatGenderForJa}
              title={S.quickChatGenderForJa}
              onClick={(event) => {
                event.stopPropagation();
                setQcGenderJa((g) => (g === "female" ? "male" : "female"));
              }}
            >
              {qcGenderJa === "female" ? "♀" : "♂"}
            </button>
            <p className="qcLangLabel">日本語で話す</p>
            {jaRecording && liveCaption ? (
              <p className="pttLiveDraft" aria-live="polite">
                {liveCaption.translatedText}
              </p>
            ) : null}
          </div>

          <div
            className={`qcLangBtn ${
              !connected
                ? "qcLangBtnDisabled"
                : enDisabled
                  ? "qcLangBtnLocked"
                  : enRecording
                    ? micFinishing
                      ? "qcLangBtnFinishing"
                      : "qcLangBtnRecording"
                    : "qcLangBtnIdle"
            }`}
            role="button"
            tabIndex={connected && !enDisabled ? 0 : -1}
            onClick={() => {
              if (enDisabled && qcSpeaking !== "en") {
                return;
              }
              void toggleQcSpeak("en");
            }}
            onKeyDown={(event) => {
              if (enDisabled && qcSpeaking !== "en") {
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void toggleQcSpeak("en");
              }
            }}
          >
            <button
              type="button"
              className="qcGenderBadge"
              aria-label={S.quickChatGenderForEn}
              title={S.quickChatGenderForEn}
              onClick={(event) => {
                event.stopPropagation();
                setQcGenderEn((g) => (g === "female" ? "male" : "female"));
              }}
            >
              {qcGenderEn === "female" ? "♀" : "♂"}
            </button>
            <p className="qcLangLabel">Speak English</p>
            {enRecording && liveCaption ? (
              <p className="pttLiveDraft" aria-live="polite">
                {liveCaption.translatedText}
              </p>
            ) : null}
          </div>
        </section>

        <section className="quickChatTranscript" aria-label={S.chatConversation}>
          {qcPlaybackDebug ? (
            <p className="qcAudioDebug" aria-live="polite">
              {qcPlaybackDebug}
            </p>
          ) : null}
          <div
            className="coreChatScroller quickChatScroller"
            ref={threadRef}
            onScroll={() => updateChatScrollPin()}
          >
            <ul className="chatMessageList">
              {orderedMessages.map((item) => (
                <ChatMessageRow
                  key={`qc-${item.turnId}-${item.timestamp}`}
                  item={item}
                  showOriginalLabel={S.showOriginal}
                  hideOriginalLabel={S.hideOriginal}
                  timeLocale={timeLocale}
                  canEditSource={false}
                  canEditTranslation={false}
                  onSubmitSourceEdit={submitEditedTurn}
                  onSubmitTranslationEdit={submitTranslatedEdit}
                  editMessageLabel={S.editMessage}
                  editTranslationLabel={S.editTranslation}
                  saveEditLabel={S.saveEdit}
                  cancelEditLabel={S.cancelEdit}
                  editedLabel={S.editedMessage}
                  alwaysShowOriginal
                  hideSpeakerMeta
                />
              ))}
            </ul>
          </div>
        </section>

        {menuOpen ? (
          <button
            type="button"
            className="drawerBackdrop"
            aria-label={S.drawerClose}
            onClick={() => setMenuOpen(false)}
          />
        ) : null}

        {menuOpen ? (
          <aside className="settingsDrawer">
            <div className="settingsDrawerInner panel">
              <div className="drawerHeader">
                <h2 className="drawerTitle">{S.drawerTitle}</h2>
                <button type="button" className="drawerCloseBtn" onClick={() => setMenuOpen(false)}>
                  {S.drawerClose}
                </button>
              </div>
              <div className="drawerScroll">
                <button
                  type="button"
                  className="modeSwitchBtn"
                  onClick={() => void discardSessionAndSwitchMode("rooms")}
                >
                  Rooms
                </button>
                <p className={`drawerNet ${networkOnline ? "ok" : "warn"}`}>
                  {networkOnline ? S.online : S.offline}
                </p>
                <div className="drawerToolbar">
                  <button type="button" onClick={copyDebugBlob}>
                    {S.copyDebugBlob}
                  </button>
                  {!playbackUnlocked ? (
                    <AudioUnlockButton
                      onClick={() => void unlockPlaybackAudio()}
                      label={S.enableAudioPlayback}
                    />
                  ) : null}
                </div>
                <div className="drawerSection actions">
                  <button type="button" onClick={() => connect({ roomType: "solo" })}>
                    {S.connect}
                  </button>
                  <button type="button" onClick={disconnect}>
                    {S.disconnect}
                  </button>
                </div>
                <p className="drawerStatus">{statusMessage}</p>
              </div>
            </div>
          </aside>
        ) : null}
      </main>
    );
  }

  return (
    <main className="coreShell">
      <header className="coreHeader">
        <div className="coreStatusWrap">
          {connected ? (
            <span className="coreStatusOnline">{S.online}</span>
          ) : (
            <button type="button" className="coreStatusReconnect" onClick={() => connect()}>
              {S.reconnect}
            </button>
          )}
        </div>
        <div className="coreHeaderMain">
          <span className="coreBrand">Family Translation</span>
          <span className="coreUserName">{displayName.trim() || "—"}</span>
        </div>
        <button
          type="button"
          className="coreHamburger"
          onClick={() => setMenuOpen(true)}
          aria-label={S.menuAria}
        >
          <span className="coreHamburgerBars" aria-hidden>
            <span className="coreHamburgerBar" />
            <span className="coreHamburgerBar" />
            <span className="coreHamburgerBar" />
          </span>
        </button>
      </header>

      <section className="coreChatWrap" aria-label={S.chatConversation}>
        {!permissionReady ? (
          <div className="permissionPrompt">
            <p className="permissionPromptTitle">{S.micWarmupTitle}</p>
            <p className="permissionPromptBody">{S.micWarmupBody}</p>
            <button type="button" onClick={() => void runPermissionWarmup()}>
              {S.micWarmupAction}
            </button>
          </div>
        ) : null}
        <div
          className="coreChatScroller"
          ref={threadRef}
          onScroll={() => {
            const el = threadRef.current;
            if (el && el.scrollTop < 24) {
              setHasUnseenEditedAbove(false);
            }
            updateChatScrollPin();
          }}
        >
          {hasUnseenEditedAbove ? (
            <button type="button" className="chatEditedGlow" onClick={() => setHasUnseenEditedAbove(false)}>
              {S.unseenEditsAbove}
            </button>
          ) : null}
          <div ref={topSentinelRef} className="chatTopSentinel" aria-hidden />
          {loadingOlder ? <p className="chatLoadBanner">{S.loadingOlder}</p> : null}
          {historyLoading ? <p className="chatLoadBanner">{S.loadingHistory}</p> : null}
          <ul className="chatMessageList">
            {orderedMessages.map((item) => (
              <ChatMessageRow
                key={item.historyId != null ? `h-${item.historyId}` : `ws-${item.turnId}-${item.timestamp}`}
                item={item}
                showOriginalLabel={S.showOriginal}
                hideOriginalLabel={S.hideOriginal}
                timeLocale={timeLocale}
                canEditSource={item.speakerId === clientId}
                canEditTranslation={!hearAudio}
                onSubmitSourceEdit={submitEditedTurn}
                onSubmitTranslationEdit={submitTranslatedEdit}
                editMessageLabel={S.editMessage}
                editTranslationLabel={S.editTranslation}
                saveEditLabel={S.saveEdit}
                cancelEditLabel={S.cancelEdit}
                editedLabel={S.editedMessage}
              />
            ))}
          </ul>
          {showJumpToLatest ? (
            <button
              type="button"
              className="chatJumpToLatest"
              onClick={() => {
                const el = threadRef.current;
                if (!el) {
                  return;
                }
                el.scrollTop = el.scrollHeight;
                pinnedToBottomRef.current = true;
                setShowJumpToLatest(false);
              }}
            >
              {S.jumpToLatest}
            </button>
          ) : null}
        </div>
      </section>

      <div
        className={`pttDock ${!connected ? "pttDockDisabled" : micFinishing ? "pttDockFinishing" : micTestActive ? "pttDockRecording" : "pttDockIdle"}`}
        role="button"
        tabIndex={connected && !micFinishing ? 0 : -1}
        onClick={() => {
          if (!connected) {
            setMenuOpen(true);
            return;
          }
          if (micFinishing) {
            return;
          }
          void togglePtt();
        }}
        onKeyDown={(event) => {
          if (!connected || micFinishing) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void togglePtt();
          }
        }}
      >
        <p className="pttMainLabel">
          {!connected ? S.pttDisabled : micFinishing ? S.pttFinishing : micTestActive ? S.pttRecording : S.pttReady}
        </p>
        {liveCaption && micTestActive ? (
          <p className="pttLiveDraft" aria-live="polite">
            {liveCaption.translatedText}
          </p>
        ) : null}
      </div>

      {menuOpen ? (
        <button
          type="button"
          className="drawerBackdrop"
          aria-label={S.drawerClose}
          onClick={() => setMenuOpen(false)}
        />
      ) : null}

      {menuOpen ? (
        <aside className="settingsDrawer">
          <div className="settingsDrawerInner panel">
            <div className="drawerHeader">
              <h2 className="drawerTitle">{S.drawerTitle}</h2>
              <button type="button" className="drawerCloseBtn" onClick={() => setMenuOpen(false)}>
                {S.drawerClose}
              </button>
            </div>
            <div className="drawerScroll">
              <button
                type="button"
                className="modeSwitchBtn"
                onClick={() =>
                  void discardSessionAndSwitchMode(appMode === "rooms" ? "quickChat" : "rooms")
                }
              >
                {appMode === "rooms" ? "Quick Chat" : "Rooms"}
              </button>
              <p className={`drawerNet ${networkOnline ? "ok" : "warn"}`}>
                {networkOnline ? S.online : S.offline}
              </p>
              <div className="drawerToolbar">
                <button type="button" onClick={copyDebugBlob}>
                  {S.copyDebugBlob}
                </button>
                {!playbackUnlocked ? (
                  <AudioUnlockButton onClick={() => void unlockPlaybackAudio()} label={S.enableAudioPlayback} />
                ) : null}
              </div>

              <div className="drawerSection grid2">
                <label>
                  {S.displayNameLabel}
                  <input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder={S.displayNamePlaceholder}
                  />
                </label>
                <label>
                  {S.languageLabel}
                  <select
                    value={language}
                    onChange={(event) => setLanguage(event.target.value as SupportedLanguage)}
                  >
                    <option value="en">{S.langEnglish}</option>
                    <option value="ja">{S.langJapanese}</option>
                  </select>
                </label>
                <label>
                  {S.hearTtsLabel}
                  <input
                    type="checkbox"
                    checked={hearAudio}
                    onChange={(event) => setHearAudio(event.target.checked)}
                  />
                </label>
                <fieldset className="voiceGenderField">
                  <legend>{S.voiceGenderLabel}</legend>
                  <label>
                    <input
                      type="radio"
                      name="voiceGender"
                      value="male"
                      checked={voiceGender === "male"}
                      onChange={() => setVoiceGender("male")}
                    />
                    {S.voiceGenderMale}
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="voiceGender"
                      value="female"
                      checked={voiceGender === "female"}
                      onChange={() => setVoiceGender("female")}
                    />
                    {S.voiceGenderFemale}
                  </label>
                </fieldset>
                <label className="full">
                  {S.contextNotesLabel}
                  <textarea
                    value={contextNotes}
                    onChange={(event) => setContextNotes(event.target.value)}
                    rows={2}
                  />
                </label>
                <div className="actions full">
                  <button type="button" onClick={() => connect()} disabled={connected}>
                    {S.connect}
                  </button>
                  <button type="button" onClick={disconnect}>
                    {S.disconnect}
                  </button>
                </div>
                <p className="full drawerStatus">{statusMessage}</p>
              </div>

              <section className="drawerSection">
                <h3>{S.liveSpeechHeading}</h3>
                <div className="actions">
                  <input
                    value={textInput}
                    onChange={(event) => setTextInput(event.target.value)}
                    placeholder={S.saySomethingPlaceholder}
                    className="grow"
                  />
                  <button type="button" onClick={submitTurn} disabled={!connected || !textInput.trim()}>
                    {S.sendUtterance}
                  </button>
                  <button type="button" onClick={toggleAutoPilot} disabled={!connected}>
                    {autoPilotEnabled ? S.stopSimulator : S.startSimulator}
                  </button>
                </div>
                <p className="liveMetaLine">
                  {S.messagesSent}: {autoPilotRuns}
                </p>
              </section>

              <section className="drawerSection grid2">
                <div>
                  <h3>{S.glossaryHeading}</h3>
                  <label>
                    {S.termLabel}
                    <input value={manualTerm} onChange={(event) => setManualTerm(event.target.value)} />
                  </label>
                  <label>
                    {S.translationLabel}
                    <input
                      value={manualTranslation}
                      onChange={(event) => setManualTranslation(event.target.value)}
                    />
                  </label>
                  <label>
                    {S.notesLabel}
                    <input value={manualNotes} onChange={(event) => setManualNotes(event.target.value)} />
                  </label>
                  <button
                    type="button"
                    onClick={saveGlossary}
                    disabled={!manualTerm.trim() || !manualTranslation.trim()}
                  >
                    {S.saveGlossary}
                  </button>
                </div>
                <div>
                  <h3>{S.correctionHeading}</h3>
                  <label>
                    {S.wrongOutputLabel}
                    <input value={correctionWrong} onChange={(event) => setCorrectionWrong(event.target.value)} />
                  </label>
                  <label>
                    {S.correctOutputLabel}
                    <input value={correctionRight} onChange={(event) => setCorrectionRight(event.target.value)} />
                  </label>
                  <label>
                    {S.contextLabel}
                    <input
                      value={correctionContext}
                      onChange={(event) => setCorrectionContext(event.target.value)}
                    />
                  </label>
                  <button type="button" onClick={submitCorrection} disabled={!connected}>
                    {S.submitCorrection}
                  </button>
                </div>
              </section>

              <section className="drawerSection grid3">
                <h3 className="full">{S.providerHeading}</h3>
                <label>
                  {S.sttLabel}
                  <select value={providerStt} onChange={(event) => setProviderStt(event.target.value as ProviderType)}>
                    <option value="deepgram">Deepgram</option>
                    <option value="openai">OpenAI</option>
                  </select>
                </label>
                <label>
                  {S.translationProviderLabel}
                  <select
                    value={providerTranslation}
                    onChange={(event) => setProviderTranslation(event.target.value as ProviderType)}
                  >
                    <option value="gemini">Gemini</option>
                    <option value="openai">OpenAI</option>
                  </select>
                </label>
                <label>
                  {S.ttsProviderLabel}
                  <select value={providerTts} onChange={(event) => setProviderTts(event.target.value as ProviderType)}>
                    <option value="cartesia">Cartesia</option>
                    <option value="openai">OpenAI</option>
                  </select>
                </label>
                <div className="actions full">
                  <button type="button" onClick={saveProviders} disabled={!connected}>
                    {S.applyProviders}
                  </button>
                </div>
              </section>

              <section className="drawerSection">
                <h3>{S.iphoneChecklistHeading}</h3>
                <ul>
                  <li>{S.iphoneChecklist1}</li>
                  <li>{S.iphoneChecklist2}</li>
                  <li>{S.iphoneChecklist3}</li>
                </ul>
              </section>
            </div>
          </div>
        </aside>
      ) : null}
    </main>
  );
}

export default App;
