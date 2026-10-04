import { BitReader, rbspPrefix, unescapeRbsp, escapeRbsp, concat, writeUe, packBits } from './bits';
import type { Sps, Pps } from './parameter-sets';

/** One memory_management_control_operation. `a` is difference_of_pic_nums_minus1 (ops 1, 3) or long_term_pic_num (ops 2) etc. */
export interface MmcoOp { op: number; a?: number; b?: number }

/** Marking replacement: 'idr' (IDR flags), null (no commands), a command list, or undefined to keep the original. */
export type Marking = 'idr' | null | MmcoOp[] | undefined;

export interface SliceEdit {
  dFn?: number;
  dLsb?: number;
  makeIdr?: boolean;
  marking?: Marking;
}

export interface SliceHeader {
  first: number;
  st: number;                 // slice type 0..4
  fnS: number; fnum: number; fnE: number;
  field: number;
  idrPos: number;
  lsbS: number; lsb: number; lsbE: number;
  mmS: number; mmE: number;   // marking bit range (mmS < 0 when the slice is not a reference slice)
  adapt: number;
  ops: string[] | null;
  opsS: MmcoOp[] | null;
  hdrEnd: number;
  b: Uint8Array;
  pps: Pps;
  nt: number;
}

export type PpsMap = Map<number, Pps>;

/** first_mb_in_slice and slice type (0=P 1=B 2=I 3=SP 4=SI) of a slice NAL. */
export function sliceInfo(nal: Uint8Array): { first: number; type: number } {
  const r = new BitReader(rbspPrefix(nal));
  const first = r.ue(), st = r.ue();
  return { first, type: st % 5 };
}

export function hasRecoverySei(nal: Uint8Array): boolean {
  let p = 1;
  while (p < nal.length - 1) {
    let t = 0; while (nal[p] === 255) { t += 255; p++; } t += nal[p++];
    let s = 0; while (nal[p] === 255) { s += 255; p++; } s += nal[p++];
    if (t === 6) return true;
    p += s;
    if (nal[p] === 0x80) break;
  }
  return false;
}

/** Field/frame structure of a slice: { field, bottom, frameNum }. */
export function peekFieldInfo(nal: Uint8Array, sps: Sps): { field: number; bottom: number; frameNum: number } {
  const r = new BitReader(rbspPrefix(nal, 32));
  r.ue(); r.ue(); r.ue();
  const frameNum = r.bits(sps.log2FrameNum);
  const field = sps.frameMbsOnly ? 0 : r.bit();
  return { field, bottom: field ? r.bit() : 0, frameNum };
}

export function pocLsbOf(nal: Uint8Array, sps: Sps): number {
  const r = new BitReader(rbspPrefix(nal, 32));
  r.ue(); r.ue(); r.ue(); r.bits(sps.log2FrameNum);
  if (!sps.frameMbsOnly) { if (r.bit()) r.bit(); }
  if ((nal[0] & 31) === 5) r.ue();
  return r.bits(sps.pocLsbBits);
}

/** Parses a slice header, recording the bit positions needed to rewrite it. */
export function parseSliceHeader(nal: Uint8Array, sps: Sps, ppsMap: PpsMap): SliceHeader {
  const b = unescapeRbsp(nal), r = new BitReader(b), nt = nal[0] & 31, ref = (nal[0] >> 5) & 3;
  const h = {} as SliceHeader;
  h.first = r.ue(); h.st = r.ue() % 5;
  const pps = ppsMap.get(r.ue());
  if (!pps) throw new Error('PPS missing');
  if (sps.separateColourPlane) r.bits(2);
  h.fnS = r.pos(); h.fnum = r.bits(sps.log2FrameNum); h.fnE = r.pos(); h.field = 0;
  if (!sps.frameMbsOnly) { h.field = r.bit(); if (h.field) r.bit(); }
  h.idrPos = r.pos();
  if (nt === 5) r.ue();
  h.lsbS = 0; h.lsb = 0; h.lsbE = 0;
  if (sps.pocType === 0) {
    h.lsbS = r.pos(); h.lsb = r.bits(sps.pocLsbBits); h.lsbE = r.pos();
    if (pps.bottomFieldPicOrder && !h.field) r.se();
  } else if (sps.pocType === 1) throw new Error('POC type 1 is not supported');
  if (pps.redundantPicCnt) r.ue();
  const P = h.st === 0 || h.st === 3, B = h.st === 1, I = h.st === 2 || h.st === 4;
  if (B) r.bit();
  let n0 = pps.numRefIdxL0, n1 = B ? pps.numRefIdxL1 : 0;
  if (P || B) { if (r.bit()) { n0 = r.ue() + 1; if (B) n1 = r.ue() + 1; } }
  if (I) n0 = 0;
  const mod = () => { if (r.bit()) { let idc: number; do { idc = r.ue(); if (idc < 3) r.ue(); } while (idc !== 3); } };
  if (!I) { mod(); if (B) mod(); }
  if ((pps.weightedPred && P) || (pps.weightedBipred === 1 && B)) {
    r.ue(); if (sps.chromaArrayType) r.ue();
    const tab = (n: number) => {
      for (let i = 0; i < n; i++) {
        if (r.bit()) { r.se(); r.se(); }
        if (sps.chromaArrayType && r.bit()) { r.se(); r.se(); r.se(); r.se(); }
      }
    };
    tab(n0); if (B) tab(n1);
  }
  h.mmS = -1; h.mmE = -1; h.adapt = 0; h.ops = null; h.opsS = null;       // reference picture marking: start bit, adaptive flag, commands
  if (ref) {
    h.mmS = r.pos();
    if (nt === 5) { r.bit(); r.bit(); }
    else {
      h.adapt = r.bit();
      if (h.adapt) {
        const ops: string[] = [], opsS: MmcoOp[] = [];
        h.ops = ops; h.opsS = opsS;
        let op: number;
        do {
          op = r.ue();
          const o: MmcoOp = { op };
          if (op === 1 || op === 2 || op === 3 || op === 4) o.a = r.ue();
          if (op === 3 || op === 6) o.b = r.ue();
          opsS.push(o);
          ops.push(op + (o.a !== undefined ? ':' + o.a : ''));
        } while (op !== 0);
      }
    }
    h.mmE = r.pos();
  }
  if (pps.cabac && !I) r.ue();
  r.se();
  if (h.st === 3 || h.st === 4) { if (h.st === 3) r.bit(); r.se(); }
  if (pps.deblockingControl) { if (r.ue() !== 1) { r.se(); r.se(); } }
  h.hdrEnd = r.pos(); h.b = b; h.pps = pps; h.nt = nt;
  return h;
}

