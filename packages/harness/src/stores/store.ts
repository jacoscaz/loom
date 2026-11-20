
import type { Block, Message } from "@loom/proto";

import type { ActivationOutput } from "../database/tables/messages.js";

/**
 * Persistent conversation history, organized by session.
 *
 * Messages are either processed (already fed to the model) or unprocessed
 * (incoming envelopes, tool responses). The history is ordered as the
 * model saw it: processed messages in processing order, then unprocessed
 * messages in arrival order.
 */
export interface HistoryStore {
  /** Durably records an incoming user message as unprocessed. */
  appendIncoming(session: string, blocks: Block[]): Promise<void>;
  /**
   * If the session has unprocessed messages, passes its whole history to
   * `handler`, then marks those messages as processed and stores the
   * handler's output. Returns false when there was nothing to process.
   * If `handler` throws, nothing changes.
   */
  activate(session: string, handler: (history: Message[]) => Promise<ActivationOutput[]>): Promise<boolean>;
  /** The full history of a session, in model order. */
  history(session: string): Promise<Message[]>;
  /** Sessions with unprocessed messages, e.g. left over by a crash. */
  pendingSessions(): Promise<string[]>;
}
