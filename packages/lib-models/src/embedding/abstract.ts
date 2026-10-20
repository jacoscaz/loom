export interface EmbeddingResult {
  embedding: number[];
  tokens: number;
}

export interface EmbeddingModelOpts {
  /** Vector dimensionality produced by this model. Default 1536. */
  dimensions?: number;
}

export abstract class AbstractEmbeddingModel {

  readonly #dimensions: number;

  constructor(opts: EmbeddingModelOpts) {
    this.#dimensions = opts.dimensions ?? 1536;
  }

  get dimensions(): number {
    return this.#dimensions;
  }

  abstract embed(text: string): Promise<EmbeddingResult>;

  abstract embedBatch(texts: string[]): Promise<EmbeddingResult[]>;

}
