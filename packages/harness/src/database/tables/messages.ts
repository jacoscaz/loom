
import { type GeneratedAlways } from "kysely";
import { type Insertable } from "kysely";
import { type Selectable } from "kysely";
import { type Updateable } from "kysely";
import { type DB, ensureTrx } from "../client.js";
import { type Message } from "../../types/messages.js";
import { sanitizeDeep } from "../../sanitize.js";
import { type SelectableContinuityRecord } from "./continuity_records.js";
import assert from "node:assert";
import { sql } from "kysely";

/**
 * Bounds for the distiller's recency cache (see selectMessagesForDistillation).
 *
 * The distiller once injected EVERY continuity record targeting the session
 * being distilled; under the single-continuous-session model that set grows
 * without bound (Sept 2026: distiller prompts averaged 124k tokens, max 207k,
 * ~92M prompt tokens/month). These caps make the injection bounded by
 * construction. The cache is a partial view BY DESIGN — the distillation
 * prompt mandates a pre-create store query to compensate.
 */
export const DISTILLATION_RECENCY_CACHE_MAX_RECORDS = 40;
export const DISTILLATION_RECENCY_CACHE_MAX_CHARS = 40_000;

export interface ADBMessage {
  id: GeneratedAlways<number>;
  session_id: number;
  created_at: Date;
  processed_at: Date | null;
  distilled_at: Date | null;
  role: 'user' | 'agent';
  data: Message;
}

export type AInsertableDBMessage = Insertable<ADBMessage>;
export type ASelectableDBMessage = Selectable<ADBMessage>;
export type AUpdateableDBMessage = Updateable<ADBMessage>;

/**
 * UTF8 guard: message data reaching JSONB must be free of lone surrogates
 * and NUL code points (see sanitize.ts). Applied at every message write —
 * this function and the activation-loop batch insert below are the only
 * two insert sites in the codebase.
 */
const sanitizeInsertable = <M extends AInsertableDBMessage>(m: M): M => ({ ...m, data: sanitizeDeep(m.data) });

export const insertMessage = async (db: DB, message: AInsertableDBMessage | AInsertableDBMessage[]): Promise<ASelectableDBMessage> => {
  const result = await db.insertInto('messages')
    .values(Array.isArray(message) ? message.map(sanitizeInsertable) : sanitizeInsertable(message))
    .returningAll()
    .executeTakeFirstOrThrow();
  return result;
};

/**
 * Rewrite a message's data in place (row identity — id, created_at,
 * processed_at — preserved). The compactor's media-drop path is the
 * current caller: flattening media blocks in retained rows is a data
 * rewrite, not a delete + reinsert.
 */
export const updateMessageData = async (db: DB, id: number, data: Message): Promise<void> => {
  await db.updateTable('messages')
    .set({ data: sanitizeDeep(data) })
    .where('id', '=', id)
    .execute();
};

export interface ADBSelectMessagesOpts {
  session_id: number;
  unprocessed?: 'include' | 'exclude';
  /** Message role filter; omit for all roles. */
  role?: 'user' | 'agent';
  /** Order direction on (created_at, id); default 'asc'. */
  order?: 'asc' | 'desc';
  /** Row limit; omit for all rows. */
  limit?: number;
}

export const selectMessages = async (db: DB, opts: ADBSelectMessagesOpts): Promise<ASelectableDBMessage[]> => {
  const dir = opts.order ?? 'asc';
  let query = db.selectFrom('messages')
    .orderBy('created_at', dir)
    .orderBy('id', dir);
  if (typeof opts.session_id === 'number') {
    query = query.where('session_id', '=', opts.session_id);
  }
  if (opts.unprocessed !== 'include') {
    query = query.where('processed_at', 'is not', null);
  }
  if (opts.role) {
    query = query.where('role', '=', opts.role);
  }
  if (typeof opts.limit === 'number') {
    query = query.limit(opts.limit);
  }
  return await query.selectAll().execute();
};



export interface ADBDeleteMessagesOpts {
  session_id: number;
  unprocessed?: 'include' | 'exclude';
}

export const deleteMessages = async (db: DB, opts: ADBDeleteMessagesOpts): Promise<void> => {
  let query = db.deleteFrom('messages')
    .where('session_id', '=', opts.session_id);
  if (opts.unprocessed !== 'include') {
    query = query.where('processed_at', 'is not', null);
  }
  await query.execute();
};

/**
 * Calls the provided `handler` function with the entire conversation
 * history of the session if the latter contains unprocessed messages.
 * Persists messages returned by `handler`.
 *
 * This function is meant to be called in a `while()` loop: returns true
 * if execution might have created additional unprocessed messages, false
 * otherwise.
 *
 * This is one of the most critical functions of this entire project, if not
 * _the_ most critical.
 */
