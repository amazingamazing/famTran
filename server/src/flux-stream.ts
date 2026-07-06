import WebSocket from "ws";

import type { SupportedLanguage } from "@family-translation/shared";

import type { PcmStream, PcmStreamOptions } from "./pcm-stream.js";

const LIVE_URL = "wss://api.deepgram.com/v2/listen";
const MODEL = "flux-general-multi";

type FluxTurnEvent = "Update" | "StartOfTurn" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn";

type FluxTurnInfoMessage = {
  type?: string;
  event?: FluxTurnEvent;
  transcript?: string;
};

/**
 * Pushes 16kHz linear16 mono PCM to Deepgram Flux (v2 listen) and finalizes on {@link FluxPcmStream.close}.
 */
export class FluxPcmStream implements PcmStream {
  private readonly pending: Buffer[] = [];
  private ws: WebSocket | null = null;
  private connectInitiated = false;
  private connected = false;
  private failed = false;
  private finished = false;
  private finalText: string | null = null;
  private readonly finals: string[] = [];
  private readonly onTranscript?: (sourceText: string) => void;
  private readonly onFinalSegment?: (segmentText: string) => void;
  private connectedAt = 0;
  private closedAt = 0;

  constructor(
    private readonly apiKey: string,
    private readonly sourceLanguage: SupportedLanguage,
    options: PcmStreamOptions = {}
  ) {
    this.onTranscript = options.onTranscript;
    this.onFinalSegment = options.onFinalSegment;
  }

  addChunk(b: Buffer): void {
    if (this.finished) {
      return;
    }
    if (this.failed) {
      return;
    }
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(b);
    } else {
      this.pending.push(b);
      this.ensureSocket();
    }
  }

  getStreamDurationMs(): number | undefined {
    if (this.connectedAt <= 0 || this.closedAt <= 0) {
      return undefined;
    }
    return this.closedAt - this.connectedAt;
  }

  async close(): Promise<string> {
    if (this.finalText !== null) {
      return this.finalText;
    }
    this.finished = true;

    if (this.failed || !this.apiKey) {
      this.closedAt = Date.now();
      return (this.finalText = this.finals.join(" ").trim());
    }

    if (!this.ws) {
      this.closedAt = Date.now();
      return (this.finalText = this.finals.join(" ").trim());
    }

    await new Promise<void>((resolve) => {
      if (this.connected) {
        resolve();
        return;
      }
      this.ws?.once("open", () => resolve());
      this.ws?.once("error", () => resolve());
      setTimeout(resolve, 5000);
    });

    if (this.failed) {
      this.closedAt = Date.now();
      return (this.finalText = this.finals.join(" ").trim());
    }

    if (!this.ws) {
      this.closedAt = Date.now();
      return (this.finalText = this.finals.join(" ").trim());
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        this.failed = true;
      }
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      const text = await new Promise<string>((resolve) => {
        const t = setTimeout(() => {
          this.ws?.terminate();
          resolve(this.finals.join(" ").trim());
        }, 30_000);
        this.ws!.once("close", () => {
          clearTimeout(t);
          resolve(this.finals.join(" ").trim());
        });
      });
      this.closedAt = Date.now();
      return (this.finalText = text);
    }

    this.closedAt = Date.now();
    return (this.finalText = this.finals.join(" ").trim());
  }

  private buildUrl(): string {
    const q = new URLSearchParams({
      model: MODEL,
      encoding: "linear16",
      sample_rate: "16000"
    });
    q.append("language_hint", this.sourceLanguage === "ja" ? "ja" : "en");
    return `${LIVE_URL}?${q.toString()}`;
  }

  private ensureSocket(): void {
    if (this.connectInitiated) {
      return;
    }
    this.connectInitiated = true;
    const url = this.buildUrl();
    const socket = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` }
    });
    this.ws = socket;

    socket.on("message", (data) => {
      this.onMessage(data);
    });
    socket.once("error", () => {
      this.failed = true;
    });
    socket.once("open", () => {
      this.connected = true;
      this.connectedAt = Date.now();
      for (const p of this.pending) {
        socket.send(p);
      }
      this.pending.length = 0;
    });
  }

  private emitRollingDisplay(currentTurnTranscript: string): void {
    if (!this.onTranscript) {
      return;
    }
    const base = this.finals.join(" ");
    const t = (base + (base && currentTurnTranscript ? " " : "") + currentTurnTranscript).trim();
    this.onTranscript(t);
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: FluxTurnInfoMessage & { type?: string };
    try {
      msg = JSON.parse(data.toString()) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === "Error") {
      this.failed = true;
      return;
    }
    if (msg.type !== "TurnInfo") {
      return;
    }

    const seg = msg.transcript?.trim() ?? "";
    if (msg.event === "EndOfTurn") {
      if (seg.length > 0) {
        this.finals.push(seg);
        this.onFinalSegment?.(seg);
      }
      if (this.onTranscript) {
        this.onTranscript(this.finals.join(" ").trim());
      }
      return;
    }

    if (
      msg.event === "Update" ||
      msg.event === "StartOfTurn" ||
      msg.event === "TurnResumed" ||
      msg.event === "EagerEndOfTurn"
    ) {
      this.emitRollingDisplay(seg);
    }
  }
}
