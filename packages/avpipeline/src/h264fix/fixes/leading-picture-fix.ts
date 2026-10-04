import { Fix } from './fix';

/** After an open-GOP start, B-pictures that precede the I-frame in display order reference frames the decoder never saw. */
export class LeadingPictureFix extends Fix {
  static override id = 'dropLeading';
  static override title = 'Drop leading pictures';
  static override description = 'Discards pictures after an open-GOP start that display before the start frame and need earlier references.';

  override dropIfLeading(): boolean {
    if (!this.enabled) return false;
    this.hit();
    return true;
  }
  override describe(): string { return this.applied ? `${this.applied} dropped` : ''; }
}
