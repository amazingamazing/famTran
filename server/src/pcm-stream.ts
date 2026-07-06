export type PcmStreamOptions = {
  onTranscript?: (sourceText: string) => void;
  onFinalSegment?: (segmentText: string) => void;
  /** Ignored by Flux; used by DgPcmStream only. */
  endpointingMs?: number;
};

export interface PcmStream {
  addChunk(b: Buffer): void;
  close(): Promise<string>;
  /** Wall-clock ms from socket open to close completion; Flux only. */
  getStreamDurationMs?(): number | undefined;
}
