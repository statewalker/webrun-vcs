/**
 * A loaded commit-graph: one file or a split chain of layers (base first), read as git's
 * `commit-graph.c` reads it. Positions are global: a layer's local position plus the commits
 * of the layers below it (`num_commits_in_base`).
 */

import type { ObjectId } from "../../common/id/index.js";
import {
  type BloomFilterSettings,
  CORRECTED_COMMIT_DATE_OFFSET_OVERFLOW,
  type CommitGraphLayer,
  GRAPH_EDGE_LAST_MASK,
  GRAPH_EXTRA_EDGES_NEEDED,
  GRAPH_LAST_EDGE,
  GRAPH_PARENT_NONE,
} from "./commit-graph-format.js";

/** A commit as the graph stores it. */
export interface GraphCommit {
  id: ObjectId;
  /** Global graph position */
  position: number;
  /** Root tree */
  tree: ObjectId;
  /** Parent ids, in order */
  parents: ObjectId[];
  /** Committer date, seconds (34 bits, git's `commit->date`) */
  commitTime: number;
  /**
   * git's `commit_graph_generation`: the corrected commit date when the chain has generation
   * data v2 (GDA2), the topological level otherwise
   */
  generation: number;
  /** Topological level (CDAT; generation number v1) */
  topoLevel: number;
}

/** The graph is inconsistent where git would die ("commit-graph is likely corrupt"). */
export class CommitGraphCorruptError extends Error {
  override name = "CommitGraphCorruptError";
}

const HEX_DIGITS = Array.from("0123456789abcdef", (c) => c.charCodeAt(0));
/** One scratch array of char codes per id width (20 or 32 bytes) */
const HEX_CODES = new Map<number, number[]>();

/** The hex id of the `size` bytes at `at` (the fastest way to build one in V8). */
function hexAt(bytes: Uint8Array, at: number, size: number): ObjectId {
  let hexCodes = HEX_CODES.get(size);
  if (!hexCodes) {
    hexCodes = new Array<number>(2 * size);
    HEX_CODES.set(size, hexCodes);
  }
  for (let i = 0; i < size; i++) {
    const v = bytes[at + i] as number;
    hexCodes[2 * i] = HEX_DIGITS[v >> 4] as number;
    hexCodes[2 * i + 1] = HEX_DIGITS[v & 15] as number;
  }
  return String.fromCharCode.apply(null, hexCodes);
}

/** Parses a hex id of `out.length` bytes into `out`; false when it is not one. */
function parseOid(id: string, out: Uint8Array): boolean {
  const size = out.length;
  if (id.length !== 2 * size) return false;
  for (let i = 0; i < size; i++) {
    const hi = hexValue(id.charCodeAt(2 * i));
    const lo = hexValue(id.charCodeAt(2 * i + 1));
    if (hi < 0 || lo < 0) return false;
    out[i] = (hi << 4) | lo;
  }
  return true;
}

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

/**
 * A commit-graph chain. Built by `readCommitGraph` (from files) or `CommitGraph.fromLayers`
 * (validated layers, base first).
 *
 * @example
 * ```typescript
 * const graph = await readCommitGraph(files, ".git/objects");
 * const c = graph?.lookup(headId);
 * if (c) console.log(c.parents, c.generation);
 * ```
 */
export class CommitGraph {
  /** Ids by global position, decoded on first use */
  private readonly ids: (ObjectId | undefined)[];
  /** Positions of the ids decoded so far (walks look up the parents they were given) */
  private readonly positions = new Map<ObjectId, number>();
  private readonly scratch: Uint8Array;
  /** Total commits in all layers */
  readonly size: number;
  /** Bytes of an id in every layer (the object format's `rawLength`) */
  readonly hashSize: number;

  /**
   * @param layers the chain, base first; each layer's `numCommitsInBase` already set
   */
  constructor(readonly layers: readonly CommitGraphLayer[]) {
    let n = 0;
    for (const l of layers) n += l.numCommits;
    this.size = n;
    this.ids = new Array(n);
    const hashSize = layers[0]?.hashSize ?? 20;
    if (layers.some((l) => l.hashSize !== hashSize))
      throw new CommitGraphCorruptError("commit-graph layers of different object formats");
    this.hashSize = hashSize;
    this.scratch = new Uint8Array(hashSize);
  }

  /** The topmost layer. */
  get top(): CommitGraphLayer {
    return this.layers[this.layers.length - 1] as CommitGraphLayer;
  }

  /** Whether generations are corrected commit dates (git's corrected_commit_dates_enabled). */
  get correctedDates(): boolean {
    return this.size > 0 && this.top.readGenerationData;
  }

  /**
   * git's generation_numbers_enabled: the graph has commits and the first commit of the top
   * layer has a non-zero topological level (old graphs wrote zero).
   */
  get generationNumbersEnabled(): boolean {
    const top = this.top;
    if (!top || top.numCommits === 0) return false;
    return top.topoLevel(0) !== 0;
  }

