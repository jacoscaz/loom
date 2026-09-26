
export interface BaseBlock {
  type: string;
}

export interface TextBlock extends BaseBlock {
  type: 'text';
  text: string;
  synthesis?: string;
}

/**
 * An image content block within a tool result. Data is base64-encoded
 * (no data-URL prefix) and has been normalized by the producing tool
 * (resize + recompress via sharp) to bound context cost.
 *
 * NOTE: image content is opaque to regex-based injection guardrails.
 * Attacks can render instructions as pixels; semantic filtering of images
 * is future work (embedding/multimodal guard layer).
 */

export interface ImageBlock extends BaseBlock {
  type: 'image';
  mimeType: string;
  data: string;
  caption?: string;
}

export interface VoiceBlock extends BaseBlock {
  type: 'voice';
  path: string;
  mimeType: string;
  duration: number;
  transcription?: string;
  /**
   * Wire-ready audio (base64), inlined at ingest — wav 16k mono, the
   * speech-model lingua franca. Mirrors ImageBlock durability: `path`
   * points at a temp file that expires; the block replays for as long
   * as history does, so the bytes live HERE. Optional: conversion
   * failure degrades to transcript-only, loudly in logs.
   */
  data?: string;
  /** Format of `data` for the wire (input_audio.format). */
  dataFormat?: 'wav' | 'mp3';
}

export type ContentBlock = TextBlock | ImageBlock | VoiceBlock;

export interface RefusalBlock extends BaseBlock {
  type: 'refusal';
  text: string;
}

export interface ThinkingRedactedBlock extends BaseBlock {
  type: 'thinking_redacted';
  text: string;
}

export interface ThinkingBlock extends BaseBlock {
  type: 'thinking';
  text: string;
  anthropic_signature?: string;
}

export interface UnsupportedBlock extends BaseBlock {
  type: 'unsupported';
  text: string;
}

export type MessageBlock =
  | TextBlock
  | ImageBlock
  | VoiceBlock
  | RefusalBlock
  // | ToolUseRequestBlock
  // | ToolUseResultBlock
  // | ToolUseErrorBlock
  | ThinkingBlock
  | ThinkingRedactedBlock
  | UnsupportedBlock
  ;
