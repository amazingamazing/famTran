import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderType, ServerEvent, SupportedLanguage } from "@family-translation/shared";

import "./App.css";
import { parseEvent } from "./lib/parse-event";

type TranscriptRow = {
  turnId: string;
  speakerId: string;
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

type DebugTurnRow = Extract<ServerEvent, { type: "debug.turn" }>;

const WS_BASE_URL =
  window.location.hostname === "localhost"
    ? "ws://localhost:8787"
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;

const HTTP_BASE_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:8787"
    : `${window.location.protocol}//${window.location.host}`;

const createTurnId = () => `turn-${crypto.randomUUID()}`;

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

const cookieLanguage = getCookie("family_translation_language");
const initialLanguage: SupportedLanguage = cookieLanguage === "ja" ? "ja" : "en";

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
  const audioQueueRef = useRef<Array<{ payloadBase64: string; isLast: boolean }>>([]);
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
  const [roomId, setRoomId] = useState(() => getCookie("family_translation_room_id"));
  const [displayName, setDisplayName] = useState(() => getCookie("family_translation_display_name"));
  const [language, setLanguage] = useState<SupportedLanguage>(initialLanguage);
  const [contextNotes, setContextNotes] = useState(() => getCookie("family_translation_context_notes"));
  const [hearAudio, setHearAudio] = useState(() => getCookieBoolean("family_translation_hear_audio", true));
  const [connected, setConnected] = useState(false);
  const [clientId, setClientId] = useState("");
  const [textInput, setTextInput] = useState("");
  const [transcripts, setTranscripts] = useState<TranscriptRow[]>([]);
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
  const [statusMessage, setStatusMessage] = useState("Not connected");
  const [autoPilotEnabled, setAutoPilotEnabled] = useState(false);
  const [autoPilotRuns, setAutoPilotRuns] = useState(0);
  const [nextAutoDelaySeconds, setNextAutoDelaySeconds] = useState<number | null>(null);
  const [micTestActive, setMicTestActive] = useState(false);

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
    const content = atob(next.payloadBase64);
    const duration = Math.min(Math.max(content.length * 0.02, 0.08), 1.2);
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = 240;
    gain.gain.value = 0.03;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + duration);
    oscillator.onended = () => {
      if (next.isLast) {
        const ding = new AudioContext();
        const o2 = ding.createOscillator();
        const g2 = ding.createGain();
        o2.frequency.value = 920;
        g2.gain.value = 0.02;
        o2.connect(g2);
        g2.connect(ding.destination);
        o2.start();
        o2.stop(ding.currentTime + 0.05);
      }
      playingRef.current = false;
      playQueue();
    };
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
    if (roomId.trim()) {
      setCookie("family_translation_room_id", roomId.trim().toUpperCase());
    }
  }, [roomId]);

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

  const sendTurn = (messageText: string, source: "manual" | "autopilot") => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !messageText.trim() || !connected) {
      return false;
    }
    const turnId = createTurnId();
    const normalizedRoomId = roomId.trim().toUpperCase();
    wsRef.current.send(
      JSON.stringify({
        type: "turn.start",
        turnId,
        roomId: normalizedRoomId,
        speakerLanguage: language
      })
    );
    wsRef.current.send(
      JSON.stringify({
        type: "audio.input",
        turnId,
        roomId: normalizedRoomId,
        payloadBase64: encodeStringAsBase64(messageText.trim()),
        sequence: 0,
        isLast: true
      })
    );
    wsRef.current.send(
      JSON.stringify({
        type: "turn.stop",
        turnId,
        roomId: normalizedRoomId
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
    if (!roomId.trim() || !displayName.trim()) {
      setStatusMessage("Set room and display name first.");
      return;
    }
    wsRef.current?.close();
    const ws = new WebSocket(WS_BASE_URL);
    wsRef.current = ws;
    addDebugEvent(`socket.connecting room=${roomId.trim().toUpperCase()} lang=${language}`);

    ws.onopen = () => {
      setStatusMessage("Socket connected");
      addDebugEvent("socket.open");
      ws.send(
        JSON.stringify({
          type: "session.join",
          roomId: roomId.trim().toUpperCase(),
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
        setClientId(event.clientId);
        setStatusMessage(`Joined room ${event.roomId}`);
        addDebugEvent(`session.joined room=${event.roomId} client=${event.clientId}`);
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
      if (event.type === "transcript.chunk") {
        setTranscripts((previous) => [
          {
            turnId: event.turnId,
            speakerId: event.speakerId,
            translatedText: event.translatedText,
            originalText: event.originalText,
            targetLanguage: event.targetLanguage,
            timestamp: event.timestamp,
            debug: event.debug
          },
          ...previous
        ]);
        if (hearAudio && event.speakerId !== clientId) {
          const audioContext = new AudioContext();
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          gain.gain.value = 0.02;
          oscillator.frequency.value = 880;
          oscillator.connect(gain);
          gain.connect(audioContext.destination);
          oscillator.start();
          oscillator.stop(audioContext.currentTime + 0.06);
        }
        addDebugEvent(
          `transcript.chunk turn=${event.turnId} final=${event.isFinal} stt=${event.debug?.transcriptionPath ?? "n/a"} tx=${event.debug?.translationPath ?? "n/a"} tts=${event.debug?.ttsPath ?? "n/a"}`
        );
        return;
      }
      if (event.type === "audio.chunk") {
        audioQueueRef.current.push({ payloadBase64: event.payloadBase64, isLast: event.isLast });
        playQueue();
        addDebugEvent(`audio.chunk turn=${event.turnId} last=${event.isLast}`);
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
        return;
      }
      if (event.type === "error") {
        setStatusMessage(event.message);
        addDebugEvent(`server.error message=${event.message}`);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setStatusMessage("Socket disconnected");
      addDebugEvent("socket.closed");
      clearAutoPilotTimer();
      autoPilotEnabledRef.current = false;
      setAutoPilotEnabled(false);
    };

    ws.onerror = () => {
      addDebugEvent("socket.error");
    };
  };

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
          turnId: micTurnIdRef.current,
          roomId: roomId.trim().toUpperCase()
        })
      );
    }

    addDebugEvent(`mic.stop turn=${micTurnIdRef.current ?? "n/a"}`);
    micTurnIdRef.current = null;
    setMicTestActive(false);
  };

  const startMicTest = async () => {
    if (!connected || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setStatusMessage("Connect first before starting mic test.");
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
          roomId: roomId.trim().toUpperCase(),
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
            roomId: roomId.trim().toUpperCase(),
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
      setStatusMessage("Mic test started. Speak, then stop mic test to submit turn.");
    } catch {
      setStatusMessage("Mic access failed. Check browser microphone permissions.");
      addDebugEvent("mic.start.failed");
      await stopMicTest();
    }
  };

  const submitTurn = () => {
    const sent = sendTurn(textInput, "manual");
    if (sent) {
      setTextInput("");
    }
  };

  const saveGlossary = async () => {
    if (!roomId.trim() || !clientId || !manualTerm.trim() || !manualTranslation.trim()) {
      return;
    }
    const response = await fetch(`${HTTP_BASE_URL}/api/glossary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roomId: roomId.trim().toUpperCase(),
        userId: clientId,
        term: manualTerm.trim(),
        translation: manualTranslation.trim(),
        notes: manualNotes.trim()
      })
    });
    if (response.ok) {
      setManualTerm("");
      setManualTranslation("");
      setManualNotes("");
      setStatusMessage("Glossary saved");
      addDebugEvent(`glossary.saved term=${manualTerm.trim()}`);
    }
  };

  const submitCorrection = () => {
    if (!connected || !wsRef.current || !correctionWrong.trim() || !correctionRight.trim()) {
      return;
    }
    wsRef.current.send(
      JSON.stringify({
        type: "correction.submit",
        roomId: roomId.trim().toUpperCase(),
        wrongText: correctionWrong.trim(),
        rightText: correctionRight.trim(),
        context: correctionContext.trim()
      })
    );
    setCorrectionWrong("");
    setCorrectionRight("");
    setCorrectionContext("");
    setStatusMessage("Correction submitted");
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
      setStatusMessage("Connect first before starting autopilot.");
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
        roomId: roomId.trim().toUpperCase(),
        clientId,
        displayName,
        language,
        hearAudio,
        autoPilotEnabled,
        autoPilotRuns,
        nextAutoDelaySeconds,
        transcriptCount: transcripts.length,
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
      recentRoomDebugTurns: debugTurnsRef.current.slice(0, 20),
      recentEvents: debugEventsRef.current
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setStatusMessage("Debug blob copied to clipboard.");
      addDebugEvent("debug.copied");
    } catch {
      setStatusMessage("Could not copy debug blob. Retry in Safari app context.");
      addDebugEvent("debug.copy.failed");
    }
  };

  const sortedTranscripts = useMemo(
    () => [...transcripts].sort((a, b) => b.timestamp - a.timestamp),
    [transcripts]
  );

  return (
    <main className="layout">
      <header className="panel">
        <div className="headerRow">
          <h1>Family Translation Room</h1>
          <button onClick={copyDebugBlob}>Copy Debug Blob</button>
        </div>
        <p>Private EN ↔ JA speech-to-text translator with provider controls.</p>
        <p className={networkOnline ? "ok" : "warn"}>{networkOnline ? "Online" : "Offline"}</p>
      </header>

      <section className="panel grid2">
        <label>
          Room code
          <input value={roomId} onChange={(event) => setRoomId(event.target.value)} placeholder="ABC123" />
        </label>
        <label>
          Display name
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Alex" />
        </label>
        <label>
          Language
          <select value={language} onChange={(event) => setLanguage(event.target.value as SupportedLanguage)}>
            <option value="en">English</option>
            <option value="ja">Japanese</option>
          </select>
        </label>
        <label>
          Hear translated audio cue
          <input type="checkbox" checked={hearAudio} onChange={(event) => setHearAudio(event.target.checked)} />
        </label>
        <label className="full">
          Context notes (people, terms, pronunciation hints)
          <textarea value={contextNotes} onChange={(event) => setContextNotes(event.target.value)} rows={2} />
        </label>
        <div className="actions">
          <button onClick={connect} disabled={connected}>
            Connect
          </button>
          <button onClick={disconnect}>Disconnect</button>
        </div>
        <p className="full">{statusMessage}</p>
      </section>

      <section className="panel">
        <h2>Live Speech-to-Text</h2>
        <p>
          For this scaffold, speech packets are simulated through text input while the same websocket turn flow is used.
        </p>
        <div className="actions">
          <input
            value={textInput}
            onChange={(event) => setTextInput(event.target.value)}
            placeholder="Say something..."
            className="grow"
          />
          <button onClick={submitTurn} disabled={!connected || !textInput.trim()}>
            Send utterance
          </button>
          <button onClick={toggleAutoPilot} disabled={!connected}>
            {autoPilotEnabled ? "Stop simulator" : "Start simulator"}
          </button>
          {!micTestActive ? (
            <button onClick={() => void startMicTest()} disabled={!connected}>
              Start mic test
            </button>
          ) : (
            <button onClick={() => void stopMicTest()}>Stop mic test</button>
          )}
        </div>
        <p>
          Simulator sends random utterances every 15-45 seconds. Messages sent: {autoPilotRuns}
          {nextAutoDelaySeconds ? ` (next in ~${nextAutoDelaySeconds}s)` : ""}
        </p>
        <p>Mic test state: {micTestActive ? "capturing audio" : "idle"}</p>
      </section>

      <section className="panel grid2">
        <div>
          <h2>Glossary Entry</h2>
          <label>
            Term
            <input value={manualTerm} onChange={(event) => setManualTerm(event.target.value)} />
          </label>
          <label>
            Translation
            <input value={manualTranslation} onChange={(event) => setManualTranslation(event.target.value)} />
          </label>
          <label>
            Notes
            <input value={manualNotes} onChange={(event) => setManualNotes(event.target.value)} />
          </label>
          <button onClick={saveGlossary} disabled={!connected}>
            Save glossary
          </button>
        </div>
        <div>
          <h2>Correction Feedback</h2>
          <label>
            Wrong output
            <input value={correctionWrong} onChange={(event) => setCorrectionWrong(event.target.value)} />
          </label>
          <label>
            Correct output
            <input value={correctionRight} onChange={(event) => setCorrectionRight(event.target.value)} />
          </label>
          <label>
            Context
            <input value={correctionContext} onChange={(event) => setCorrectionContext(event.target.value)} />
          </label>
          <button onClick={submitCorrection} disabled={!connected}>
            Submit correction
          </button>
        </div>
      </section>

      <section className="panel grid3">
        <h2 className="full">Provider Controls (Operator)</h2>
        <label>
          STT
          <select value={providerStt} onChange={(event) => setProviderStt(event.target.value as ProviderType)}>
            <option value="deepgram">Deepgram</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>
        <label>
          Translation
          <select
            value={providerTranslation}
            onChange={(event) => setProviderTranslation(event.target.value as ProviderType)}
          >
            <option value="gemini">Gemini</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>
        <label>
          TTS
          <select value={providerTts} onChange={(event) => setProviderTts(event.target.value as ProviderType)}>
            <option value="cartesia">Cartesia</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>
        <div className="actions full">
          <button onClick={saveProviders} disabled={!connected}>
            Apply providers
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Transcript</h2>
        <ul className="transcriptList">
          {sortedTranscripts.map((item) => (
            <li key={`${item.turnId}-${item.timestamp}`}>
              <strong>{item.targetLanguage.toUpperCase()}</strong> {new Date(item.timestamp).toLocaleTimeString()} -{" "}
              {item.translatedText}
              <details>
                <summary>Show original</summary>
                <p>{item.originalText}</p>
              </details>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>iPhone Reliability Checklist</h2>
        <ul>
          <li>Install via Add to Home Screen, keep app in foreground while conversing.</li>
          <li>Disable auto-lock during conversation sessions.</li>
          <li>If audio stalls, tap Disconnect then Connect to resume session.</li>
        </ul>
      </section>
    </main>
  );
}

export default App;
