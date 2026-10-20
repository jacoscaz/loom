import { AnthropicCompletionModel, type AnthropicCompletionModelOpts } from "./anthropic/model.js";
import { OpenAICompletionModel, type OpenAICompletionModelOpts } from "./openai/model.js";
import { TensorXCompletionModel, type TensorXCompletionModelOpts } from "./tensorx.js";

export * from "./abstract.js";
export { AnthropicCompletionModel, type AnthropicCompletionModelOpts } from "./anthropic/model.js";
export { type PromptCacheTTL } from "./anthropic/formatters.js";
export { OpenAICompletionModel, type OpenAICompletionModelOpts } from "./openai/model.js";
export { TensorXCompletionModel, type TensorXCompletionModelOpts, TENSORX_BASE_URL } from "./tensorx.js";
export { findTextualToolCallNames } from "./shared.js";

/** Provider type -> options and model class. */
export interface CompletionModels {
  anthropic: { opts: AnthropicCompletionModelOpts; model: AnthropicCompletionModel };
  openai: { opts: OpenAICompletionModelOpts; model: OpenAICompletionModel };
  tensorx: { opts: TensorXCompletionModelOpts; model: TensorXCompletionModel };
}

export type CompletionModelType = keyof CompletionModels;

export const completionModel = <T extends CompletionModelType>(type: T, opts: CompletionModels[T]['opts']): CompletionModels[T]['model'] => {
  switch (type) {
    case 'anthropic':
      return new AnthropicCompletionModel(opts as AnthropicCompletionModelOpts) as CompletionModels[T]['model'];
    case 'openai':
      return new OpenAICompletionModel(opts as OpenAICompletionModelOpts) as CompletionModels[T]['model'];
    case 'tensorx':
      return new TensorXCompletionModel(opts as TensorXCompletionModelOpts) as CompletionModels[T]['model'];
    default:
      throw new Error(`Unsupported completion model type: ${type}`);
  }
};
