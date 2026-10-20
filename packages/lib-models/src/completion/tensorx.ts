import { OpenAICompletionModel, type OpenAICompletionModelOpts } from "./openai/model.js";

export const TENSORX_BASE_URL = 'https://api.tensorx.ai/v1';

export interface TensorXCompletionModelOpts extends OpenAICompletionModelOpts {
  /** Defaults to TENSORX_BASE_URL. */
  base_url?: string;
}

/**
 * TensorX (https://docs.tensorx.ai) exposes an OpenAI-compatible chat
 * completions API; reasoning models return their trace in
 * `reasoning_content`, which the OpenAI adapter already accumulates.
 */
export class TensorXCompletionModel extends OpenAICompletionModel {

  constructor(opts: TensorXCompletionModelOpts) {
    super({ ...opts, base_url: opts.base_url ?? TENSORX_BASE_URL });
  }

  protected override get provider(): string {
    return 'tensorx';
  }

}
