import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProviderType, ServerEvent, SupportedLanguage } from "@family-translation/shared";

import "./App.css";
import { appStrings } from "./lib/app-strings";
import { audioPayloadToObjectUrl } from "./lib/audio-playback";
import { parseEvent } from "./lib/parse-event";
import {
  getOrCreateGlossaryUserId,
  ONBOARDING_DONE_COOKIE,
  shouldAutoConnectFromSavedSession
} from "./lib/session-ui";

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
  timestamp: m.createdAt
});

const messageSortKey = (row: TranscriptRow) => row.timestamp;

function ChatMessageRow({
  item,
  showOriginalLabel,
  hideOriginalLabel,
  timeLocale
}: {
  item: TranscriptRow;
  showOriginalLabel: string;
  hideOriginalLabel: string;
  timeLocale: string;
}) {
  const [metaOpen, setMetaOpen] = useState(false);
  const hasOriginal =
    item.originalText.trim().length > 0 && item.originalText.trim() !== item.translatedText.trim();
  return (
    <li className="chatMessage">
      <div className="chatMeta">
        <span className="chatSpeaker">{item.speakerDisplayName}</span>
        <time className="chatTime" dateTime={new Date(item.timestamp).toISOString()}>
          {new Date(item.timestamp).toLocaleString(timeLocale)}
        </time>
      </div>
      <p className="chatBubbleMain">{item.translatedText}</p>
      {hasOriginal ? (
        <div className="chatOriginalWrap">
          <button
            type="button"
            className="chatToggleOriginal"
            onClick={() => setMetaOpen((open) => !open)}
            aria-expanded={metaOpen}
          >
            {metaOpen ? hideOriginalLabel : showOriginalLabel}
          </button>
          {metaOpen ? <p className="chatBubbleOriginal">{item.originalText}</p> : null}
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
const MIC_WARMUP_DONE_COOKIE = "family_translation_mic_warmup_done";

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

const cookieProviderStt = getCookie("family_translation_provider_stt");
const initialProviderStt: ProviderType = cookieProviderStt === "openai" ? "openai" : "deepgram";

const cookieProviderTranslation = getCookie("family_translation_provider_translation");
const initialProviderTranslation: ProviderType = cookieProviderTranslation === "openai" ? "openai" : "gemini";

const cookieProviderTts = getCookie("family_translation_provider_tts");
const initialProviderTts: ProviderType = cookieProviderTts === "openai" ? "openai" : "cartesia";

const downsampleTo16k = (input: Float32Array, inputSampleRate: number): Float32Array => {
  if (inputSampleRate === 16000) {
    return input;
  }
  const ratio = inputSampleRate / 16000;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);
  let outputIndex = 0;
  let inputIndex = 0;

  while (outputIndex < outputLength) {
    const nextInputIndex = Math.round((outputIndex + 1) * ratio);
    let accumulator = 0;
    let count = 0;
    for (let index = inputIndex; index < nextInputIndex && index < input.length; index += 1) {
      accumulator += input[index];
      count += 1;
    }
    output[outputIndex] = count > 0 ? accumulator / count : 0;
    outputIndex += 1;
    inputIndex = nextInputIndex;
  }

  return output;
};

const floatToPcm16 = (input: Float32Array): Int16Array => {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
};

const uint8ToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

function App() {
  const wsRef = useRef<WebSocket | null>(null);
  const audioQueueRef = useRef<Array<{ payloadBase64: string; mimeType: "audio/pcm" | "audio/wav"; isLast: boolean }>>([]);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const sharedPlaybackBlobUrlRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  const autopilotTimeoutRef = useRef<number | null>(null);
  const autoPilotEnabledRef = useRef(false);
  const debugEventsRef = useRef<string[]>([]);
  const debugTurnsRef = useRef<DebugTurnRow[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micAudioContextRef = useRef<AudioContext | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const micTurnIdRef = useRef<string | null>(null);
  const micSequenceRef = useRef(0);
  const autoConnectAttemptedRef = useRef(false);
  const connectRef = useRef<() => void>(() => undefined);
  const stopMicTestRef = useRef<() => Promise<void>>(async () => {});
  const onboardingDoneInit = getCookie(ONBOARDING_DONE_COOKIE) === "true";
  const [onboardingDone, setOnboardingDone] = useState(onboardingDoneInit);
  const [onboardingStep, setOnboardingStep] = useState<0 | 1 | 2>(0);
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [playbackUnlocked, setPlaybackUnlocked] = useState(false);
  const [permissionReady, setPermissionReady] = useState(() => getCookie(MIC_WARMUP_DONE_COOKIE) === "true");
  const threadRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingOlderRef = useRef(false);

  const addDebugEvent = (message: string) => {
    const entry = `${new Date().toISOString()} ${message}`;
    debugEventsRef.current = [entry, ...debugEventsRef.current].slice(0, MAX_DEBUG_EVENTS);
  };

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

  const unlockPlaybackAudio = async () => {
    if (playbackUnlocked && playbackAudioRef.current) {
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

      setPlaybackUnlocked(true);
      addDebugEvent("audio.unlock.ok");
    } catch {
      addDebugEvent("audio.unlock.failed");
    }
  };

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
    if (!onboardingDone) {
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
  }, [onboardingDone, language]);

  useEffect(() => {
    if (historyLoading || !onboardingDone) {
      return;
    }
    const el = threadRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [historyLoading, onboardingDone, language]);

  const loadOlderHistory = useCallback(async () => {
    if (!onboardingDone || !historyHasMore || loadingOlderRef.current) {
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
      });
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [historyHasMore, language, onboardingDone, transcripts]);

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
      setCookie(MIC_WARMUP_DONE_COOKIE, "true");
      setPermissionReady(true);
      addDebugEvent("permissions.warmup.ok");
    } catch {
      addDebugEvent("permissions.warmup.failed");
    }
  }, [unlockPlaybackAudio]);

  useEffect(() => {
    if (!onboardingDone || permissionReady) {
      return;
    }
    const id = window.setTimeout(() => {
      void runPermissionWarmup();
    }, 0);
    return () => window.clearTimeout(id);
  }, [onboardingDone, permissionReady, runPermissionWarmup]);

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

  const connect = () => {
    if (!displayName.trim()) {
      setStatusMessage(S.statusSetNameFirst);
      return;
    }
    wsRef.current?.close();
    const ws = new WebSocket(WS_BASE_URL);
    wsRef.current = ws;
    addDebugEvent(`socket.connecting lang=${language}`);

    ws.onopen = () => {
      setStatusMessage(S.statusSocketConnected);
      addDebugEvent("socket.open");
      ws.send(
        JSON.stringify({
          type: "session.join",
          displayName,
          language,
          mode: "text_only",
          contextNotes,
          hearAudio
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
          if (el) {
            el.scrollTop = el.scrollHeight;
          }
        });
        addDebugEvent(
          `transcript.chunk turn=${event.turnId} final=${event.isFinal} stt=${event.debug?.transcriptionPath ?? "n/a"} tx=${event.debug?.translationPath ?? "n/a"} tts=${event.debug?.ttsPath ?? "n/a"}`
        );
        return;
      }
      if (event.type === "audio.chunk") {
        audioQueueRef.current.push({
          payloadBase64: event.payloadBase64,
          mimeType: event.mimeType,
          isLast: event.isLast
        });
        playQueue();
        addDebugEvent(`audio.chunk turn=${event.turnId} mime=${event.mimeType} last=${event.isLast}`);
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
      void stopMicTestRef.current();
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
  }, [connected, displayName]);

  const disconnect = () => {
    clearAutoPilotTimer();
    autoPilotEnabledRef.current = false;
    setAutoPilotEnabled(false);
    void stopMicTest();
    wsRef.current?.close();
    wsRef.current = null;
  };

  const stopMicTest = async () => {
    if (!micTestActive && !micTurnIdRef.current) {
      return;
    }

    micProcessorRef.current?.disconnect();
    micSourceRef.current?.disconnect();
    micProcessorRef.current = null;
    micSourceRef.current = null;

    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;

    if (micAudioContextRef.current) {
      await micAudioContextRef.current.close();
      micAudioContextRef.current = null;
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && micTurnIdRef.current) {
      wsRef.current.send(
        JSON.stringify({
          type: "turn.stop",
          turnId: micTurnIdRef.current
        })
      );
    }

    addDebugEvent(`mic.stop turn=${micTurnIdRef.current ?? "n/a"}`);
    micTurnIdRef.current = null;
    setMicTestActive(false);
  };

  useEffect(() => {
    stopMicTestRef.current = stopMicTest;
  });

  const startMicTest = async () => {
    if (!connected || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setStatusMessage(S.statusConnectBeforeMic);
      return;
    }
    if (micTestActive) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      const turnId = createTurnId();
      micTurnIdRef.current = turnId;
      micSequenceRef.current = 0;

      wsRef.current.send(
        JSON.stringify({
          type: "turn.start",
          turnId,
          speakerLanguage: language
        })
      );

      processor.onaudioprocess = (event) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !micTurnIdRef.current) {
          return;
        }
        const input = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleTo16k(input, audioContext.sampleRate);
        const pcm16 = floatToPcm16(downsampled);
        const payloadBase64 = uint8ToBase64(new Uint8Array(pcm16.buffer));

        wsRef.current.send(
          JSON.stringify({
            type: "audio.input",
            turnId: micTurnIdRef.current,
            payloadBase64,
            sequence: micSequenceRef.current,
            isLast: false
          })
        );
        micSequenceRef.current += 1;
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      micStreamRef.current = stream;
      micAudioContextRef.current = audioContext;
      micSourceRef.current = source;
      micProcessorRef.current = processor;
      setMicTestActive(true);
      addDebugEvent(`mic.start turn=${turnId} sampleRate=${audioContext.sampleRate}`);
    } catch {
      setStatusMessage(S.statusMicFailed);
      addDebugEvent("mic.start.failed");
      await stopMicTest();
    }
  };

  const togglePtt = async () => {
    if (micTestActive) {
      await stopMicTest();
    } else {
      await startMicTest();
    }
  };

  const submitTurn = () => {
    const sent = sendTurn(textInput, "manual");
    if (sent) {
      setTextInput("");
    }
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
      recentTranscriptSample: transcripts.slice(0, 5).map((item) => ({
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
                  setOnboardingStep(1);
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

  return (
    <main className="coreShell">
      <header className="coreHeader">
        <div className="coreStatusWrap">
          {connected ? (
            <span className="coreStatusOnline">{S.online}</span>
          ) : (
            <button type="button" className="coreStatusReconnect" onClick={connect}>
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
        <div className="coreChatScroller" ref={threadRef}>
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
              />
            ))}
          </ul>
        </div>
      </section>

      <div
        className={`pttDock ${!connected ? "pttDockDisabled" : ""} ${micTestActive ? "pttDockRecording" : "pttDockIdle"}`}
        role="button"
        tabIndex={connected ? 0 : -1}
        onClick={() => {
          if (!connected) {
            setMenuOpen(true);
            return;
          }
          void togglePtt();
        }}
        onKeyDown={(event) => {
          if (!connected) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void togglePtt();
          }
        }}
      >
        <p className="pttMainLabel">
          {!connected ? S.pttDisabled : micTestActive ? S.pttRecording : S.pttReady}
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
                <label className="full">
                  {S.contextNotesLabel}
                  <textarea
                    value={contextNotes}
                    onChange={(event) => setContextNotes(event.target.value)}
                    rows={2}
                  />
                </label>
                <div className="actions full">
                  <button type="button" onClick={connect} disabled={connected}>
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
