
import { BaseBlock } from './base.js';
import { DataBlock } from './data.js';

/*
 * ============================================================================
 *                                TOOL BLOCKS
 * ============================================================================
 */

 export interface ToolDeclBlock extends BaseBlock {
   type: 'tool_decl';
   name: string;
   description: string;
   params_schema: any;
 }

export interface ToolCallBlock extends BaseBlock {
  type: 'tool_call';
  call_id: string;
  tool: string;
  params: any;
}

export interface ToolRespBlock extends BaseBlock {
  type: 'tool_resp';
  call_id: string;
  response: DataBlock[];
}
