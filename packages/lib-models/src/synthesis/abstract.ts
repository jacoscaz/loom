export interface SynthesisResult {
  /** Absolute path of the written audio file. */
  path: string;
  /** Audio duration in seconds, as reported/derived by the adapter. */
  duration: number;
  /** Audio format/extension actually produced (e.g. 'wav', 'mp3'). */
  format: string;
  /** Voice id used (e.g. 'bm_fable'), when the adapter knows it. */
  voice?: string;
}

/**
 * Adapters own all format details — callers pass text and receive a file
 * on disk plus its duration. An adapter that cannot determine the
 * duration must throw rather than return a duration-less result.
 */
export abstract class AbstractSynthesisModel {

  /**
   * Synthesize speech. `out_path` is allocated by the caller (expiration
   * policy belongs where the knowledge lives); adapters write the audio
   * there, or to a temporary path when omitted.
   */
  abstract synthesize(text: string, out_path?: string): Promise<SynthesisResult>;

}
