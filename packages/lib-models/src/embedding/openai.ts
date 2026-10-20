import OpenAI from 'openai';
import { AbstractEmbeddingModel, type EmbeddingModelOpts, type EmbeddingResult } from "./abstract.js";

export interface OpenAIEmbeddingModelOpts extends EmbeddingModelOpts {
  model: string;
  api_key: string;
  base_url?: string;
  /** Provider-specific request body parameters, spread into every request. */
  extras?: Record<string, any>;
}

export class OpenAIEmbeddingModel extends AbstractEmbeddingModel {

  #model: string;
  #client: OpenAI;
  #extras: Record<string, any>;

  constructor(opts: OpenAIEmbeddingModelOpts) {
    super(opts);
    this.#model = opts.model;
    this.#extras = opts.extras ?? {};
    this.#client = new OpenAI({
      apiKey: opts.api_key,
      baseURL: opts.base_url,
    });
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await this.#client.embeddings.create({
      input: text,
      model: this.#model,
      dimensions: this.dimensions,
      ...this.#extras,
    } as OpenAI.EmbeddingCreateParams);
    return {
      embedding: response.data[0]!.embedding,
      tokens: response.usage.prompt_tokens,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await this.#client.embeddings.create({
      input: texts,
      model: this.#model,
      dimensions: this.dimensions,
      ...this.#extras,
    } as OpenAI.EmbeddingCreateParams);
    // Providers may return embeddings out of order; `index` is authoritative.
    return response.data
      .sort((a, b) => a.index - b.index)
      .map((d) => ({
        embedding: d.embedding,
        tokens: Math.round(response.usage.prompt_tokens / texts.length),
      }));
  }

}
