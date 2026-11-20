
import type { Block, Message } from "@loom/proto";
import type { DB } from "../database/client.js";
import {
  type ActivationOutput,
  insertIncomingMessage,
  selectHistory,
  selectMessagesForActivation,
  toMessage,
} from "../database/tables/messages.js";
import { selectSessionsWithUnprocessedMessages } from "../database/tables/sessions.js";
import type { HistoryStore } from "./store.js";

/** HistoryStore backed by Postgres via the Kysely query functions. */
export class DatabaseHistoryStore implements HistoryStore {

  #db: DB;

  constructor(db: DB) {
    this.#db = db;
  }

  appendIncoming(session: string, blocks: Block[]): Promise<void> {
    return insertIncomingMessage(this.#db, session, blocks);
  }

  activate(session: string, handler: (history: Message[]) => Promise<ActivationOutput[]>): Promise<boolean> {
    return selectMessagesForActivation(this.#db, session, handler);
  }

  async history(session: string): Promise<Message[]> {
    return (await selectHistory(this.#db, session)).map(toMessage);
  }

  pendingSessions(): Promise<string[]> {
    return selectSessionsWithUnprocessedMessages(this.#db);
  }

}
