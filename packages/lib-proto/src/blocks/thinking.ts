
import { BaseBlock } from './base.js';

export interface ThinkingRedactedBlock extends BaseBlock {
  type: 'thinking_redacted';
  text: string;
}

export interface ThinkingBlock extends BaseBlock {
  type: 'thinking';
  text: string;
  anthropic_signature?: string;
}
