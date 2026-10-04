import { Fix } from './fix';
import { nalType } from '../bits';
import type { AccessUnit } from '../access-unit';

/** Field-coded pictures arrive as two access units (top and bottom field). Decoders want them as one frame. */
export class FieldPairingFix extends Fix {
  static override id = 'fieldPair';
  static override title = 'Pair field pictures into frames';
  static override description = 'Merges the two fields of a field-coded frame into one chunk before decoding.';

  override tryPair(held: AccessUnit | null, next: AccessUnit): AccessUnit | null {
    if (!this.enabled || !held || !held.field || !next.field) return null;
    if (held.bottom === next.bottom || held.frameNum !== next.frameNum) return null;
    this.hit();
    return held.withNals([...held.nals, ...next.nals.filter((n) => nalType(n) !== 9)]);
  }
  override describe(): string { return this.applied ? `${this.applied} pairs` : ''; }
}