export const selectMessagesForActivation = async (db: DB, session_id: number, handler: (messages: ASelectableDBMessage[]) => Promise<AInsertableDBMessage[]>): Promise<boolean> => {
  // Retrieve latest non-processed message
  const not_proc = await db.selectFrom('messages')
    .where('session_id', '=', session_id)
    .where('processed_at', 'is', null)
    .select('id')
    .limit(1)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (!not_proc) {
    // If we do not have any non-processed message for this session we signal
    // that the processing loop can stop.
    return false;
  }
  // Model queries require the entire conversation up to and including all
  // messages yet-to-be processed.
  const old_messages: ASelectableDBMessage[] = await db.selectFrom('messages')
    .where('session_id', '=', session_id)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .selectAll()
    .execute();
  assert(old_messages.length > 0, `inconsistent state: no messages found for session ${session_id} even though there should be at least one unprocessed message`);
  // We pass the conversation to the handler, which will query the model and
  // return new messages.
  const new_messages = await handler(old_messages);
  // The handler returned without errors. We now flag the non-processed
  // messages that were fetched above — and only those — as processed.
  // Messages inserted while the handler was running (e.g. notifications
  // injected mid-generation) must keep processed_at NULL so that the next
  // iteration of the processing loop fetches and delivers them.
  const fetchedUnprocessedIds = old_messages
    .filter(m => m.processed_at === null)
    .map(m => m.id);
  if (fetchedUnprocessedIds.length > 0) {
    await db.updateTable('messages')
      .set({ processed_at: new Date() })
      .where('id', 'in', fetchedUnprocessedIds)
      .execute();
  }
  // Insert new messages returned by the handler.
  if (new_messages.length > 0) {
    await db.insertInto('messages').values(new_messages.map(sanitizeInsertable)).execute();
  }
  // We signal that the processing loop can continue, given we might just
  // have added new non-processed messages. Note that this might have been
  // done outside of this loop (`trx` is passed to `handler()` so that the
  // outcome of MCP calls can be persisted transactionally).
  return true;
};

/**
 * Distillation variant: only passes undistilled messages to the handler,
 * along with existing continuity records for context. The handler is expected
 * to write to continuity_records via MCP tools (using the transactional db
 * handle). Returns a boolean to signal whether messages should be marked as
 * distilled — the handler returns false if there's nothing to distill yet
 * (e.g. all messages are still unprocessed).
 *
 * Like its sibling, meant to be called in a `while()` loop.
 */
export const selectMessagesForDistillation = async (
  db: DB,
  session_id: number,
  handler: (
    undistilled_messages: ASelectableDBMessage[],
    existing_records: SelectableContinuityRecord[],
  ) => Promise<void>,
): Promise<void> => {
  const processed_at_threshold = new Date(Date.now() - 2 * 60 * 1000);

  const undistilled = await db.selectFrom('messages')
    .where('session_id', '=', session_id)
    .where('distilled_at', 'is', null)
    .where('processed_at', 'is not', null)
    .where('processed_at', '<', processed_at_threshold)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .selectAll()
    .execute();

  if (undistilled.length === 0) return;

  // Recency cache, not the store: the distiller prompt must treat what is
  // injected here as a partial view and query the store before any create.
  // Bounding is the fix for unbounded prompt growth — see PR notes.
  const recent_records = await db.selectFrom('continuity_records')
    .where('target_session_id', '=', session_id)
    .where('deleted_at', 'is', null)
    // COALESCE: updated_at is null for never-updated records; last-write-wins
    // recency (creation counts as the first write).
    .orderBy(sql`coalesce(updated_at, created_at) desc`)
    .orderBy('id', 'desc')
    .limit(DISTILLATION_RECENCY_CACHE_MAX_RECORDS)
    .selectAll()
    .execute();

  // Hard token-ish bound: keep the newest records, drop from the tail until
  // the cumulative serialized budget fits (whichever bound binds first).
  const existing_records: SelectableContinuityRecord[] = [];
  let budget = DISTILLATION_RECENCY_CACHE_MAX_CHARS;
  for (const record of recent_records) {
    const cost = (record.title?.length ?? 0) + record.content.length;
    if (existing_records.length > 0 && cost > budget) break;
    existing_records.push(record);
    budget -= cost;
  }

  await handler(undistilled, existing_records);

  await db.updateTable('messages')
    .set({ distilled_at: new Date() })
    .where('session_id', '=', session_id)
    .where('distilled_at', 'is', null)
    .where('processed_at', 'is not', null)
    .where('processed_at', '<', processed_at_threshold)
    .execute();
};
