import { OpenAITranscriptionModel, type OpenAITranscriptionModelOpts } from "./openai.js";

export * from "./abstract.js";
export { OpenAITranscriptionModel, type OpenAITranscriptionModelOpts } from "./openai.js";

/** Provider type -> options and model class. */
export interface TranscriptionModels {
  openai: { opts: OpenAITranscriptionModelOpts; model: OpenAITranscriptionModel };
}

export type TranscriptionModelType = keyof TranscriptionModels;

export const transcriptionModel = <T extends TranscriptionModelType>(type: T, opts: TranscriptionModels[T]['opts']): TranscriptionModels[T]['model'] => {
  switch (type) {
    case 'openai':
      return new OpenAITranscriptionModel(opts);
    default:
      throw new Error(`Unsupported transcription model type: ${type}`);
  }
};
