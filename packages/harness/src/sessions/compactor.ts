import { type Logger } from "pinetto";
import { type InitContext, WithContext } from "../context.js";
import { type DB, ensureTrx } from "../database/client.js";
import { selectMessages, insertMessage, updateMessageData, type ASelectableDBMessage } from "../database/tables/messages.js";
import { updateSessionSystemPrompt } from "../database/tables/sessions.js";
import { softPurgeSessionInjections } from "../database/tables/session_injections.js";
import { makeCompactionPrompt } from "../prompts/compaction.js";
import { type AgentBlock, type Message } from "../types/messages.js";
import { type MessageBlock, type TextBlock } from "../types/blocks.js";
import { PROJECT_COMPACTION_OPTS, projectMessages } from "../projection.js";
import { SERIALIZE_COMPACTION_OPTS, serializeMessages } from "../serialization.js";

export interface CompactOpts {
  /** Number of recent messages to keep verbatim (default 20). */
  retain_count?: number;
  /**
   * Flatten media blocks in the retained messages to text markers
   * (default false). See dropMedia().
   */
  drop_media?: boolean;
}

/**
 * Media drop (opt-in compaction policy): the retained tail is the only
 * place media bytes survive a compaction — the to-summarize rows are
 * deleted wholesale and the summary is text. Left in place, each block's
 * base64 rides every future prompt until a later compaction eventually
 * deletes it. Every dropped block becomes a text marker that declares
 * the loss and keeps the content that IS text (caption, transcription),
 * mirroring projection's convention: visible, labelled loss over silent
 * loss. Returns the input message UNCHANGED (same reference) when it
 * carries no media — the compactor uses that identity to rewrite only
 * the rows that actually differ.
 */
export const dropMedia = (message: Message): Message => {
  switch (message.type) {
    case 'notification': {
      const blocks = flattenBlocks(message.blocks);
      return blocks === message.blocks ? message : { ...message, blocks };
    }
    case 'input':
      // Narrow by role so each branch's block family matches its
      // message type — same pattern (and same reason) as projection's
      // projectMessage: a merged spread would force one family across
      // the UserInput | AgentInput union.
      if (message.role === 'agent') {
        const blocks = flattenBlocks(message.blocks);
        return blocks === message.blocks ? message : { ...message, blocks };
      } else {
        const blocks = flattenBlocks(message.blocks);
        return blocks === message.blocks ? message : { ...message, blocks };
      }
    case 'tool_res': {
      let changed = false;
      const results = message.results.map((result) => {
        const blocks = flattenBlocks(result.blocks);
        if (blocks !== result.blocks) changed = true;
        return blocks === result.blocks ? result : { ...result, blocks };
      });
      return changed ? { ...message, results } : message;
    }
    case 'tool_req':
      // Legacy request rows carry no media family (params are opaque
      // JSON) — nothing to drop.
      return message;
  }
};

/**
 * Block-level media flattening. Outputs stay within the input block
 * family's space: pass-through keeps the original block, and every
 * replacement is a TextBlock (a member of both UserBlock and
 * AgentBlock). The cast below bridges only the generic parameter, not
 * the type space — same pattern as projection's projectBlocks.
 */
const flattenBlocks = <B extends MessageBlock>(blocks: readonly B[]): B[] => {
  let changed = false;
  const flat = blocks.map((block): B => {
    switch (block.type) {
      case 'image': {
        changed = true;
        const caption = block.caption ? ` ${block.caption}` : '';
        return { type: 'text', text: `[image dropped at compaction: ${block.mimeType}]${caption}` } as B;
      }
      case 'voice': {
        changed = true;
        return (block.transcription
          ? { type: 'text', text: `[voice note transcript, ${block.duration}s, audio dropped at compaction]: ${block.transcription}` }
          : { type: 'text', text: `[voice note dropped at compaction: ${block.path}, ${block.duration}s]` }) as B;
      }
      default:
        return block;
    }
  });
  return changed ? flat : (blocks as B[]);
};

/**
 * Tiered compaction: summarizes older messages via a dedicated model
 * while retaining recent messages verbatim. Replaces the previous
 * all-or-nothing compaction where I wrote a checkpoint under pressure.
 *
 * Procedure:
 * 1. Select all processed messages for the session
 * 2. Split: messages before the last N get summarized; last N retained
 * 3. (opt-in, drop_media) flatten retained media blocks to text markers
 * 4. Feed to-summarize messages to the compactor model
 * 5. Delete summarized messages, insert the summary, keep retained messages
 */
export class Compactor extends WithContext {

  #logger: Logger;

  constructor(ctx: InitContext) {
    super(ctx);
    this.#logger = ctx.logger.child('[compactor]');
  }

