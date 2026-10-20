export interface TranscriptionResult {
  text: string;
  /** Language detected by the model, when known (e.g. 'en', 'it'). */
  language?: string;
  /** Wall-clock duration of the transcription request, in ms. */
  duration_ms: number;
}

export abstract class AbstractTranscriptionModel {

  /**
   * Transcribe an audio file at the given filesystem path. The model
   * adapter owns all format conversion — callers pass whatever the
   * pipeline produced (e.g. Telegram OGG/Opus voice notes) and the
   * adapter delivers text or throws.
   */
  abstract transcribe(filePath: string, language?: string): Promise<TranscriptionResult>;

}
