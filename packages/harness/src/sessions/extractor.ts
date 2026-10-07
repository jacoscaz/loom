import { type AbstractSessionModel } from "../models/session/abstract.js";
import { type Logger } from "pinetto";
import { errToString } from "@loom/utils";
import { EXTRACTION_SYSTEM_PROMPT } from "../prompts/extractor.js";

/**
 * Recollection query gate + contextual subject extraction (phase I.5,
 * design Note #2967).
 *
 * One call classifies the message's conversational role AND extracts the
 * subjects worth querying. The intelligence is in the extraction —
 * "which client operates in the energy sector?" names no entity — while
 * the gate itself is bookkeeping: elaborations, acknowledgments and
 * meta-discussion do not trigger queries even when subjects are present.
 *
 * The extractor sees only the message text, which the session model
 * already receives in full; same provider, zero new data flows.
 */

export interface ExtractionResult {
  query_worthy: boolean;
  subjects: string[];
}


/** Parse the model output into an ExtractionResult; null when the output
 *  is not a well-formed result (caller records a gated-out and injects nothing). */
export const parseExtraction = (text: string): ExtractionResult | null => {
  // Tolerate JSON fenced in prose or code fences: take the first {...} block.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed.query_worthy !== 'boolean') return null;
  if (!Array.isArray(parsed.subjects) || parsed.subjects.some((s: any) => typeof s !== 'string')) return null;
  return {
    query_worthy: parsed.query_worthy,
    subjects: (parsed.subjects as any[])
      .slice(0, 3)
      .map((s: any) => String(s).trim())
      .filter((s: string) => s.length > 0),
  };
};

/** Run the extractor. Returns null on timeout, transport or parse failure —
 *  the caller gates out silently (NO raw-message fallback: deliberate, per
 *  the PR #42 review round — grounding remains the agent's conscious work).
 *  Never throws. */
export const runExtractor = async (
  model: AbstractSessionModel,
  message_text: string,
  logger: Logger,
): Promise<ExtractionResult | null> => {
  try {
    const { messages: res_messages } = await model.query({
      messages: [{
        role: 'user',
        type: 'input',
        blocks: [{ type: 'text', text: message_text }],
      }],
      tools: [],
      session_id: 'recollection-extractor',
      system_prompt: EXTRACTION_SYSTEM_PROMPT,
    });
    const text = res_messages
      .flatMap(m => m.type === 'input' ? m.blocks : [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => String((b as any).text ?? ''))
      .join('\n');
    const result = parseExtraction(text);
    if (!result) {
      logger.warn('extractor returned unparseable output (%d chars) — falling back', text.length);
    }
    return result;
  } catch (err: any) {
    logger.warn('extractor call failed: %s — falling back', errToString(err));
    return null;
  }
};
