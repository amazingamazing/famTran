const TARGET_SAMPLE_RATE = 16_000;
const WORKLET_MODULE_URL = "/pcm-capture-processor.js";

export const downsampleTo16k = (input: Float32Array, inputSampleRate: number): Float32Array => {
  if (inputSampleRate === TARGET_SAMPLE_RATE) {
    return input;
  }
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
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

export const floatToPcm16 = (input: Float32Array): Int16Array => {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
};

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitForTracksLive = async (stream: MediaStream, timeoutMs = 1500) => {
  const tracks = stream.getTracks();
  if (tracks.length === 0 || tracks.every((track) => track.readyState === "live")) {
    return;
  }
  await Promise.race([
    Promise.all(
      tracks.map(
        (track) =>
          new Promise<void>((resolve) => {
            if (track.readyState === "live") {
              resolve();
              return;
            }
            track.addEventListener("unmute", () => resolve(), { once: true });
          })
      )
    ),
    sleepMs(timeoutMs)
  ]);
};

export type MicCaptureHandle = {
  sampleRate: number;
  /** True while any underlying MediaStreamTrack is still `live`. */
  isLive: () => boolean;
  stop: () => Promise<void>;
};

export type MicCaptureOptions = {
  onPcmChunk: (pcm16: Int16Array) => void;
  /**
   * Quick Chat: after getUserMedia becomes live, wait this long before enabling PCM
   * callbacks so the first spoken word is not clipped. Room mode omits this.
   */
  warmupMs?: number;
};

/**
 * Captures mono PCM16 @ 16 kHz via AudioWorklet. Uses a zero-gain node so the graph runs without audible loopback.
 * Always stops every MediaStreamTrack and drops the stream reference on {@link MicCaptureHandle.stop}.
 */
export const startMicCapture = async (options: MicCaptureOptions): Promise<MicCaptureHandle> => {
  let stream: MediaStream | null = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  await waitForTracksLive(stream);
  if (options.warmupMs && options.warmupMs > 0) {
    await sleepMs(options.warmupMs);
  }

  let audioContext: AudioContext;
  try {
    audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    audioContext = new AudioContext();
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  await audioContext.audioWorklet.addModule(WORKLET_MODULE_URL);

  const source = audioContext.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioContext, "pcm-capture-processor");
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;

  source.connect(worklet);
  worklet.connect(silentGain);
  silentGain.connect(audioContext.destination);

  const effectiveRate = audioContext.sampleRate;
  let stopped = false;

  worklet.port.onmessage = (event: MessageEvent<{ samples: Float32Array }>) => {
    if (stopped) {
      return;
    }
    const samples = event.data?.samples;
    if (!samples?.length) {
      return;
    }
    const downsampled = downsampleTo16k(samples, effectiveRate);
    options.onPcmChunk(floatToPcm16(downsampled));
  };

  return {
    sampleRate: effectiveRate,
    isLive: () => {
      if (!stream || stopped) {
        return false;
      }
      return stream.getTracks().some((track) => track.readyState === "live");
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      worklet.port.onmessage = null;
      try {
        worklet.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        silentGain.disconnect();
      } catch {
        /* already disconnected */
      }
      const active = stream;
      stream = null;
      if (active) {
        for (const track of active.getTracks()) {
          try {
            track.stop();
          } catch {
            /* ignore */
          }
        }
      }
      try {
        await audioContext.close();
      } catch {
        /* already closed */
      }
    }
  };
};
