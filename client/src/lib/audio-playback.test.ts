import { describe, expect, it } from "vitest";

import {
  convertPcm16MonoToWavBytes,
  panForTargetLanguage,
  supportsStereoPanner
} from "./audio-playback";

describe("audio playback helpers", () => {
  it("wraps raw pcm16 mono bytes into wav container", () => {
    const pcm = new Uint8Array([0, 0, 255, 127, 0, 128, 1, 0]);
    const wav = convertPcm16MonoToWavBytes(pcm, 22050);

    expect(wav.length).toBe(44 + pcm.length);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(String.fromCharCode(...wav.slice(12, 16))).toBe("fmt ");
    expect(String.fromCharCode(...wav.slice(36, 40))).toBe("data");
  });

  it("maps target language to stereo pan (EN right, JA left)", () => {
    expect(panForTargetLanguage("en")).toBe(1);
    expect(panForTargetLanguage("ja")).toBe(-1);
    expect(panForTargetLanguage(undefined)).toBe(0);
  });

  it("feature-detects StereoPannerNode via createStereoPanner", () => {
    const withPanner = { createStereoPanner: () => ({}) } as unknown as AudioContext;
    const withoutPanner = {} as AudioContext;
    expect(supportsStereoPanner(withPanner)).toBe(true);
    expect(supportsStereoPanner(withoutPanner)).toBe(false);
  });
});
