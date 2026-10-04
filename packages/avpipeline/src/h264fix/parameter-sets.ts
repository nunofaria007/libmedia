import { BitReader, rbspPrefix, unescapeRbsp, escapeRbsp, concat } from './bits';

const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

export interface Sps {
  log2FrameNum: number;
  pocType: number;
  pocLsbBits: number;
  frameMbsOnly: number;
  mbaff: number;
  numRefFrames: number;
  chromaArrayType: number;
  separateColourPlane: number;
  /** Bit position of gaps_in_frame_num_value_allowed_flag in the unescaped RBSP. */
  gapFlagPos: number;
  interlaced: boolean;
}

export interface Pps {
  id: number;
  cabac: number;
  bottomFieldPicOrder: number;
  numRefIdxL0: number;
  numRefIdxL1: number;
  weightedPred: number;
  weightedBipred: number;
  deblockingControl: number;
  redundantPicCnt: number;
}

export function parseSps(nal: Uint8Array): Sps {
  const r = new BitReader(rbspPrefix(nal, 300));
  const profile = r.bits(8);
  r.bits(16);
  r.ue();
  let chromaFormat = 1, separate = 0;
  if (HIGH_PROFILES.includes(profile)) {
    chromaFormat = r.ue();
    if (chromaFormat === 3) separate = r.bit();
    r.ue(); r.ue(); r.bit();
    if (r.bit()) {
      const n = chromaFormat !== 3 ? 8 : 12;
      for (let i = 0; i < n; i++) if (r.bit()) {
        const size = i < 6 ? 16 : 64;
        let last = 8, next = 8;
        for (let j = 0; j < size; j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          if (next !== 0) last = next;
        }
      }
    }
  }
  const log2FrameNum = r.ue() + 4;
  const pocType = r.ue();
  let pocLsbBits = 0;
  if (pocType === 0) pocLsbBits = r.ue() + 4;
  else if (pocType === 1) { r.bit(); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
  const numRefFrames = r.ue();
  const gapFlagPos = r.pos();            // bit position of gaps_in_frame_num_value_allowed_flag
  r.bit(); r.ue(); r.ue();
  const frameMbsOnly = r.bit();
  const mbaff = frameMbsOnly ? 0 : r.bit();
  return {
    log2FrameNum, pocType, pocLsbBits, frameMbsOnly, mbaff, numRefFrames,
    chromaArrayType: separate ? 0 : chromaFormat, separateColourPlane: separate, gapFlagPos,
    interlaced: !frameMbsOnly
  };
}

export function parsePps(nal: Uint8Array): Pps {
  const r = new BitReader(rbspPrefix(nal, 200));
  const id = r.ue();
  r.ue();
  const cabac = r.bit(), bottomFieldPicOrder = r.bit();
  if (r.ue() > 0) throw new Error('FMO / slice groups are not supported');
  const numRefIdxL0 = r.ue() + 1, numRefIdxL1 = r.ue() + 1;
  const weightedPred = r.bit(), weightedBipred = r.bits(2);
  r.se(); r.se(); r.se();
  const deblockingControl = r.bit();
  r.bit();
  const redundantPicCnt = r.bit();
  return { id, cabac, bottomFieldPicOrder, numRefIdxL0, numRefIdxL1, weightedPred, weightedBipred, deblockingControl, redundantPicCnt };
}

/**
 * Sets gaps_in_frame_num_value_allowed_flag=1 so the decoder tolerates frame_num gaps.
 * Returns the NAL itself when the flag is already set or the SPS cannot be patched, otherwise a patched copy.
 */
export function patchSpsGapFlag(nal: Uint8Array): Uint8Array {
  try {
    const bytes = unescapeRbsp(nal), pos = parseSps(nal).gapFlagPos, mask = 0x80 >> (pos & 7);
    if (bytes[pos >> 3] & mask) return nal;
    bytes[pos >> 3] |= mask;
    return concat([Uint8Array.of(nal[0]), escapeRbsp(bytes)]);
  } catch (e) { return nal; }
}

/** RFC 6381 codec string from an SPS NAL. */
export function avcCodecString(sps: Uint8Array): string {
  return 'avc1.' + [1, 2, 3].map((i) => sps[i].toString(16).padStart(2, '0')).join('');
}
