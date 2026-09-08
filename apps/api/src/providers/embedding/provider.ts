export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  /** Order-preserving: result[i] is the vector for texts[i]. Batches internally. */
  embed(texts: string[]): Promise<number[][]>;
}
