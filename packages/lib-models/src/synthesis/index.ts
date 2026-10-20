import { OpenAISynthesisModel, type OpenAISynthesisModelOpts } from "./openai.js";

export * from "./abstract.js";
export { OpenAISynthesisModel, type OpenAISynthesisModelOpts, wavDurationSeconds } from "./openai.js";

/** Provider type -> options and model class. */
export interface SynthesisModels {
  openai: { opts: OpenAISynthesisModelOpts; model: OpenAISynthesisModel };
}

export type SynthesisModelType = keyof SynthesisModels;

export const synthesisModel = <T extends SynthesisModelType>(type: T, opts: SynthesisModels[T]['opts']): SynthesisModels[T]['model'] => {
  switch (type) {
    case 'openai':
      return new OpenAISynthesisModel(opts);
    default:
      throw new Error(`Unsupported synthesis model type: ${type}`);
  }
};
