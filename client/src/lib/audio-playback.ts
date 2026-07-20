type AudioChunkMimeType = "audio/pcm" | "audio/wav";

const base64ToBytes = (payloadBase64: string): Uint8Array => {
  const binary = atob(payloadBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const writeAscii = (view: DataView, offset: number, value: string) => {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

export const convertPcm16MonoToWavBytes = (pcmBytes: Uint8Array, sampleRate: number): Uint8Array => {
  const wavHeaderBytes = 44;
  const wavBytes = new Uint8Array(wavHeaderBytes + pcmBytes.length);
  const view = new DataView(wavBytes.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcmBytes.length, true);
  wavBytes.set(pcmBytes, wavHeaderBytes);
  return wavBytes;
};

export const audioPayloadToWavBytes = (
  payloadBase64: string,
  mimeType: AudioChunkMimeType
): Uint8Array => {
  const bytes = base64ToBytes(payloadBase64);
  return mimeType === "audio/pcm" ? convertPcm16MonoToWavBytes(bytes, 22050) : bytes;
};

export const audioPayloadToObjectUrl = (
  payloadBase64: string,
  mimeType: AudioChunkMimeType
): { url: string; mimeType: "audio/wav" } => {
  const wavBytes = audioPayloadToWavBytes(payloadBase64, mimeType);
  const blob = new Blob([toArrayBuffer(wavBytes)], { type: "audio/wav" });
  return { url: URL.createObjectURL(blob), mimeType: "audio/wav" };
};

/** English → right (+1), Japanese → left (−1). */
export const panForTargetLanguage = (targetLanguage: "en" | "ja" | undefined): number => {
  if (targetLanguage === "ja") {
    return -1;
  }
  if (targetLanguage === "en") {
    return 1;
  }
  return 0;
};

export const supportsStereoPanner = (ctx: AudioContext): boolean =>
  typeof ctx.createStereoPanner === "function";

/**
 * Connect a mono BufferSource to destination with stereo pan.
 * Prefers StereoPannerNode; falls back to ChannelMerger + dual GainNodes.
 */
export const connectPannedSource = (
  ctx: AudioContext,
  source: AudioBufferSourceNode,
  pan: number
): AudioNode => {
  if (supportsStereoPanner(ctx)) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    source.connect(panner);
    panner.connect(ctx.destination);
    return panner;
  }

  const gainL = ctx.createGain();
  const gainR = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  const clamped = Math.max(-1, Math.min(1, pan));
  // Hard left / right / center for the merger fallback.
  if (clamped < -0.01) {
    gainL.gain.value = 1;
    gainR.gain.value = 0;
  } else if (clamped > 0.01) {
    gainL.gain.value = 0;
    gainR.gain.value = 1;
  } else {
    gainL.gain.value = 1;
    gainR.gain.value = 1;
  }
  source.connect(gainL);
  source.connect(gainR);
  gainL.connect(merger, 0, 0);
  gainR.connect(merger, 0, 1);
  merger.connect(ctx.destination);
  return merger;
};

let sharedPlaybackContext: AudioContext | null = null;

/** Shared playback graph (separate from mic capture context) for Quick Chat stereo TTS. */
export const ensurePlaybackAudioContext = async (): Promise<AudioContext> => {
  if (!sharedPlaybackContext || sharedPlaybackContext.state === "closed") {
    sharedPlaybackContext = new AudioContext();
  }
  if (sharedPlaybackContext.state === "suspended") {
    await sharedPlaybackContext.resume();
  }
  return sharedPlaybackContext;
};

export const playPannedWavBytes = async (
  ctx: AudioContext,
  wavBytes: Uint8Array,
  pan: number
): Promise<void> => {
  const audioBuffer = await ctx.decodeAudioData(toArrayBuffer(wavBytes));
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  connectPannedSource(ctx, source, pan);
  await new Promise<void>((resolve, reject) => {
    source.onended = () => resolve();
    try {
      source.start(0);
    } catch (err) {
      reject(err);
    }
  });
};
