import { nalType } from './bits';
import { parseSps, parsePps, avcCodecString, type Sps, type Pps } from './parameter-sets';
import { parseSliceHeader, peekFieldInfo, pocLsbOf, rewriteSlice, sliceInfo, type MmcoOp, type PpsMap } from './slice';
import type { AccessUnit } from './access-unit';
import type { Fix, FixState, ChunkInfo, SliceContext, SliceEditRequest } from './fixes/fix';
import { MmcoPlanner } from './mmco-planner';
import { ChunkBuilder } from './chunk-builder';
import { StreamReport, type StreamReportData } from './stream-report';
import { FieldPairingFix } from './fixes/field-pairing-fix';
import { LeadingPictureFix } from './fixes/leading-picture-fix';
import { IdrConversionFix } from './fixes/idr-conversion-fix';
import { MmcoFix } from './fixes/mmco-fix';
import { FrameNumGapFix } from './fixes/frame-num-gap-fix';
import { ParameterSetFix } from './fixes/parameter-set-fix';
import { RecoverySeiFix } from './fixes/recovery-sei-fix';

/**
 * All fixes, in the order they take part in processing. ParameterSetFix comes before FrameNumGapFix so that a SPS it
 * inserts is patched too.
 */
export interface FixClass {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  new (options?: { enabled?: boolean }): Fix;
}

export const FIX_CLASSES: FixClass[] = [FieldPairingFix, LeadingPictureFix, IdrConversionFix, MmcoFix, ParameterSetFix, FrameNumGapFix, RecoverySeiFix];

/** State that belongs to one start of decoding (it is reset when decoding restarts at a later key frame). */
export class StartContext {
  started = false;
  open = false;            // the start picture was a non-IDR I-frame
  window = false;          // open start and no IDR seen yet: start-up repairs are in effect
  leading = false;         // still looking for leading pictures
  startAU: AccessUnit | null = null;
  startFrameNum = 0;
  startLsb = 0;
  canConvertIdr = true;
}

/** A decoder-ready chunk, delivered through `onUnit`. */
export interface OutputChunk {
  data: Uint8Array;        // Annex B, 4-byte start codes
  key: boolean;
  idr: boolean;
  pts: number | undefined; // 90 kHz
  au: AccessUnit;
  /** False when `data` carries exactly the NAL units of the input (the caller may keep its original bytes); true after pairing, rewriting or inserting NALs. */
  changed: boolean;
}

export interface StartInfo {
  codec: string;
  interlaced: boolean;
  open: boolean;
  idr: boolean;
  pts: number | undefined;
  restart: boolean;
}

export interface PipelineOptions {
  /** { fixId: true } for the fixes to apply; fixes not listed are off. */
  fixes?: Record<string, boolean>;
  log?: (message: string) => void;
  onStart?: (info: StartInfo) => void;
  onUnit?: (chunk: OutputChunk) => void;
  /** Replaces `process` as the target of `push` (for callers that want to process paired access units themselves). */
  onPaired?: ((au: AccessUnit) => void) | null;
}

export interface PipelineSnapshot {
  report: StreamReportData;
  fixes: FixState[];
  openNow: boolean;
  windowNow: boolean;
  starts: number;
}

/**
 * Turns access units into decoder chunks, applying exactly the fixes that were enabled.
 *
 *   const p = new FixPipeline({ fixes: { idrConvert: true, mmco: true }, log, onStart, onUnit });
 *   p.push(au)            // pairs fields (if enabled) and then calls process (or onPaired)
 *   p.process(au)         // start detection, fixes and chunk building; calls onStart once, then onUnit per chunk
 *   p.restart()           // forget start state (decoding restarts at a later key frame); parameter sets are kept
 *
 * `fixes` is a map { fixId: boolean }; fixes that are not listed are disabled. Detection (`report`) always runs.
 * Input access units are never modified.
 */
