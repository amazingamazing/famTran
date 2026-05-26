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

export type MicCaptureHandle = {
  sampleRate: number;
  stop: () => Promise<void>;
};

export type MicCaptureOptions = {
  onPcmChunk: (pcm16: Int16Array) => void;
};

/**
 * Captures mono PCM16 @ 16 kHz via AudioWorklet. Uses a zero-gain node so the graph runs without audible loopback.
 */
export const startMicCapture = async (options: MicCaptureOptions): Promise<MicCaptureHandle> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

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

  worklet.port.onmessage = (event: MessageEvent<{ samples: Float32Array }>) => {
    const samples = event.data?.samples;
    if (!samples?.length) {
      return;
    }
    const downsampled = downsampleTo16k(samples, effectiveRate);
    options.onPcmChunk(floatToPcm16(downsampled));
  };

  return {
    sampleRate: effectiveRate,
    stop: async () => {
      worklet.port.onmessage = null;
      worklet.disconnect();
      source.disconnect();
      silentGain.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await audioContext.close();
    }
  };
};
