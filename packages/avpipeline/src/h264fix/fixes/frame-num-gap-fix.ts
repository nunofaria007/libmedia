import { Fix, type ChunkInfo } from './fix';
import type { ChunkBuilder } from '../chunk-builder';
import type { FixPipeline } from '../pipeline';
import { patchSpsGapFlag } from '../parameter-sets';

/**
 * Dropped leading pictures can be reference pictures, which leaves a hole in frame_num. With
 * gaps_in_frame_num_value_allowed_flag=1 the decoder fills the hole with "non-existing" frames instead of failing.
 * Applied to every SPS of a chunk (also one inserted by the parameter-set fix, which therefore runs first).
 */
export class FrameNumGapFix extends Fix {
  static override id = 'gapSps';
  static override title = 'Allow frame_num gaps (SPS patch)';
  static override description = 'Sets gaps_in_frame_num_value_allowed_flag in the SPS of streams that started on an open GOP.';

  override finishChunk(chunk: ChunkBuilder, _info: ChunkInfo, pipeline: FixPipeline): void {
    if (!pipeline.ctx.open) return;
    chunk.mapType(7, (n) => {
      const p = patchSpsGapFlag(n);
      if (p !== n) this.hit();
      return p;
    });
  }
  override describe(): string { return this.applied ? `${this.applied} SPS patched` : ''; }
}