  /**
   * Whether walks may cut and order by this graph's generations. git reads a stored generation
   * of 0 (graphs of git before 2.18 wrote zero levels) as GENERATION_NUMBER_INFINITY and skips
   * generation cutoffs without `generationNumbersEnabled`; a corrupt record makes git die. Here
   * the whole graph is checked once, on first use: generations are trusted only when
   * `generationNumbersEnabled`, every record decodes, no generation is 0 and every commit's
   * generation is above its parents' (what the cutoffs rely on: a graph git 2.43 wrote for
   * dates past 2^34 is not). Otherwise walks treat every generation as Infinity: no cutoff,
   * date order, always the right answer.
   */
  get generationsTrusted(): boolean {
    this.trusted ??= this.checkGenerations();
    return this.trusted;
  }

  /** Stops walks from using this graph's generations (a record turned out corrupt). */
  distrustGenerations(): void {
    this.trusted = false;
  }

  /**
   * The generation walks use at `pos`: the stored one while `generationsTrusted`, else
   * Infinity (git's GENERATION_NUMBER_INFINITY).
   */
  walkGenerationAt(pos: number): number {
    return this.generationsTrusted ? this.generationAt(pos) : Number.POSITIVE_INFINITY;
  }

  private trusted?: boolean;

  private checkGenerations(): boolean {
    if (!this.generationNumbersEnabled) return false;
    const gens = new Float64Array(this.size);
    try {
      for (const layer of this.layers) {
        for (let local = 0; local < layer.numCommits; local++) {
          const g = this.layerGeneration(layer, local);
          if (!(g > 0)) return false;
          gens[layer.numCommitsInBase + local] = g;
        }
      }
      // parentPositionsAt without its arrays: every edge, in range and below its child
      for (const layer of this.layers) {
        const total = layer.numCommits + layer.numCommitsInBase;
        const edges = layer.extraEdges;
        const edgeCount = edges ? Math.floor(edges.size / 4) : 0;
        const below = (p: number, g: number) => p < total && (gens[p] as number) < g;
        for (let local = 0; local < layer.numCommits; local++) {
          const g = gens[layer.numCommitsInBase + local] as number;
          const at = layer.dataOffset(local) + layer.hashSize;
          const first = layer.u32(at);
          if (first === GRAPH_PARENT_NONE) continue;
          if (!below(first, g)) return false;
          const second = layer.u32(at + 4);
          if (second === GRAPH_PARENT_NONE) continue;
          if (!(second & GRAPH_EXTRA_EDGES_NEEDED)) {
            if (!below(second, g)) return false;
            continue;
          }
          for (let edge = (second & GRAPH_EDGE_LAST_MASK) >>> 0; ; edge++) {
            if (!edges || edge >= edgeCount) return false;
            const value = layer.u32(edges.offset + 4 * edge);
            if (!below((value & GRAPH_EDGE_LAST_MASK) >>> 0, g)) return false;
            if (value & GRAPH_LAST_EDGE) break;
          }
        }
      }
    } catch (e) {
      if (e instanceof CommitGraphCorruptError) return false;
      throw e;
    }
    return true;
  }

