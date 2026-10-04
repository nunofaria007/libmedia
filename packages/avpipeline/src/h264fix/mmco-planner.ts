import { parseSliceHeader, type MmcoOp, type PpsMap, type SliceHeader } from './slice';
import type { AccessUnit } from './access-unit';
import type { Sps } from './parameter-sets';

/**
 * Simulates the short-term reference picture set from the start point of a stream and works out which
 * memory-management commands (MMCO 1) are invalid because they target pictures that were never decoded.
 * It is run for every picture of the start-up window, whether or not the MMCO fix is enabled, so that invalid
 * commands can be reported; the MMCO fix only decides whether the resulting plan is applied.
 */
export class MmcoPlanner {
  dpb = new Map<number, number>();        // unwrapped frame number -> number of fields/frames held
  U = 0;                                  // unwrapped frame number of the current picture
  prevFrameNum: number | null = null;
  invalid = 0;                            // MMCO-1 commands dropped because their target does not exist
  released = 0;                           // extra release commands added for dropped pictures
  pending = new Set<number>();            // references held by dropped pictures that must be released by the next kept picture
  overflow = false;
  plan = new Map<Uint8Array, MmcoOp[]>(); // slice NAL -> replacement command list

  constructor() { this.reset(); }

  reset(): void {
    this.dpb = new Map();       // unwrapped frame number -> number of fields/frames held
    this.U = 0;                 // unwrapped frame number of the current picture
    this.prevFrameNum = null;
    this.invalid = 0;           // MMCO-1 commands dropped because their target does not exist
    this.released = 0;          // extra release commands added for dropped pictures
    this.pending = new Set();   // references held by dropped pictures that must be released by the next kept picture
    this.overflow = false;
    this.plan = new Map();      // slice NAL -> replacement command list
  }

  /**
   * Processes one access unit. `dropped` pictures are simulated (they leave non-existing frames behind) but are never sent.
   * Returns a Map of slice NAL -> command list for slices whose marking has to be replaced.
   */
  step(au: AccessUnit, sps: Sps, ppsMap: PpsMap, dropped = false): Map<Uint8Array, MmcoOp[]> {
    const plan = this.plan; plan.clear();
    const M = 2 ** sps.log2FrameNum, dpb = this.dpb, X = this.pending;
    const sl = au.nals.filter((n) => { const t = n[0] & 31; return t === 1 || t === 5; });
    let hs: SliceHeader[];
    try { hs = sl.map((n) => parseSliceHeader(n, sps, ppsMap)); } catch (e) { return plan; }
    const f = hs[0].fnum;
    this.U = this.prevFrameNum === null ? f : this.U + (f - this.prevFrameNum + M) % M;
    this.prevFrameNum = f;
    const U = this.U;
    let second = hs.length;
    for (let k = 1; k < hs.length; k++) if (hs[k].first === 0) { second = k; break; }
    const extras: number[] = [];
    if (!dropped && X.size && hs.some((h) => h.mmS >= 0 && h.nt !== 5)) {
      for (const ut of X) { const dU = U - ut; if (dU > 0 && dU < M / 2) extras.push(dU); }
      if (dpb.size + X.size > Math.max(sps.numRefFrames, 1)) this.overflow = true;
      this.released += extras.length; X.clear();
    }
    const extraOps = (h: SliceHeader): MmcoOp[] => {
      const o: MmcoOp[] = [];
      for (const dU of extras) { if (h.field) o.push({ op: 1, a: 2 * dU }, { op: 1, a: 2 * dU - 1 }); else o.push({ op: 1, a: dU - 1 }); }
      return o;
    };
    hs.forEach((h, k) => {
      if (h.mmS < 0) return;
      if (h.nt === 5) dpb.clear();
      const ex = (extras.length && k < second && h.nt !== 5) ? extraOps(h) : [];
      if (h.adapt) {
        const keep: MmcoOp[] = [];
        const opsS = h.opsS ?? [];
        for (const o of opsS) {
          if (o.op === 1) {
            const cur = h.field ? 2 * f + 1 : f;
            const x = cur - ((o.a ?? 0) + 1);
            const ut = U + (h.field ? Math.floor(x / 2) : x) - f;
            const left = dpb.get(ut);
            if (!left) { this.invalid++; continue; }
            if (h.field && left > 1) dpb.set(ut, left - 1); else { dpb.delete(ut); if (dropped) X.add(ut); }
          }
          keep.push(o);
        }
        if (ex.length || keep.length !== opsS.length) plan.set(sl[k], [...keep.filter((o) => o.op !== 0), ...ex, { op: 0 }]);
      } else if ((k === 0 || !h.field) && h.nt !== 5 && dpb.size >= Math.max(sps.numRefFrames, 1)) {
        let min = Infinity; for (const u of dpb.keys()) min = Math.min(min, u);
        dpb.delete(min);
        if (ex.length) {
          const dU = U - min;
          const v: MmcoOp[] = h.field ? [{ op: 1, a: 2 * dU }, { op: 1, a: 2 * dU - 1 }] : [{ op: 1, a: dU - 1 }];
          plan.set(sl[k], [...v, ...ex, { op: 0 }]);
        }
      } else if (ex.length) plan.set(sl[k], [...ex, { op: 0 }]);
      dpb.set(U, h.field ? (dpb.get(U) || 0) + 1 : 2);
    });
    return plan;
  }
}
