import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderType, SupportedLanguage } from "@family-translation/shared";

import "./App.css";
import { parseEvent } from "./lib/parse-event";

type TranscriptRow = {
  turnId: string;
  speakerId: string;
  translatedText: string;
  originalText: string;
  targetLanguage: SupportedLanguage;
  timestamp: number;
};

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

function App() {
  const wsRef = useRef<WebSocket | null>(null);
  const audioQueueRef = useRef<Array<{ payloadBase64: string; isLast: boolean }>>([]);
  const playingRef = useRef(false);
  const [roomId, setRoomId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [language, setLanguage] = useState<SupportedLanguage>("en");
  const [contextNotes, setContextNotes] = useState("");
  const [hearAudio, setHearAudio] = useState(true);
  const [connected, setConnected] = useState(false);
  const [clientId, setClientId] = useState("");
  const [textInput, setTextInput] = useState("");
  const [transcripts, setTranscripts] = useState<TranscriptRow[]>([]);
  const [providerStt, setProviderStt] = useState<ProviderType>("deepgram");
  const [providerTranslation, setProviderTranslation] = useState<ProviderType>("gemini");
  const [providerTts, setProviderTts] = useState<ProviderType>("cartesia");
  const [correctionWrong, setCorrectionWrong] = useState("");
  const [correctionRight, setCorrectionRight] = useState("");
  const [correctionContext, setCorrectionContext] = useState("");
  const [manualTerm, setManualTerm] = useState("");
  const [manualTranslation, setManualTranslation] = useState("");
  const [manualNotes, setManualNotes] = useState("");
  const [networkOnline, setNetworkOnline] = useState(navigator.onLine);
  const [statusMessage, setStatusMessage] = useState("Not connected");

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

  const connect = () => {
    if (!roomId.trim() || !displayName.trim()) {
      setStatusMessage("Set room and display name first.");
      return;
    }
    wsRef.current?.close();
    const ws = new WebSocket(WS_BASE_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatusMessage("Socket connected");
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
        return;
      }
      if (event.type === "session.joined") {
        setConnected(true);
        setClientId(event.clientId);
        setStatusMessage(`Joined room ${event.roomId}`);
        return;
      }
      if (event.type === "providers.updated") {
        setProviderStt(event.stt);
        setProviderTranslation(event.translation);
        setProviderTts(event.tts);
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
            timestamp: event.timestamp
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
        return;
      }
      if (event.type === "audio.chunk") {
        audioQueueRef.current.push({ payloadBase64: event.payloadBase64, isLast: event.isLast });
        playQueue();
        return;
      }
      if (event.type === "error") {
        setStatusMessage(event.message);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setStatusMessage("Socket disconnected");
    };
  };

  const disconnect = () => {
    wsRef.current?.close();
    wsRef.current = null;
  };

  const submitTurn = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !textInput.trim() || !connected) {
      return;
    }
    const turnId = createTurnId();
    wsRef.current.send(
      JSON.stringify({
        type: "turn.start",
        turnId,
        roomId: roomId.trim().toUpperCase(),
        speakerLanguage: language
      })
    );
    wsRef.current.send(
      JSON.stringify({
        type: "audio.input",
        turnId,
        roomId: roomId.trim().toUpperCase(),
        payloadBase64: encodeStringAsBase64(textInput.trim()),
        sequence: 0,
        isLast: true
      })
    );
    wsRef.current.send(
      JSON.stringify({
        type: "turn.stop",
        turnId,
        roomId: roomId.trim().toUpperCase()
      })
    );
    setTextInput("");
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
  };

  const sortedTranscripts = useMemo(
    () => transcripts.sort((a, b) => b.timestamp - a.timestamp),
    [transcripts]
  );

  return (
    <main className="layout">
      <header className="panel">
        <h1>Family Translation Room</h1>
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
        </div>
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