export class FixPipeline {
  readonly fixes: Fix[];
  readonly byId: Record<string, Fix>;
  readonly log: (message: string) => void;
  readonly report = new StreamReport();
  readonly planner = new MmcoPlanner();
  sps: Uint8Array | null = null;
  pps: Uint8Array | null = null;
  spsInfo: Sps | null = null;
  readonly ppsMap: PpsMap = new Map<number, Pps>();
  ctx = new StartContext();
  private held: AccessUnit | null = null;
  private starts = 0;
  private readonly onStart: (info: StartInfo) => void;
  private readonly onUnit: (chunk: OutputChunk) => void;
  private readonly onPaired: ((au: AccessUnit) => void) | null;

  constructor({ fixes = {}, log = () => {}, onStart = () => {}, onUnit = () => {}, onPaired = null }: PipelineOptions = {}) {
    this.fixes = FIX_CLASSES.map((C) => new C({ enabled: !!fixes[C.id] }));
    this.byId = Object.fromEntries(this.fixes.map((f) => [f.id, f]));
    this.log = log; this.onStart = onStart; this.onUnit = onUnit; this.onPaired = onPaired;
  }

  get hasHeld(): boolean { return this.held !== null; }

  restart(): void { this.ctx = new StartContext(); this.planner.reset(); this.held = null; }

  /** Learns parameter sets, works out field structure, pairs fields if that fix is enabled. */
  push(au: AccessUnit): void {
    for (const n of au.nals) {
      const t = nalType(n);
      if (t === 7) { this.sps = n; try { this.spsInfo = parseSps(n); } catch (e) { /* keep previous */ } }
      else if (t === 8) { try { const p = parsePps(n); this.ppsMap.set(p.id, p); this.pps = n; } catch (e) { /* unsupported PPS */ } }
    }
    if (!this.spsInfo) return;
    if (!au.vclNal) return;
    let h: ReturnType<typeof peekFieldInfo>;
    try { h = peekFieldInfo(au.vclNal, this.spsInfo); } catch (e) { return; }
    au.field = h.field; au.bottom = h.bottom; au.frameNum = h.frameNum;
    if (h.field) this.report.fieldPictures++;
    const pairing = this.byId.fieldPair!, pv = this.held;
    const merged = pv && pairing.tryPair?.(pv, au, this);
    if (merged) { this.held = null; this._emit(merged); return; }
    if (pv) { this.held = null; this._emit(pv); }
    if (pairing.enabled && h.field) this.held = au; else this._emit(au);
  }

  flush(): void { if (this.held) { const a = this.held; this.held = null; this._emit(a); } }

  private _emit(au: AccessUnit): void { if (this.onPaired) this.onPaired(au); else this.process(au); }

  private _isLeading(au: AccessUnit, sps: Sps): boolean {
    const M = 2 ** sps.pocLsbBits;
    return (pocLsbOf(au.vclNal!, sps) - this.ctx.startLsb + M) % M > M / 2;
  }

  private _begin(au: AccessUnit, sps: Sps): void {
    const c = this.ctx;
    const vclNal = au.vclNal!;
    c.started = true; c.open = !au.idr; c.startAU = au; c.window = c.open; c.leading = c.open;
    c.canConvertIdr = ((vclNal[0] >> 5) & 3) !== 0;
    if (c.open) {
      try {
        const h0 = parseSliceHeader(vclNal, sps, this.ppsMap);
        c.startFrameNum = h0.fnum; c.startLsb = h0.lsb || 0;
      } catch (e) {
        c.window = false; c.leading = false;
        this.log('Start-up repairs unavailable for this stream: ' + (e instanceof Error ? e.message : String(e)));
      }
    }
    if (this.starts === 0) {
      Object.assign(this.report, {
        started: true, openStart: c.open, missingRecoverySei: c.open && !au.rp, interlaced: sps.interlaced,
        pocType: sps.pocType, pocUnsupported: c.open && sps.pocType !== 0
      });
    } else this.report.restarts++;
    this.starts++;
    this.onStart({ codec: avcCodecString(this.sps!), interlaced: sps.interlaced, open: c.open, idr: au.idr, pts: au.pts, restart: this.starts > 1 });
  }

