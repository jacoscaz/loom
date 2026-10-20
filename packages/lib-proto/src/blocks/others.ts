
import { BaseBlock } from "./base.js";

export interface RefusalBlock extends BaseBlock {
  type: 'refusal';
  reason: string;
}
