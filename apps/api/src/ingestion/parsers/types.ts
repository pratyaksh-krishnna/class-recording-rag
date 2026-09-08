/** The single shape both parsers emit. Downstream code never knows the format. */
export interface NormalizedCue {
  /**
   * Position in the emitted list, zero-based — deliberately NOT the number
   * printed in the file, which real transcripts repeat, skip, and restart.
   */
  index: number;
  startMs: number;
  endMs: number;
  /** Cleaned: tags stripped, entities decoded, whitespace collapsed. */
  text: string;
  /** Captured for V2 playback attribution; unused by V1 retrieval. */
  speaker: string | null;
}

export type TranscriptFormat = 'srt' | 'vtt';
