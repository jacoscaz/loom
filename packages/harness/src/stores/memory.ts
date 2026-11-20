
import type { Block, Message } from "@loom/proto";
import type { ActivationOutput } from "../database/tables/messages.js";
import type { HistoryStore } from "./store.js";
import { decodeJson, encodeJson } from "../database/json.js";

/** Same round trip as through a jsonb column (keeps Buffers as Buffers). */
const clone = <T>(value: T): T => decodeJson(encodeJson(value));

interface Row {
  id: number;
  session: string;
  /** Activation counter value; null while unprocessed. */
  processed_at: number | null;
  message: Message;
}

/**
 * In-memory HistoryStore with the same ordering semantics as the database
 * one. Used in tests.
 */
export class MemoryHistoryStore implements HistoryStore {

  #rows: Row[] = [];
  #next_id = 1;
  #clock = 0;

  async appendIncoming(session: string, blocks: Block[]): Promise<void> {
    this.#rows.push({ id: this.#next_id++, session, processed_at: null, message: clone({ role: 'user', blocks }) });
  }

  #sorted(session: string): Row[] {
    return this.#rows
      .filter(r => r.session === session)
      .sort((a, b) => {
        if (a.processed_at !== b.processed_at) {
          if (a.processed_at === null) return 1;
          if (b.processed_at === null) return -1;
          return a.processed_at - b.processed_at;
        }
        return a.id - b.id;
      });
  }

  async activate(session: string, handler: (history: Message[]) => Promise<ActivationOutput[]>): Promise<boolean> {
    const rows = this.#sorted(session);
    const unprocessed = rows.filter(r => r.processed_at === null);
    if (unprocessed.length === 0) {
      return false;
    }
    const output = await handler(clone(rows.map(r => r.message)));
    const now = ++this.#clock;
    unprocessed.forEach(r => { r.processed_at = now; });
    for (const { message, processed } of output) {
      this.#rows.push({ id: this.#next_id++, session, processed_at: processed ? now : null, message: clone(message) });
    }
    return true;
  }

  async history(session: string): Promise<Message[]> {
    return clone(this.#sorted(session).map(r => r.message));
  }

  async pendingSessions(): Promise<string[]> {
    return Array.from(new Set(this.#rows.filter(r => r.processed_at === null).map(r => r.session)));
  }

}
