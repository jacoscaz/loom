
import type { Insertable, Selectable } from "kysely";
import type { DB } from "../client.js";

export interface DBSession {
  /** Session id as found in envelopes, e.g. `telegram:<chat_id>`. */
  id: string;
  created_at: Date;
}

export type InsertableSession = Insertable<DBSession>;
export type SelectableSession = Selectable<DBSession>;

/** Creates the session if it does not exist yet. */
export const ensureSession = async (db: DB, id: string): Promise<void> => {
  await db.insertInto('sessions')
    .values({ id, created_at: new Date() })
    .onConflict(oc => oc.column('id').doNothing())
    .execute();
};

export const selectSessions = async (db: DB): Promise<SelectableSession[]> => {
  return await db.selectFrom('sessions')
    .orderBy('created_at', 'asc')
    .selectAll()
    .execute();
};

/** Ids of the sessions that have at least one unprocessed message. */
export const selectSessionsWithUnprocessedMessages = async (db: DB): Promise<string[]> => {
  const rows = await db.selectFrom('messages')
    .where('processed_at', 'is', null)
    .select('session_id')
    .distinct()
    .execute();
  return rows.map(r => r.session_id);
};