function markingBits(ops: MmcoOp[]): number[] {
  const o: number[] = [1];
  for (const q of ops) {
    writeUe(o, q.op);
    if (q.op === 1 || q.op === 2 || q.op === 3 || q.op === 4) writeUe(o, q.a ?? 0);
    if (q.op === 3 || q.op === 6) writeUe(o, q.b ?? 0);
  }
  return o;
}

/**
 * Rewrites a (non-IDR) slice header.
 *  edit.dFn / edit.dLsb : subtract from frame_num / pic_order_cnt_lsb (rebasing)
 *  edit.makeIdr         : turn the slice into an IDR slice (nal type 5, idr_pic_id 0)
 *  edit.marking         : 'idr' | null (no commands) | array of MMCO commands | undefined (keep as is)
 * Returns null for slices that are already IDR. Throws if the rewritten header does not re-parse identically.
 */
export function rewriteSlice(nal: Uint8Array, sps: Sps, ppsMap: PpsMap, edit: SliceEdit): Uint8Array | null {
  const h = parseSliceHeader(nal, sps, ppsMap);
  if (h.nt === 5) return null;
  const cabac = h.pps.cabac, nb = cabac ? ((h.hdrEnd + 7) >> 3) * 8 : h.b.length * 8;
  const bits = new Uint8Array(nb);
  for (let i = 0; i < nb; i++) bits[i] = (h.b[i >> 3] >> (7 - (i & 7))) & 1;
  const out: number[] = [];
  const copy = (f: number, t: number) => { for (let i = f; i < t; i++) out.push(bits[i]); };
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) out.push(Math.floor(v / 2 ** i) % 2); };
  const Mf = 2 ** sps.log2FrameNum, Ml = 2 ** sps.pocLsbBits;
  const newFn = (((h.fnum - (edit.dFn || 0)) % Mf) + Mf) % Mf;
  let newLsb = h.lsb;
  if (sps.pocType === 0 && edit.dLsb) newLsb = (((h.lsb - edit.dLsb) % Ml) + Ml) % Ml;
  copy(0, h.fnS); put(newFn, sps.log2FrameNum); copy(h.fnE, h.idrPos);
  if (edit.makeIdr) writeUe(out, 0);
  const preMark = h.mmS >= 0 ? h.mmS : h.hdrEnd;
  if (sps.pocType === 0) { copy(h.idrPos, h.lsbS); put(newLsb, sps.pocLsbBits); copy(h.lsbE, preMark); }
  else copy(h.idrPos, preMark);
  if (h.mmS >= 0) {
    const m = edit.marking;
    if (m === 'idr') out.push(0, 0);
    else if (m === null) out.push(0);
    else if (Array.isArray(m)) for (const x of markingBits(m)) out.push(x);
    else copy(h.mmS, h.mmE);
    copy(h.mmE, h.hdrEnd);
  }
  const hdrLen = out.length;
  let headBytes: Uint8Array, dataBytes: Uint8Array = new Uint8Array(0);
  if (cabac) {
    while (out.length & 7) out.push(1);                 // cabac_alignment_one_bit
    headBytes = packBits(out);
    dataBytes = h.b.subarray((h.hdrEnd + 7) >> 3);
  } else {
    let stop = nb - 1; while (stop >= 0 && !bits[stop]) stop--;
    copy(h.hdrEnd, stop); out.push(1);
    while (out.length & 7) out.push(0);
    headBytes = packBits(out);
  }
  const body = new Uint8Array(headBytes.length + dataBytes.length);
  body.set(headBytes); body.set(dataBytes, headBytes.length);
  const res = concat([Uint8Array.of(edit.makeIdr ? ((nal[0] & 0xE0) | 5) : nal[0]), escapeRbsp(body)]);
  const h2 = parseSliceHeader(res, sps, ppsMap);
  if (h2.first !== h.first || h2.fnum !== newFn || (sps.pocType === 0 && h2.lsb !== newLsb) || h2.hdrEnd !== hdrLen) {
    throw new Error('slice rewrite verification failed');
  }
  return res;
}
