import { OpenAIEmbeddingModel, type OpenAIEmbeddingModelOpts } from "./openai.js";

export * from "./abstract.js";
export { OpenAIEmbeddingModel, type OpenAIEmbeddingModelOpts } from "./openai.js";

/** Provider type -> options and model class. */
export interface EmbeddingModels {
  openai: { opts: OpenAIEmbeddingModelOpts; model: OpenAIEmbeddingModel };
}

export type EmbeddingModelType = keyof EmbeddingModels;

export const embeddingModel = <T extends EmbeddingModelType>(type: T, opts: EmbeddingModels[T]['opts']): EmbeddingModels[T]['model'] => {
  switch (type) {
    case 'openai':
      return new OpenAIEmbeddingModel(opts);
    default:
      throw new Error(`Unsupported embedding model type: ${type}`);
  }
};
