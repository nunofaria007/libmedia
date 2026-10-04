import { Fix, type SliceContext, type SliceEditRequest } from './fix';
import type { FixPipeline } from '../pipeline';

/** Replaces reference-marking commands that point at pictures the decoder never saw (they make decoders error out). */
export class MmcoFix extends Fix {
  static override id = 'mmco';
  static override title = 'Prune / repair MMCO commands';
  static override description = 'Removes invalid memory-management commands and releases frames left behind by dropped pictures.';

  override editSlice(slice: SliceContext, edit: SliceEditRequest, pipeline: FixPipeline): void {
    if (!pipeline.ctx.window || !slice.plan || edit.marking === 'idr') return;
    const ops = slice.plan.get(slice.nal);
    if (!ops) return;
    edit.marking = ops;
    edit.by.add(this);
  }
  override describe(): string { return this.applied ? `${this.applied} slices rewritten` : ''; }
}
