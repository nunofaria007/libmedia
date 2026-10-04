import { Fix, type SliceContext, type SliceEditRequest } from './fix';
import type { FixPipeline } from '../pipeline';

/**
 * Makes the first (non-IDR) I-frame an IDR picture and renumbers frame_num / POC of the pictures that follow, until a real IDR
 * arrives. Browser decoders refuse to start (or output frames) on a stream that does not begin with an IDR.
 */
export class IdrConversionFix extends Fix {
  private warned = false;

  static override id = 'idrConvert';
  static override title = 'Convert start to IDR, rebase frame_num/POC';
  static override description = 'Rewrites the first I-frame as an IDR picture and renumbers following pictures until the first real IDR.';

  override editSlice(slice: SliceContext, edit: SliceEditRequest, pipeline: FixPipeline): void {
    const c = pipeline.ctx;
    if (!c.window) return;
    if (!c.canConvertIdr) {
      if (!this.warned) { this.warned = true; pipeline.log('IDR conversion skipped: the start picture is not a reference picture.'); }
      return;
    }
    edit.dFn = c.startFrameNum;
    edit.dLsb = pipeline.spsInfo?.pocType === 0 ? c.startLsb : 0;
    edit.by.add(this);
    // every slice of the start picture becomes IDR (for a field pair: the first field only, the second stays a non-IDR field)
    if (slice.startPicture) { edit.makeIdr = true; edit.marking = 'idr'; }
  }
  override describe(): string { return this.applied ? `start converted, ${this.applied} slices rebased` : ''; }
}
