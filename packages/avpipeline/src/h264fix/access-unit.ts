import { nalType } from './bits';
import { hasRecoverySei, sliceInfo } from './slice';

export type Nal = Uint8Array;

/** One coded picture (or field): its NAL units plus what the stream layer knows about it. */
export class AccessUnit {
  nals: Nal[] = [];
  vcl = false;
  idr = false;
  isI = false;                       // first slice is I/SI
  rp = false;                        // carries a recovery-point SEI
  pts: number | undefined = undefined;   // 90 kHz PES timestamp
  vclNal: Nal | null = null;         // first slice NAL
  field = 0; bottom = 0; frameNum = 0;   // filled in by FixPipeline
  /** True for access units made by `withNals` (merged fields, rewritten slices): their NAL list is not what the stream carried. */
  rewritten = false;

  get isKey(): boolean { return this.idr || this.isI; }
  /** Copy with a different NAL list (access units are never modified in place by the pipeline). */
  withNals(nals: Nal[]): AccessUnit {
    const a = Object.assign(new AccessUnit(), this);
    a.nals = nals;
    a.rewritten = true;
    return a;
  }
}

/** Groups a stream of NAL units into access units. Each NAL may carry the PTS of the PES packet it started in. */
export class AccessUnitGrouper {
  private cur: AccessUnit | null = null;
  constructor(private readonly onUnit: (au: AccessUnit) => void) {}
  add(nal: Nal, pts?: number): void {
    const t = nalType(nal), isVcl = t === 1 || t === 5;
    const first = isVcl ? sliceInfo(nal).first === 0 : false;
    if (!this.cur || (this.cur.vcl && (t === 9 || t === 6 || t === 7 || t === 8 || (isVcl && first)))) {
      if (this.cur && this.cur.vcl) this.onUnit(this.cur);
      this.cur = new AccessUnit();
    }
    const cur = this.cur;
    cur.nals.push(nal);
    if (pts !== undefined && cur.pts === undefined) cur.pts = pts;
    if (t === 6 && hasRecoverySei(nal)) cur.rp = true;
    if (isVcl && !cur.vcl) {
      cur.vcl = true; cur.vclNal = nal; cur.idr = t === 5;
      const si = sliceInfo(nal);
      cur.isI = si.type === 2 || si.type === 4;
    }
  }
  flush(): void { if (this.cur && this.cur.vcl) this.onUnit(this.cur); this.cur = null; }
}
