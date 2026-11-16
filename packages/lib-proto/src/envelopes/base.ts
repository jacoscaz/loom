
import { BaseBlock } from "../blocks/base.js";
import { Block } from "../blocks/index.js";

export interface BaseEnvelope<T extends Block> extends BaseBlock {
  type: string;
  blocks: T[];
}
