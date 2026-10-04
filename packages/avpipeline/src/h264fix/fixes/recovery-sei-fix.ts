import { Fix, type ChunkInfo } from './fix';
import type { ChunkBuilder } from '../chunk-builder';

const RECOVERY_POINT_SEI = new Uint8Array([0x06, 0x06, 0x01, 0x84, 0x80]);   // type 6, size 1, recovery_frame_cnt=0, trailing bits

/** A non-IDR key frame without a recovery-point SEI is not accepted by some decoders as a place to start. */
export class RecoverySeiFix extends Fix {
  static override id = 'recoverySei';
  static override title = 'Add recovery-point SEI';
  static override description = 'Inserts a recovery-point SEI before non-IDR key frames that lack one.';

  override finishChunk(chunk: ChunkBuilder, info: ChunkInfo): void {
    if (!info.isKey || info.au.idr || info.au.rp) return;
    chunk.insertBeforePicture(RECOVERY_POINT_SEI);
    this.hit();
  }
  override describe(): string { return this.applied ? `${this.applied} inserted` : ''; }
}
