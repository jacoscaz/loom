
import type { GeneratedAlways, Insertable, Selectable } from "kysely";
import { sql } from "kysely";
import type { Block, Message } from "@loom/proto";
import { type DB, ensureTrx } from "../client.js";
import { ensureSession } from "./sessions.js";

export interface DBMessage {
  id: GeneratedAlways<number>;
  session_id: string;
  created_at: Date;
  /**
   * When the message was fed to the model. NULL marks messages the agent
   * has yet to process: incoming envelopes and tool responses.
   */
  processed_at: Date | null;
  role: Message['role'];
  blocks: Block[];
}

export type InsertableDBMessage = Insertable<DBMessage>;
export type SelectableDBMessage = Selectable<DBMessage>;

export const toMessage = (row: Pick<SelectableDBMessage, 'role' | 'blocks'>): Message => ({
  role: row.role,
  blocks: row.blocks,
});

/**
 * Persists an incoming (unprocessed) user message, creating the session if
 * needed. Once this resolves the message is durable.
 */
export const insertIncomingMessage = async (db: DB, session_id: string, blocks: Block[]): Promise<void> => {
  await ensureTrx(db, async (trx) => {
    await ensureSession(trx, session_id);
    await trx.insertInto('messages')
      .values({ session_id, created_at: new Date(), processed_at: null, role: 'user', blocks })
      .execute();
  });
};

/**
 * A session's history in the order the model saw it: processed messages by
 * processing time, then the unprocessed ones. Ordering by processing time
 * rather than by arrival keeps envelopes that arrive while the model is
 * busy after the model's response instead of before it, which would both
 * misrepresent the conversation and split tool calls from their responses.
 * Within one activation (same processed_at) insertion order wins.
 */
export const selectHistory = async (db: DB, session_id: string): Promise<SelectableDBMessage[]> => {
  return await db.selectFrom('messages')
    .where('session_id', '=', session_id)
    .orderBy(sql`processed_at asc nulls last`)
    .orderBy('id', 'asc')
    .selectAll()
    .execute();
};

export interface ActivationOutput {
  message: Message;
  /**
   * False for messages the model must still see, i.e. tool responses: they
   * trigger the next activation.
   */
  processed: boolean;
}

/**
 * Calls the provided `handler` function with the entire conversation
 * history of the session if the latter contains unprocessed messages.
 * Persists the messages returned by `handler`.
 *
 * Meant to be called in a `while()` loop: returns true if execution might
 * have created additional unprocessed messages, false otherwise. If the
 * handler throws nothing is persisted and the unprocessed messages remain
 * so, to be picked up by a later activation.
 */
export const selectMessagesForActivation = async (
  db: DB,
  session_id: string,
  handler: (history: Message[]) => Promise<ActivationOutput[]>,
): Promise<boolean> => {
  const history = await selectHistory(db, session_id);
  // Only the messages fetched here, and not those inserted while the
  // handler is running (e.g. envelopes arriving mid-generation), are
  // flagged as processed below.
  const unprocessed_ids = history.filter(m => m.processed_at === null).map(m => m.id);
  if (unprocessed_ids.length === 0) {
    return false;
  }
  const output = await handler(history.map(toMessage));
  await ensureTrx(db, async (trx) => {
    // now() is constant within a transaction: the fetched messages and the
    // processed outputs share one processed_at and are ordered by id.
    await trx.updateTable('messages')
      .set({ processed_at: sql`now()` })
      .where('id', 'in', unprocessed_ids)
      .execute();
    if (output.length > 0) {
      await trx.insertInto('messages')
        .values(output.map(({ message, processed }) => ({
          session_id,
          created_at: sql<Date>`now()`,
          processed_at: processed ? sql<Date>`now()` : null,
          role: message.role,
          blocks: message.blocks,
        })))
        .execute();
    }
  });
  return true;
};
