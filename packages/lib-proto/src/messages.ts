import type { Block } from "./blocks/index.js";

/**
 * A conversation message: an ordered list of blocks attributed to a role.
 *
 * Everything that used to be a distinct message type is a block here:
 * tool calls ride in agent messages, tool responses and incoming
 * envelopes in user messages.
 */
export interface Message {
  role: 'user' | 'agent';
  blocks: Block[];
}