  /**
   * Compact a session: summarize older messages, retain recent ones.
   *
   * @param session_id  The session to compact
   * @param opts  retain_count: recent messages to keep verbatim;
   *              drop_media: flatten retained media blocks to text markers
   * @param db  Database connection (may be a transaction)
   */
  async compact(session_id: number, opts: CompactOpts = {}, db?: DB): Promise<void> {
    const retain_count = opts.retain_count ?? 20;
    await ensureTrx(db ?? this._ctx.db, async (trx) => {
      // Select all processed messages
      const raw_messages = (await selectMessages(trx, {
        session_id,
        unprocessed: 'exclude',
      }));

      if (raw_messages.length <= retain_count) {
        this.#logger.info('session %d has only %d messages, need %d to compact — skipping',
          session_id, raw_messages.length, retain_count);
        return;
      }

      let split_index = raw_messages.length - retain_count;

      // Compaction can never break tool requests away from their results,
      // nor (legacy rows) an agent turn away from its calls. With results
      // grouped in one user message, the pair is (request-holder, next
      // message): a split landing on the results message moves back to the
      // holder — an AgentInput carrying tool_req blocks (native shape) or
      // a standalone tool_req message (legacy). The legacy holder is then
      // kept whole with its own preceding AgentInput: a split between an
      // agent's text and its calls is the mid-turn incoherence this guard
      // exists to prevent (structurally impossible for native rows).
      if (raw_messages[split_index]?.data.type === 'tool_res') {
        split_index -= 1;
        const holder = raw_messages[split_index]?.data;
        const holds_requests = holder?.type === 'tool_req'
          || (holder?.type === 'input' && holder.role === 'agent'
              && holder.blocks.some((b) => b.type === 'tool_req'));
        if (!holds_requests) {
          throw new Error(`invalid tool use request/result pair at index ${split_index}`);
        }
      }
      if (raw_messages[split_index]?.data.type === 'tool_req'
          && raw_messages[split_index - 1]?.data.role === 'agent'
          && raw_messages[split_index - 1]?.data.type === 'input') {
        split_index -= 1;
      }

      const to_summarize = raw_messages.slice(0, split_index);
      const to_retain = raw_messages.slice(split_index);

      this.#logger.info('compacting session %d: %d messages to summarize, %d to retain',
        session_id, to_summarize.length, to_retain.length);

      // Media drop (opt-in): the retained tail is the only place media
      // bytes survive compaction — flatten to text markers NOW, while the
      // history is being rewritten anyway. Rows untouched by the drop
      // keep their data (and their reference) as-is.
      if (opts.drop_media) {
        let dropped = 0;
        for (const row of to_retain) {
          const flat = dropMedia(row.data);
          if (flat !== row.data) {
            await updateMessageData(trx, row.id, flat);
            dropped += 1;
          }
        }
        this.#logger.info('media drop: flattened media in %d retained messages', dropped);
      }

      // Build conversation text for the compactor model
      const projected_messages = projectMessages(to_summarize.map(m => m.data), PROJECT_COMPACTION_OPTS);
      const serialized_messages = serializeMessages(projected_messages, SERIALIZE_COMPACTION_OPTS);

      // Run the compactor model
      const model = this._ctx.managers.models.compaction;
      const system_prompt = makeCompactionPrompt();
      const { messages: res_messages, input_size, output_size } = await model.query({
        messages: [{
          role: 'user',
          type: 'input',
          // The serialization layer wraps the blob in <conversation>
          // tags and escapes tag forgeries in the content.
          blocks: [{ type: 'text', text: serialized_messages }],
        }],
        tools: [],
        session_id: `compactor-${session_id}`,
        system_prompt,
      });

      // Extract the summary text from the model's response
      const summary_text = res_messages
        .flatMap(m => m.type === 'input' ? m.blocks : [])
        .filter((b: AgentBlock) => b.type === 'text')
        .map((b: TextBlock) => b.text)
        .join('\n');

      this.#logger.info('compaction summary: %d chars, input %d tokens, output %d tokens',
        summary_text.length, input_size, output_size);

      // Recollection soft purge: strips belonging to messages that are
      // being summarized away can fire again — the context that held
      // them is gone. Rows injected after the split boundary stay open:
      // the retained tail still carries their content. Rows are marked,
      // never deleted — the history is the future evaluation dataset.
      const boundary = to_summarize[to_summarize.length - 1]?.created_at;
      if (boundary) {
        await softPurgeSessionInjections(trx, {
          session_id,
          before: boundary,
        });
      }

      // Delete the summarized messages (by ID)
      const summarised_ids = to_summarize.map(m => m.id);
      await trx
        .deleteFrom('messages')
        .where('id', 'in', summarised_ids)
        .execute();

      // Regenerate the system prompt for constitutional changes
      const new_system_prompt = await this._ctx.managers.prompts.getSystemPrompt();
      await updateSessionSystemPrompt(trx, session_id, new_system_prompt);

      // Insert the summary message just before the first retained message
      const summary_created_at = new Date(to_retain[0].created_at.getTime() - 1);
      await insertMessage(trx, {
        session_id,
        data: {
          role: 'user',
          type: 'input',
          blocks: [{
            type: 'text',
            text: `[Compaction summary — ${new Date().toISOString()}]\n\n${summary_text}`,
          }],
        },
        created_at: summary_created_at,
        processed_at: summary_created_at,
        role: 'user',
      });

      this.#logger.info('compaction complete for session %d', session_id);
    });
  }

}