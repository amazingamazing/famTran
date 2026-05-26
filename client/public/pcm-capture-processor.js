/**
 * Emits mono float samples from the mic graph to the main thread (16 kHz target is applied there).
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      const samples = new Float32Array(channel.length);
      samples.set(channel);
      this.port.postMessage({ samples });
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
