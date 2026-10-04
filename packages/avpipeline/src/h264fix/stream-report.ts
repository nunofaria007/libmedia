/** What was found wrong with the stream. Detection is independent of which fixes are enabled. */
export type StreamReportData = Omit<StreamReport, 'toJSON'>;

export class StreamReport {
  started = false;
  openStart = false;           // first key frame was a non-IDR I-frame
  missingRecoverySei = false;  // ... and carried no recovery-point SEI
  pocType = -1;                // pic_order_cnt_type of the SPS at the start
  pocUnsupported = false;      // open start, but leading pictures cannot be detected for this POC type
  leadingPictures = 0;         // pictures after the start that reference frames before it
  invalidMmco = 0;             // MMCO commands that point at pictures that were never decoded
  keyWithoutParams = 0;        // key frames that arrived without in-band SPS/PPS
  interlaced = false;
  fieldPictures = 0;
  noPts = 0;                   // video access units without a PES timestamp
  rewriteFailures = 0;
  restarts = 0;

  toJSON(): StreamReportData { return Object.assign({}, this); }
}
