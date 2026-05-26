import { describe, expect, it } from "vitest";

import { downsampleTo16k, floatToPcm16 } from "./mic-capture";

describe("mic-capture", () => {
  it("downsamples 48 kHz input to half length at 16 kHz", () => {
    const input = new Float32Array(480);
    input.fill(0.5);
    const output = downsampleTo16k(input, 48_000);
    expect(output.length).toBe(160);
  });

  it("encodes float samples as PCM16", () => {
    const pcm = floatToPcm16(new Float32Array([0, 1, -1]));
    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBe(0x7fff);
    expect(pcm[2]).toBe(-0x8000);
  });
});
