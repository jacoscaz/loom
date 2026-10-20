import type Anthropic from '@anthropic-ai/sdk';
import type { Block, Message } from "@loom/proto";
import { textBlock, unsupportedBlock } from "../shared.js";

/**
 * One Anthropic response maps to ONE agent message whose blocks preserve
 * the response's grouping — text/thinking blocks plus one tool_call block
 * per tool_use.
 *
 * Thinking blocks keep their signature (`anthropic_signature`) so the
 * formatter can replay them when replay_thinking is enabled.
 */
export const parseMessage = (message: Anthropic.Message): Message[] => {
  const blocks: Block[] = [];
  for (const block of message.content ?? []) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) {
          blocks.push(textBlock(block.text));
        }
        break;
      case 'thinking':
        blocks.push({ type: 'thinking', text: block.thinking, anthropic_signature: block.signature });
        break;
      case 'redacted_thinking':
        blocks.push({ type: 'thinking_redacted', text: '' });
        break;
      case 'tool_use':
        blocks.push({
          type: 'tool_call',
          call_id: block.id,
          tool: block.name,
          params: block.input as Record<string, unknown>,
        });
        break;
      default:
        // Server-side tool use, web search results, code-execution
        // results, ... — anything this adapter did not request and
        // cannot represent is captured loudly instead of dropped.
        blocks.push(unsupportedBlock(`content block: ${block.type}`, block));
        break;
    }
  }
  return blocks.length > 0 ? [{ role: 'agent', blocks }] : [];
};
