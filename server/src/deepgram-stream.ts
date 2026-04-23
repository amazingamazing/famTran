import WebSocket from "ws";

import type { SupportedLanguage } from "@family-translation/shared";

const LIVE_URL = "wss://api.deepgram.com/v1/listen";
const MODEL = "nova-3";

/**
 * Pushes 16kHz linear16 mono PCM to Deepgram's live API and finalizes on {@link DgPcmStream.close}.
 * Uses the `ws` client with the same model/options as the batch HTTP `listen` path in providers.
 */
export class DgPcmStream {
  private readonly pending: Buffer[] = [];
  private ws: WebSocket | null = null;
  private connectInitiated = false;
  private connected = false;
  private failed = false;
  private finished = false;
  private finalText: string | null = null;
  private readonly finals: string[] = [];

  constructor(
    private readonly apiKey: string,
    private readonly sourceLanguage: SupportedLanguage
  ) {}

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

  async close(): Promise<string> {
    if (this.finalText !== null) {
      return this.finalText;
    }
    this.finished = true;

    if (this.failed || !this.apiKey) {
      return (this.finalText = this.finals.join(" ").trim());
    }

    if (!this.ws) {
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
      return (this.finalText = this.finals.join(" ").trim());
    }

    if (!this.ws) {
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
      return (this.finalText = text);
    }

    return (this.finalText = this.finals.join(" ").trim());
  }

  private buildUrl(): string {
    const language = this.sourceLanguage === "ja" ? "ja" : "en";
    const q = new URLSearchParams({
      model: MODEL,
      language,
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      smart_format: "true",
      punctuate: "true",
      interim_results: "true"
    });
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
      for (const p of this.pending) {
        socket.send(p);
      }
      this.pending.length = 0;
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: { type?: string; is_final?: boolean; channel?: { alternatives?: Array<{ transcript?: string }> } };
    try {
      msg = JSON.parse(data.toString()) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === "Error") {
      this.failed = true;
      return;
    }
    if (msg.type === "Metadata") {
      return;
    }
    if (msg.type !== "Results") {
      return;
    }
    if (!msg.is_final) {
      return;
    }
    const t = msg.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
    if (t.length > 0) {
      this.finals.push(t);
    }
  }
}