  /** The changed-path settings of the topmost layer that has filters (git's get_bloom_filter_settings). */
  get bloomSettings(): BloomFilterSettings | undefined {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const s = this.layers[i]?.bloomSettings;
      if (s) return s;
    }
    return undefined;
  }

  /** The global position of `id`, or -1 (git's search_commit_pos_in_graph: top layer first). */
  position(id: ObjectId): number {
    const known = this.positions.get(id);
    if (known !== undefined) return known;
    if (!parseOid(id, this.scratch)) return -1;
    return this.positionOfBytes(this.scratch);
  }

  /** The global position of a raw id (`hashSize` bytes), or -1. */
  positionOfBytes(id: Uint8Array): number {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i] as CommitGraphLayer;
      const local = layer.find(id);
      if (local >= 0) return local + layer.numCommitsInBase;
    }
    return -1;
  }

  /** Whether the graph has `id`. */
  has(id: ObjectId): boolean {
    return this.position(id) >= 0;
  }

  /** The layer holding global position `pos` and the local position in it. */
  locate(pos: number): [CommitGraphLayer, number] {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i] as CommitGraphLayer;
      if (pos >= layer.numCommitsInBase) {
        if (pos >= layer.numCommitsInBase + layer.numCommits) break;
        return [layer, pos - layer.numCommitsInBase];
      }
    }
    throw new CommitGraphCorruptError("invalid commit position. commit-graph is likely corrupt");
  }

  /** The id at global position `pos`. */
  idAt(pos: number): ObjectId {
    let id = this.ids[pos];
    if (id === undefined) {
      const [layer, local] = this.locate(pos);
      id = hexAt(layer.bytes, layer.oidLookup.offset + layer.hashSize * local, layer.hashSize);
      this.ids[pos] = id;
      this.positions.set(id, pos);
    }
    return id;
  }

  /** The root tree at global position `pos`. */
  treeAt(pos: number): ObjectId {
    const [layer, local] = this.locate(pos);
    return hexAt(layer.bytes, layer.dataOffset(local), layer.hashSize);
  }

  /** The committer date at global position `pos`. */
  commitTimeAt(pos: number): number {
    const [layer, local] = this.locate(pos);
    return layer.commitDate(local);
  }

  /** The topological level at global position `pos`. */
  topoLevelAt(pos: number): number {
    const [layer, local] = this.locate(pos);
    return layer.topoLevel(local);
  }

  /** git's fill_commit_graph_info generation at global position `pos`. */
  generationAt(pos: number): number {
    const [layer, local] = this.locate(pos);
    return this.layerGeneration(layer, local);
  }

  private layerGeneration(layer: CommitGraphLayer, local: number): number {
    if (!layer.readGenerationData || !layer.generationData) return layer.topoLevel(local);
    const date = layer.commitDate(local);
    const offset = layer.u32(layer.generationData.offset + 4 * local);
    if (offset & CORRECTED_COMMIT_DATE_OFFSET_OVERFLOW) {
      const overflow = layer.generationOverflow;
      if (!overflow) {
        throw new CommitGraphCorruptError(
          "commit-graph requires overflow generation data but has none",
        );
      }
      const index = (offset ^ CORRECTED_COMMIT_DATE_OFFSET_OVERFLOW) >>> 0;
      if (Math.floor(overflow.size / 8) <= index) {
        throw new CommitGraphCorruptError("commit-graph overflow generation data is too small");
      }
      const at = overflow.offset + 8 * index;
      return date + layer.u32(at) * 0x100000000 + layer.u32(at + 4);
    }
    return date + offset;
  }

  /**
   * The parent positions at global position `pos` (git's fill_commit_in_graph): throws
   * `CommitGraphCorruptError` on a position out of range or an EDGE pointer out of bounds.
   */
  parentPositionsAt(pos: number): number[] {
    const [layer, local] = this.locate(pos);
    const total = layer.numCommits + layer.numCommitsInBase;
    const at = layer.dataOffset(local) + layer.hashSize;
    const check = (p: number) => {
      if (p >= total) throw new CommitGraphCorruptError(`invalid parent position ${p}`);
      return p;
    };
    const first = layer.u32(at);
    if (first === GRAPH_PARENT_NONE) return [];
    const parents = [check(first)];
    const second = layer.u32(at + 4);
    if (second === GRAPH_PARENT_NONE) return parents;
    if (!(second & GRAPH_EXTRA_EDGES_NEEDED)) {
      parents.push(check(second));
      return parents;
    }
    let edge = (second & GRAPH_EDGE_LAST_MASK) >>> 0;
    const edges = layer.extraEdges;
    for (;;) {
      if (!edges || Math.floor(edges.size / 4) <= edge) {
        throw new CommitGraphCorruptError("commit-graph extra-edges pointer out of bounds");
      }
      const value = layer.u32(edges.offset + 4 * edge);
      parents.push(check((value & GRAPH_EDGE_LAST_MASK) >>> 0));
      edge++;
      if (value & GRAPH_LAST_EDGE) break;
    }
    return parents;
  }

  /** The parent ids at global position `pos`. */
  parentsAt(pos: number): ObjectId[] {
    return this.parentPositionsAt(pos).map((p) => this.idAt(p));
  }

  /** The commit at global position `pos`. */
  commitAt(pos: number): GraphCommit {
    const [layer, local] = this.locate(pos);
    return {
      id: this.idAt(pos),
      position: pos,
      tree: this.treeAt(pos),
      parents: this.parentsAt(pos),
      commitTime: layer.commitDate(local),
      generation: this.layerGeneration(layer, local),
      topoLevel: layer.topoLevel(local),
    };
  }

  /** The commit `id`, or undefined when the graph does not have it. */
  lookup(id: ObjectId): GraphCommit | undefined {
    const pos = this.position(id);
    return pos < 0 ? undefined : this.commitAt(pos);
  }

  /**
   * The generation walks use for `id` (`walkGenerationAt`), or Infinity when the graph does not
   * have it (git's GENERATION_NUMBER_INFINITY).
   */
  generationOf(id: ObjectId): number {
    const pos = this.position(id);
    return pos < 0 ? Number.POSITIVE_INFINITY : this.walkGenerationAt(pos);
  }

  /** The changed-path filter at global position `pos` and its settings, when its layer has filters. */
  bloomFilterAt(pos: number): { data: Uint8Array; settings: BloomFilterSettings } | undefined {
    const [layer, local] = this.locate(pos);
    const settings = layer.bloomSettings;
    if (!settings) return undefined;
    const data = layer.bloomFilter(local);
    return data ? { data, settings } : undefined;
  }

  /** Every id in the graph, by global position. */
  *allIds(): Iterable<ObjectId> {
    for (let p = 0; p < this.size; p++) yield this.idAt(p);
  }
}
