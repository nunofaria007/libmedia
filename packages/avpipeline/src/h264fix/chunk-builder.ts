import { START_CODE, nalType, concat } from './bits';

/**
 * The NAL units of one decoder chunk, in stream order. Nothing is reordered: fixes only replace a NAL in place or insert one,
 * so a chunk that no fix touches is byte-for-byte what the stream carried (plus start codes).
 */
export class ChunkBuilder {
  nals: Uint8Array[];
  constructor(nals: Uint8Array[]) { this.nals = nals.slice(); }

  get hasSps(): boolean { return this.nals.some((n) => nalType(n) === 7); }
  get hasPps(): boolean { return this.nals.some((n) => nalType(n) === 8); }

  /** Replaces every NAL of `type` with fn(nal); fn returns its argument unchanged for "no edit". */
  mapType(type: number, fn: (nal: Uint8Array) => Uint8Array): void { this.nals = this.nals.map((n) => (nalType(n) === type ? fn(n) : n)); }

  /** Puts parameter sets in front of everything except the access unit delimiter(s). */
  insertParameterSets(list: Uint8Array[]): void {
    let i = 0;
    while (i < this.nals.length && nalType(this.nals[i]) === 9) i++;
    this.nals.splice(i, 0, ...list);
  }

  /** Puts a NAL after the leading AUD / SPS / PPS run, i.e. before SEI messages and slices. */
  insertBeforePicture(nal: Uint8Array): void {
    let i = 0;
    while (i < this.nals.length) { const t = nalType(this.nals[i]); if (t !== 9 && t !== 7 && t !== 8) break; i++; }
    this.nals.splice(i, 0, nal);
  }

  /** Annex B bytes (4-byte start codes). */
  toBytes(): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const n of this.nals) parts.push(START_CODE, n);
    return concat(parts);
  }
}
