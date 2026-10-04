// Low-level helpers for H.264 Annex B byte streams: start codes, emulation prevention, bit reading/writing.

export const START_CODE = new Uint8Array([0, 0, 0, 1]);

export const nalType = (nal: Uint8Array): number => nal[0] & 31;

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}

/** Splits an Annex B buffer into NAL units (without start codes or trailing zero bytes). */
export function splitAnnexB(u8: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let cur = -1, i = 0;
  const n = u8.length;
  while (i + 2 < n) {
    if (u8[i + 2] > 1) { i += 3; continue; }
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
      if (cur >= 0) { let e = i; while (e > cur && u8[e - 1] === 0) e--; out.push(u8.subarray(cur, e)); }
      cur = i + 3; i += 3;
    } else i++;
  }
  if (cur >= 0) { let e = n; while (e > cur && u8[e - 1] === 0) e--; out.push(u8.subarray(cur, e)); }
  return out;
}

/** First `max` payload bytes of a NAL (header byte skipped, emulation prevention bytes removed). */
export function rbspPrefix(nal: Uint8Array, max = 16): number[] {
  const o: number[] = [];
  for (let i = 1; i < nal.length && o.length < max; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    o.push(nal[i]);
  }
  return o;
}

/** Whole NAL payload without header byte and without emulation prevention bytes. */
export function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const o: number[] = [];
  for (let i = 1; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    o.push(nal[i]);
  }
  return Uint8Array.from(o);
}

/** Inserts emulation prevention bytes. */
export function escapeRbsp(bytes: ArrayLike<number> & Iterable<number>): Uint8Array {
  const o: number[] = [];
  let z = 0;
  for (const x of bytes) {
    if (z >= 2 && x <= 3) { o.push(3); z = 0; }
    o.push(x);
    z = x === 0 ? z + 1 : 0;
  }
  return Uint8Array.from(o);
}

export class BitReader {
  private p = 0;
  constructor(private readonly bytes: ArrayLike<number>) {}
  pos(): number { return this.p; }
  bit(): number { const v = (this.bytes[this.p >> 3] >> (7 - (this.p & 7))) & 1; this.p++; return v || 0; }
  bits(n: number): number { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v; }
  ue(): number { let z = 0; while (!this.bit() && z < 32) z++; return 2 ** z - 1 + this.bits(z); }
  se(): number { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
}

/** Appends the Exp-Golomb (ue) code of v to an array of bits. */
export function writeUe(out: number[], v: number): void {
  const x = v + 1, n = 31 - Math.clz32(x);
  for (let i = 0; i < n; i++) out.push(0);
  for (let i = n; i >= 0; i--) out.push((x >> i) & 1);
}

/** Packs an array of bits (length multiple of 8) into bytes. */
export function packBits(bits: ArrayLike<number>): Uint8Array {
  const o = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < bits.length; i++) if (bits[i]) o[i >> 3] |= 0x80 >> (i & 7);
  return o;
}
