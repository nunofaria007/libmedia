import { Fix, type ChunkInfo } from './fix';
import type { ChunkBuilder } from '../chunk-builder';
import type { FixPipeline } from '../pipeline';

/** The decoder is configured from in-band parameter sets, so key frames that lack them get the last known SPS/PPS prepended. */
export class ParameterSetFix extends Fix {
  static override id = 'paramSets';
  static override title = 'Re-insert SPS/PPS before key frames';
  static override description = 'Prepends the last known SPS/PPS to the start picture and to non-IDR key frames that do not carry them.';

  override finishChunk(chunk: ChunkBuilder, info: ChunkInfo, pipeline: FixPipeline): void {
    if (!info.needParams) return;
    const ins: Uint8Array[] = [];
    if (!chunk.hasSps && pipeline.sps) ins.push(pipeline.sps);
    if (!chunk.hasPps && pipeline.pps) ins.push(pipeline.pps);
    if (!ins.length) return;
    chunk.insertParameterSets(ins);
    this.hit(ins.length);
  }
  override describe(): string { return this.applied ? `${this.applied} inserted` : ''; }
}
