import type { AccessUnit } from '../access-unit';
import type { ChunkBuilder } from '../chunk-builder';
import type { SliceEdit, MmcoOp } from '../slice';
import type { FixPipeline } from '../pipeline';

/** What the pipeline passes to `editSlice`: the slice being rewritten and the planner's output for its access unit. */
export interface SliceContext {
  nal: Uint8Array;
  au: AccessUnit;
  plan: Map<Uint8Array, MmcoOp[]> | null;
  isStartAU: boolean;
  /** The slice belongs to the start picture itself (not to a second field of it). */
  startPicture: boolean;
}

/** The edit being assembled for one slice. Fixes that contribute to it add themselves to `by` so they are counted once it is applied. */
export interface SliceEditRequest extends SliceEdit {
  by: Set<Fix>;
}

export interface ChunkInfo {
  au: AccessUnit;
  isKey: boolean;
  isStartAU: boolean;
  needParams: boolean;
}

export interface FixState {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
  applied: number;
  detail: string;
}

/**
 * Base class of all fixes. A fix does nothing unless it is enabled, and it only touches what has the problem it is for.
 * `applied` counts how many times it really changed something, which is what the UI shows.
 * Subclasses implement the hooks they need:
 *   tryPair(held, next, pipeline)        -> AccessUnit | null     (before access units are processed)
 *   dropIfLeading(au, pipeline)          -> boolean                (true: the picture is discarded)
 *   editSlice(slice, edit, pipeline)     -> void                   (contribute to a slice header rewrite)
 *   finishChunk(chunk, info, pipeline)   -> void                   (edit the NAL list of the output chunk, see ChunkBuilder)
 */
export abstract class Fix {
  static id = 'fix';
  static title = 'Fix';
  static description = '';

  enabled: boolean;
  applied = 0;

  constructor({ enabled = false }: { enabled?: boolean } = {}) {
    this.enabled = !!enabled;
  }

  /** Hooks. A fix implements the ones it needs; the pipeline only calls them on enabled fixes (tryPair and dropIfLeading check `enabled` themselves). */
  tryPair?(held: AccessUnit | null, next: AccessUnit, pipeline: FixPipeline): AccessUnit | null;
  dropIfLeading?(au: AccessUnit, pipeline: FixPipeline): boolean;
  editSlice?(slice: SliceContext, edit: SliceEditRequest, pipeline: FixPipeline): void;
  finishChunk?(chunk: ChunkBuilder, info: ChunkInfo, pipeline: FixPipeline): void;

  private get meta(): typeof Fix { return this.constructor as typeof Fix; }
  get id(): string { return this.meta.id; }
  get title(): string { return this.meta.title; }
  get description(): string { return this.meta.description; }
  hit(n = 1): void { this.applied += n; }
  /** Short text about what the fix did so far. */
  describe(): string { return this.applied ? String(this.applied) : ''; }
  state(): FixState { return { id: this.id, title: this.title, description: this.description, enabled: this.enabled, applied: this.applied, detail: this.describe() }; }
}
