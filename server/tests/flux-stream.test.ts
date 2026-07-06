import { describe, expect, it, vi } from "vitest";

import { FluxPcmStream } from "../src/flux-stream.js";

describe("FluxPcmStream", () => {
  it("builds v2 URL with flux-general-multi and language_hint", () => {
    const stream = new FluxPcmStream("test-key", "ja");
    const url = (stream as unknown as { buildUrl: () => string }).buildUrl();
    expect(url).toContain("v2/listen");
    expect(url).toContain("model=flux-general-multi");
    expect(url).toContain("encoding=linear16");
    expect(url).toContain("sample_rate=16000");
    expect(url).toContain("language_hint=ja");
  });

  it("sends buffered chunks when the socket opens", () => {
    const stream = new FluxPcmStream("test-key", "en");
    const sent: Buffer[] = [];
    const mockSocket = {
      readyState: 1,
      send: (data: Buffer) => {
        sent.push(data);
      },
      once: vi.fn(),
      on: vi.fn()
    };

    (stream as unknown as { ws: typeof mockSocket; connected: boolean }).ws = mockSocket;
    (stream as unknown as { connected: boolean }).connected = true;
    (stream as unknown as { pending: Buffer[] }).pending.push(Buffer.from([1, 2]), Buffer.from([3, 4]));

    const socket = mockSocket;
    for (const p of (stream as unknown as { pending: Buffer[] }).pending) {
      socket.send(p);
    }
    (stream as unknown as { pending: Buffer[] }).pending.length = 0;

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(Buffer.from([1, 2]));
    expect(sent[1]).toEqual(Buffer.from([3, 4]));
  });

  it("maps TurnInfo Update to onTranscript and EndOfTurn to onFinalSegment", async () => {
    const rolling: string[] = [];
    const finals: string[] = [];
    const stream = new FluxPcmStream("test-key", "en", {
      onTranscript: (t) => rolling.push(t),
      onFinalSegment: (t) => finals.push(t)
    });

    const onMessage = (stream as unknown as { onMessage: (d: Buffer) => void }).onMessage.bind(stream);

    onMessage(
      Buffer.from(
        JSON.stringify({
          type: "TurnInfo",
          event: "Update",
          transcript: "Hello"
        })
      )
    );
    expect(rolling).toEqual(["Hello"]);

    onMessage(
      Buffer.from(
        JSON.stringify({
          type: "TurnInfo",
          event: "EndOfTurn",
          transcript: "Hello."
        })
      )
    );
    expect(finals).toEqual(["Hello."]);
    expect(rolling).toEqual(["Hello", "Hello."]);

    onMessage(
      Buffer.from(
        JSON.stringify({
          type: "TurnInfo",
          event: "EndOfTurn",
          transcript: "How are you?"
        })
      )
    );
    expect(finals).toEqual(["Hello.", "How are you?"]);
    expect(rolling).toEqual(["Hello", "Hello.", "Hello. How are you?"]);

    await stream.close();
  });

  it("close resolves with accumulated finals on socket close", async () => {
    const stream = new FluxPcmStream("test-key", "en");
    const onMessage = (stream as unknown as { onMessage: (d: Buffer) => void }).onMessage.bind(stream);

    onMessage(
      Buffer.from(
        JSON.stringify({
          type: "TurnInfo",
          event: "EndOfTurn",
          transcript: "Done."
        })
      )
    );

    const closeHandlers: Array<() => void> = [];
    const mockWs = {
      readyState: 1,
      send: vi.fn(),
      once: vi.fn((event: string, handler: () => void) => {
        if (event === "close") {
          closeHandlers.push(handler);
        }
      }),
      terminate: vi.fn()
    };

    (stream as unknown as { ws: typeof mockWs; connected: boolean; failed: boolean }).ws = mockWs;
    (stream as unknown as { connected: boolean }).connected = true;
    (stream as unknown as { connectedAt: number }).connectedAt = Date.now();

    const closePromise = stream.close();
    await Promise.resolve();
    closeHandlers[0]?.();
    await expect(closePromise).resolves.toBe("Done.");
    expect(stream.getStreamDurationMs()).toBeGreaterThanOrEqual(0);
  });

  it("close resolves with accumulated finals on timeout", async () => {
    vi.useFakeTimers();
    const stream = new FluxPcmStream("test-key", "en");
    const onMessage = (stream as unknown as { onMessage: (d: Buffer) => void }).onMessage.bind(stream);

    onMessage(
      Buffer.from(
        JSON.stringify({
          type: "TurnInfo",
          event: "EndOfTurn",
          transcript: "Partial."
        })
      )
    );

    const mockWs = {
      readyState: 1,
      send: vi.fn(),
      once: vi.fn(),
      terminate: vi.fn()
    };

    (stream as unknown as { ws: typeof mockWs; connected: boolean; failed: boolean }).ws = mockWs;
    (stream as unknown as { connected: boolean }).connected = true;
    (stream as unknown as { connectedAt: number }).connectedAt = Date.now();

    const closePromise = stream.close();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(closePromise).resolves.toBe("Partial.");
    expect(mockWs.terminate).toHaveBeenCalled();

    vi.useRealTimers();
  });
});
