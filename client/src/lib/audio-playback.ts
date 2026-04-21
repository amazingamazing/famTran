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

export const audioPayloadToObjectUrl = (
  payloadBase64: string,
  mimeType: AudioChunkMimeType
): { url: string; mimeType: "audio/wav" } => {
  const bytes = base64ToBytes(payloadBase64);
  const wavBytes = mimeType === "audio/pcm" ? convertPcm16MonoToWavBytes(bytes, 22050) : bytes;
  const blob = new Blob([toArrayBuffer(wavBytes)], { type: "audio/wav" });
  return { url: URL.createObjectURL(blob), mimeType: "audio/wav" };
};