  process(au: AccessUnit): void {
    const c = this.ctx, sps = this.spsInfo, isKey = au.isKey;
    if (!sps || !au.vclNal) return;
    if (!c.started) {
      if (!isKey || !this.sps || !this.pps) return;
      this._begin(au, sps);
    } else {
      if (c.window && au.idr) { c.window = false; this.log('IDR reached: start-up repairs switched off.'); }
      if (c.leading) {
        if (isKey) c.leading = false;
        else if (sps.pocType === 0 && this._isLeading(au, sps)) {
          this.report.leadingPictures++;
          const drop = this.byId.dropLeading!;
          if (drop.enabled) {
            if (c.window) { try { this.planner.step(au, sps, this.ppsMap, true); this.planner.plan.clear(); } catch (e) { /* ignore */ } }
            drop.dropIfLeading?.(au, this);
            return;
          }
        }
      }
    }

    // Simulate reference marking during the start-up window (always, so invalid commands are reported).
    let plan: Map<Uint8Array, MmcoOp[]> | null = null;
    if (c.window) {
      try {
        plan = this.planner.step(au, sps, this.ppsMap, false);
        this.report.invalidMmco = Math.max(this.report.invalidMmco, this.planner.invalid);
      } catch (e) { /* ignore */ }
    }

    // Slice header edits requested by the enabled fixes. Slices of the start picture (not of a second field) are identified here.
    const isStartAU = au === c.startAU;
    let startPictureEnd = Infinity;
    if (isStartAU) {
      const vcl = au.nals.filter((n) => { const t = nalType(n); return t === 1 || t === 5; });
      startPictureEnd = vcl.length;
      for (let k = 1; k < vcl.length; k++) { try { if (sliceInfo(vcl[k]).first === 0) { startPictureEnd = k; break; } } catch (e) { /* ignore */ } }
    }
    let sliceIndex = 0;
    const nals = au.nals.map((n) => {
      const t = nalType(n);
      if (t !== 1 && t !== 5) return n;
      const k = sliceIndex++;
      const edit: SliceEditRequest = { dFn: 0, dLsb: 0, makeIdr: false, marking: undefined, by: new Set() };
      const slice: SliceContext = { nal: n, au, plan, isStartAU, startPicture: isStartAU && k < startPictureEnd };
      for (const f of this.fixes) if (f.enabled && f.editSlice) f.editSlice(slice, edit, this);
      if (!edit.by.size) return n;
      try {
        const out = rewriteSlice(n, sps, this.ppsMap, edit);
        if (!out) return n;
        for (const f of edit.by) f.hit();
        return out;
      } catch (e) { this.report.rewriteFailures++; return n; }
    });
    let outAu = au;
    if (nals.some((n, i) => n !== au.nals[i])) {
      outAu = au.withNals(nals);
      if (isStartAU && nals.some((n) => nalType(n) === 5)) outAu.idr = true;
    }

    // Build the Annex B chunk.
    const chunk = new ChunkBuilder(nals);
    const info: ChunkInfo = { au: outAu, isKey, isStartAU, needParams: isKey && (!outAu.idr || isStartAU) };
    if (info.needParams && !(chunk.hasSps && chunk.hasPps)) this.report.keyWithoutParams++;
    for (const f of this.fixes) if (f.enabled && f.finishChunk) f.finishChunk(chunk, info, this);
    if (au.pts === undefined) this.report.noPts++;
    const changed = outAu.rewritten || chunk.nals.length !== au.nals.length || chunk.nals.some((n, i) => n !== au.nals[i]);
    this.onUnit({ data: chunk.toBytes(), key: isKey, idr: outAu.idr, pts: au.pts, au: outAu, changed });
  }

  /** Everything the UI needs: what is wrong with the stream and what each fix did. */
  snapshot(): PipelineSnapshot {
    return { report: this.report.toJSON(), fixes: this.fixes.map((f) => f.state()), openNow: this.ctx.open, windowNow: this.ctx.window, starts: this.starts };
  }
}
