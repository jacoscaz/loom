
import { BaseBlock } from "../blocks/base.js";
import { Block } from "../blocks/index.js";
import { DataBlock } from "../blocks/data.js";

export interface BaseEnvelopeBlock<T extends Block> extends BaseBlock {
  type: 'envelope';
  kind: string;
  blocks: T[];
}

export interface MessageEnvelopeBlock extends BaseEnvelopeBlock<DataBlock> {
  kind: 'message';
  /**
   * The sender of the message. This MUST be a valid URL with a
   * transport-specific scheme such as:
   *
   * - mailto:user@example.com
   * - telegram:0000000000
   */
  from: string;
}

export type EnvelopeBlock = MessageEnvelopeBlock;
