import { describe, expect, it } from "vitest";

import { DgPcmStream } from "../src/deepgram-stream.js";

describe("DgPcmStream", () => {
  it("invokes onFinalSegment for each is_final phrase", async () => {
    const finals: string[] = [];
    const stream = new DgPcmStream("test-key", "en", {
      onFinalSegment: (t) => finals.push(t)
    });

    (stream as unknown as { onMessage: (d: Buffer) => void }).onMessage(
      Buffer.from(
        JSON.stringify({
          type: "Results",
          is_final: true,
          channel: { alternatives: [{ transcript: "Hello." }] }
        })
      )
    );
    (stream as unknown as { onMessage: (d: Buffer) => void }).onMessage(
      Buffer.from(
        JSON.stringify({
          type: "Results",
          is_final: true,
          channel: { alternatives: [{ transcript: "How are you?" }] }
        })
      )
    );

    expect(finals).toEqual(["Hello.", "How are you?"]);
    await stream.close();
  });

  it("keeps rolling onTranscript in sync with finals", async () => {
    const rolling: string[] = [];
    const stream = new DgPcmStream("test-key", "en", {
      onTranscript: (t) => rolling.push(t)
    });

    (stream as unknown as { onMessage: (d: Buffer) => void }).onMessage(
      Buffer.from(
        JSON.stringify({
          type: "Results",
          is_final: true,
          channel: { alternatives: [{ transcript: "A" }] }
        })
      )
    );
    (stream as unknown as { onMessage: (d: Buffer) => void }).onMessage(
      Buffer.from(
        JSON.stringify({
          type: "Results",
          is_final: true,
          channel: { alternatives: [{ transcript: "B" }] }
        })
      )
    );

    expect(rolling).toEqual(["A", "A B"]);
  });
});
