
import { BaseBlock } from './base.js';

/*
 * ============================================================================
 *                              CONTENT BLOCKS
 * ============================================================================
 */

export interface BaseDataBlock<T> extends BaseBlock {
  type: 'data';
  mime: string;
  data?: T;
  url?: string;
}

export interface TextBlock extends BaseDataBlock<string> {
  mime: 'text/plain';
  synthesis?: string;
}

export interface ImageBlock extends BaseDataBlock<Buffer> {
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  caption?: TextBlock;
  synthesis?: string;
}

export interface AudioBlock extends BaseDataBlock<Buffer> {
  mime: 'audio/ogg' | 'audio/wav' | 'audio/mpeg' | 'audio/vorbis' | 'audio/mp3';
  duration?: number;
  transcription?: TextBlock;
}

export type DataBlock = TextBlock | ImageBlock | AudioBlock;

export const isTextBlock = (block: DataBlock): block is TextBlock => {
  return block.mime === 'text/plain';
};

export const isImageBlock = (block: DataBlock): block is ImageBlock => {
  return block.mime.startsWith('image/');
};

export const isAudioBlock = (block: DataBlock): block is AudioBlock => {
  return block.mime.startsWith('audio/');
};
