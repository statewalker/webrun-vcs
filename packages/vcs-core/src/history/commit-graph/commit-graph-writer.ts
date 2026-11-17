/**
 * Writing commit-graphs as git's `write_commit_graph` (commit-graph.c, 2.56): the commits
 * given and everything they reach, sorted by id, with topological levels (CDAT), corrected
 * commit dates (GDA2/GDO2, when `commitGraph.generationVersion` is 2, the default since git
 * 2.36), octopus edges (EDGE), changed-path Bloom filters (BIDX/BDAT, when asked or when the
 * existing graph has them) and, for a split chain, the base layers (BASE). The bytes are
 * those `git commit-graph write` produces from the same input.
 *
 * Files are written as git writes them: `info/commit-graph` through `info/commit-graph.lock`;
 * a split layer as `info/commit-graphs/tmp_graph_*` renamed to `graph-<hash>.graph`, the chain
 * under `commit-graph-chain.lock`. Layers no longer in the chain (and, after a single-file
 * write, the whole chain) are deleted when not modified after `expireTime`.
 */

import type { FilesApi, PosixFilesApi } from "@statewalker/vcs-utils/files";
import { atomicFilesOver, joinPath } from "@statewalker/vcs-utils/files";
import { createSha1 } from "@statewalker/vcs-utils/hash";
import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";

import type { ObjectId } from "../../common/id/index.js";
import { runSteps, type Steps } from "../../pack/index.js";
import type { GitObjects } from "../objects/git-objects.js";
import { computeBloomFilter, DEFAULT_BLOOM_FILTER_SETTINGS } from "./bloom-filter.js";
import type { CommitGraph } from "./commit-graph.js";
import {
  type BloomFilterSettings,
  CHUNK_BASE,
  CHUNK_BLOOM_DATA,
  CHUNK_BLOOM_INDEXES,
  CHUNK_COMMIT_DATA,
  CHUNK_EXTRA_EDGES,
  CHUNK_GENERATION_DATA,
  CHUNK_GENERATION_DATA_OVERFLOW,
  CHUNK_OID_FANOUT,
  CHUNK_OID_LOOKUP,
  CHUNK_TOC_ENTRY_SIZE,
  CORRECTED_COMMIT_DATE_OFFSET_OVERFLOW,
  type CommitGraphLayer,
  GENERATION_NUMBER_V1_MAX,
  GENERATION_NUMBER_V2_OFFSET_MAX,
  GRAPH_EDGE_LAST_MASK,
  GRAPH_EXTRA_EDGES_NEEDED,
  GRAPH_HASH_VERSION_SHA1,
  GRAPH_HEADER_SIZE,
  GRAPH_LAST_EDGE,
  GRAPH_PARENT_NONE,
  GRAPH_SIGNATURE,
  GRAPH_VERSION,
  HASH_SIZE,
} from "./commit-graph-format.js";
import {
  COMMIT_GRAPH_CHAIN_FILE,
  COMMIT_GRAPH_FILE,
  COMMIT_GRAPHS_DIR,
  splitGraphFileName,
  validateMixedGenerationChain,
} from "./commit-graph-reader.js";
import { type GraphCommitData, parseGraphCommit } from "./graph-commit-parse.js";

/** How a split write treats the existing chain (git's `--split[=<strategy>]`). */
export type CommitGraphSplitStrategy = "merge" | "no-merge" | "replace";

/** What `writeCommitGraphFile` writes. */
export interface WriteCommitGraphFileOptions {
  files: FilesApi;
  /** The object directory, a path within `files` (".git/objects") */
  objectsDir: string;
  /** The objects: commits (and, for Bloom filters, trees) are read from here */
  objects: Pick<GitObjects, "get">;
  /**
   * The commits to start from: `--reachable` passes the commits the refs point to (peeled),
   * `--stdin-commits` its list. Everything they reach is written too.
   */
  commits: Iterable<ObjectId>;
  /**
   * The graph already there, as `readCommitGraph` loaded it, with its layer files (base first).
   * Needed for `append`, `split` and to keep its Bloom filters.
   */
  existing?: { graph?: CommitGraph; files: string[] };
  /** `--append`: keep the commits of the existing (top) layer too */
  append?: boolean;
  /** `--split[=strategy]`: write a new layer on the chain (true: "merge", git's default) */
  split?: boolean | CommitGraphSplitStrategy;
  /** `--size-multiple` (default 2): merge a layer not this many times larger than the new one */
  sizeMultiple?: number;
  /** `--max-commits`: merge layers while the new one has more commits than this */
  maxCommits?: number;
  /**
   * `--expire-time`, ms since the epoch (default now): layers dropped from the chain are deleted
   * when not modified after it
   */
  expireTime?: number;
  /**
   * `--changed-paths` (true) or `--no-changed-paths` (false). Undefined: filters are written
   * only when the existing graph has them (git keeps them)
   */
  changedPaths?: boolean;
  /** `--max-new-filters`: compute at most this many new filters (default: all) */
  maxNewFilters?: number;
  /** git's `commitGraph.generationVersion` (default 2: write GDA2) */
  generationVersion?: number;
  /** git's `commitGraph.changedPathsVersion` (default -1: 1, or the existing graph's) */
  changedPathsVersion?: number;
  /** The clock, ms since the epoch (default `Date.now`) */
  now?: () => number;
}

/** What `writeCommitGraphFile` did. */
export interface WriteCommitGraphFileResult {
  /** False when nothing was written (no commits, or an unsupported setting) */
  written: boolean;
  /** Commits in the file written (the new layer, for a split write) */
  commits: number;
  /** The file written */
  path?: string;
  /** The layer hashes of the chain after a split write, base first (one for a single file) */
  hashes: string[];
  /** Files deleted as expired */
  expired: string[];
  /** Messages git prints (warnings) */
  warnings: string[];
  /**
   * The objects read to write it: commits parsed from the object store (each at most once),
   * trees read for the changed-path filters (a tree read lately is not read again)
   */
  reads?: { commits: number; trees: number };
}

/** One commit being written. */
interface WriteCommit {
  id: ObjectId;
  idBytes: Uint8Array;
  data: GraphCommitData;
  /** Global position in the existing graph, or -1 */
  graphPos: number;
}

/** A commit's tree, parents and date, read from the object database (git's parse_commit_no_graph). */
async function readCommitData(
  objects: Pick<GitObjects, "get">,
  id: ObjectId,
): Promise<GraphCommitData | undefined> {
  const raw = await readRaw(objects, id);
  if (raw?.type !== "commit") return undefined;
  try {
    return parseGraphCommit(raw.data, id);
  } catch {
    return undefined;
  }
}

async function readRaw(
  objects: Pick<GitObjects, "get">,
  id: ObjectId,
): Promise<{ type: string; data: Uint8Array } | undefined> {
  let obj: Awaited<ReturnType<GitObjects["get"]>>;
  try {
    obj = await objects.get(id);
  } catch {
    return undefined;
  }
  if (!obj) return undefined;
  if (obj.bytes) return { type: obj.type, data: obj.bytes };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const c of obj.content) {
    chunks.push(c);
    size += c.length;
  }
  const data = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    data.set(c, at);
    at += c.length;
  }
  return { type: obj.type, data };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/** The commit data of graph position `pos` (git's fill_commit_in_graph). */
function graphCommitData(graph: CommitGraph, pos: number): GraphCommitData {
  return { tree: graph.treeAt(pos), parents: graph.parentsAt(pos), date: graph.commitTimeAt(pos) };
}

const SECOND = 1000;

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Writes a commit-graph as `git commit-graph write` does (see the module comment).
 *
 * @example
 * ```typescript
 * const existing = await readCommitGraph(files, ".git/objects");
 * await writeCommitGraphFile({ files, objectsDir: ".git/objects", objects, commits: tips, existing });
 * ```
 */
export async function writeCommitGraphFile(
  options: WriteCommitGraphFileOptions,
): Promise<WriteCommitGraphFileResult> {
  const { files, objectsDir, objects } = options;
  const now = options.now ?? Date.now;
  const warnings: string[] = [];
  const result = (extra: Partial<WriteCommitGraphFileResult> = {}): WriteCommitGraphFileResult => ({
    written: false,
    commits: 0,
    hashes: [],
    expired: [],
    warnings,
    ...extra,
  });
  const split: CommitGraphSplitStrategy | undefined =
    options.split === true ? "merge" : options.split === false ? undefined : options.split;
  const replace = split === "replace";
  const generationVersion = options.generationVersion ?? 2;
  let writeGenerationData = generationVersion === 2;
  const changedPathsVersion = options.changedPathsVersion ?? -1;
  if (changedPathsVersion < -1 || changedPathsVersion > 2) {
    warnings.push(
      `attempting to write a commit-graph, but 'commitGraph.changedPathsVersion' (${changedPathsVersion}) is not supported`,
    );
    return result();
  }
  const g = options.existing?.graph;
  const layersBefore = g ? [...g.layers] : [];
  const filesBefore = options.existing?.files ?? [];

  // Bloom settings: asked for, or kept from the existing graph
  const bloom: BloomFilterSettings = {
    ...DEFAULT_BLOOM_FILTER_SETTINGS,
    hashVersion: changedPathsVersion,
  };
  let changedPaths = options.changedPaths === true;
  const existingBloom = g?.bloomSettings;
  if (options.changedPaths !== false && existingBloom) {
    changedPaths = true;
    if (bloom.hashVersion === -1) bloom.hashVersion = existingBloom.hashVersion;
    bloom.bitsPerEntry = existingBloom.bitsPerEntry;
    bloom.numHashes = existingBloom.numHashes;
    bloom.maxChangedPaths = existingBloom.maxChangedPaths;
  }
  bloom.hashVersion = bloom.hashVersion === 2 ? 2 : 1;

  const numBefore = split ? layersBefore.length : 0;

  // the commits: the existing top layer's (append), then those given
  const oids: ObjectId[] = [];
  if (options.append && g) {
    const top = g.top;
    for (let i = 0; i < top.numCommits; i++) oids.push(g.idAt(top.numCommitsInBase + i));
  }
  for (const id of options.commits) oids.push(id.toLowerCase());

  // git's close_reachable: add the parents of every commit (a split write stops at the graph)
  const parsed = new Map<ObjectId, GraphCommitData>();
  const reads = { commits: 0, trees: 0 };
  const graphPos = (id: ObjectId) => (g ? g.position(id) : -1);
  const parse = async (id: ObjectId, useGraph: boolean): Promise<GraphCommitData | undefined> => {
    const known = parsed.get(id);
    if (known) return known;
    let data: GraphCommitData | undefined;
    if (useGraph && g) {
      const pos = g.position(id);
      if (pos >= 0) data = graphCommitData(g, pos);
    }
    if (!data) {
      reads.commits++;
      data = await readCommitData(objects, id);
    }
    if (data) parsed.set(id, data);
    return data;
  };
  const reachable = new Set<ObjectId>(oids);
  for (let i = 0; i < oids.length; i++) {
    const id = oids[i] as ObjectId;
    let data: GraphCommitData | undefined;
    if (split) {
      data = await parse(id, true);
      if (!data || (graphPos(id) >= 0 && !replace)) continue;
    } else {
      data = await parse(id, false);
      if (!data) continue;
    }
    for (const p of data.parents) {
      if (!reachable.has(p)) {
        reachable.add(p);
        oids.push(p);
      }
    }
  }

  // git's copy_oids_to_commits: sorted, unique; a split write leaves out what the graph has
  // lowercase hex ids sort as their bytes do
  const unique = [...new Set(oids)].sort();
  let commits: WriteCommit[] = [];
  for (const id of unique) {
    const pos = graphPos(id);
    if (split && !replace && pos >= 0) continue;
    const data = await parse(id, split === "replace");
    if (!data) throw new Error(`unable to parse commit ${id}`);
    commits.push({ id, idBytes: hexToBytes(id), data, graphPos: split ? pos : -1 });
  }
  if (commits.length >= GRAPH_EDGE_LAST_MASK) throw new Error("too many commits to write graph");
  if (commits.length === 0 && !replace) return result();

  // split: which layers merge into the new one (git's split_graph_merge_strategy)
  let numAfter = 1;
  let newBase: CommitGraphLayer | undefined;
  let newNumCommitsInBase = 0;
  let baseGraphName: string | undefined;
  const filenamesAfter: (string | undefined)[] = [];
  const hashAfter: (string | undefined)[] = [];
  if (split) {
    const sizeMult = options.sizeMultiple || 2;
    const maxCommits = options.maxCommits ?? 0;
    let num = commits.length;
    numAfter = replace ? 1 : numBefore + 1;
    let k = layersBefore.length - 1;
    if (split === "merge") {
      while (
        k >= 0 &&
        ((layersBefore[k] as CommitGraphLayer).numCommits <= sizeMult * num ||
          (maxCommits && num > maxCommits))
      ) {
        num += (layersBefore[k] as CommitGraphLayer).numCommits;
        k--;
        numAfter--;
      }
    }
    newBase = !replace && k >= 0 ? layersBefore[k] : undefined;
    for (let i = 0; i < numAfter && i < numBefore; i++) filenamesAfter[i] = filesBefore[i];
    for (let i = numBefore - 1; i >= 0; i--) {
      const layer = layersBefore[i] as CommitGraphLayer;
      if (i < numAfter) hashAfter[i] = layer.hash;
      // the generation data of the topmost remaining layer decides the new layer's
      if (i === numAfter - 2) writeGenerationData = layer.generationData !== undefined;
    }
    if (!replace) {
      // git's merge_commit_graphs: the merged layers' commits join the new layer
      let current = numBefore;
      let m = layersBefore.length - 1;
      while (m >= 0 && current >= numAfter) {
        current--;
        const layer = layersBefore[m] as CommitGraphLayer;
        for (let i = 0; i < layer.numCommits; i++) {
          const pos = layer.numCommitsInBase + i;
          const id = (g as CommitGraph).idAt(pos);
          const data = graphCommitData(g as CommitGraph, pos);
          parsed.set(id, data);
          commits.push({ id, idBytes: hexToBytes(id), data, graphPos: pos });
        }
        m--;
      }
      if (m >= 0) {
        newBase = layersBefore[m];
        newNumCommitsInBase =
          (newBase as CommitGraphLayer).numCommits + (newBase as CommitGraphLayer).numCommitsInBase;
      } else {
        newBase = undefined;
      }
      if (newBase) baseGraphName = filesBefore[m];
      commits.sort((a, b) => compareBytes(a.idBytes, b.idBytes));
      commits = commits.filter((c, i) => i === 0 || c.id !== (commits[i - 1] as WriteCommit).id);
    }
  }

  const trust = validateMixedGenerationChain(layersBefore);
  // positions of the new base, for parents outside the new layer
  const baseLayers = newBase ? layersBefore.slice(0, layersBefore.indexOf(newBase) + 1) : [];
  const basePos = (id: ObjectId): number => {
    if (!g || baseLayers.length === 0) return -1;
    const pos = g.position(id);
    return pos >= 0 && pos < newNumCommitsInBase ? pos : -1;
  };

  const index = new Map<ObjectId, number>();
  for (let i = 0; i < commits.length; i++) index.set((commits[i] as WriteCommit).id, i);

  // topological levels (CDAT) and corrected commit dates (GDA2)
  const fromGraph = (c: WriteCommit) => split !== undefined && c.graphPos >= 0;
  const topo = new Float64Array(commits.length);
  const gen = new Float64Array(commits.length);
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i] as WriteCommit;
    if (fromGraph(c)) {
      topo[i] = (g as CommitGraph).topoLevelAt(c.graphPos);
      if (trust) gen[i] = (g as CommitGraph).generationAt(c.graphPos);
    }
  }
  const outside = (id: ObjectId, what: "topo" | "gen"): number => {
    const pos = g ? g.position(id) : -1;
    if (pos < 0) return 0;
    return what === "topo"
      ? (g as CommitGraph).topoLevelAt(pos)
      : (g as CommitGraph).generationAt(pos);
  };
  computeLevels(
    commits,
    index,
    topo,
    (_c, max) => Math.min(max, GENERATION_NUMBER_V1_MAX - 1) + 1,
    (id) => outside(id, "topo"),
  );
  let overflows = 0;
  if (writeGenerationData) {
    computeLevels(
      commits,
      index,
      gen,
      (c, max) => {
        const date = c.data.date;
        let m = max;
        if (date && date > m) m = date - 1;
        return m + 1;
      },
      (id) => outside(id, "gen"),
    );
    for (let i = 0; i < commits.length; i++) {
      if (
        generationOffset(commits[i] as WriteCommit, gen[i] as number) >
        GENERATION_NUMBER_V2_OFFSET_MAX
      )
        overflows++;
    }
  }

  // changed-path filters
  let filters: (Uint8Array | undefined)[] | undefined;
  if (changedPaths) {
    filters = await computeFilters(
      commits,
      index,
      gen,
      objects,
      bloom,
      g,
      options.maxNewFilters,
      reads,
    );
  }

  // positions of parents
  const parentPos = (c: WriteCommit, p: ObjectId): number => {
    const i = index.get(p);
    if (i !== undefined) return i + newNumCommitsInBase;
    const pos = basePos(p);
    if (pos < 0) throw new Error(`missing parent ${p} for commit ${c.id}`);
    return pos;
  };
  let extraEdges = 0;
  for (const c of commits) if (c.data.parents.length > 2) extraEdges += c.data.parents.length - 1;

  // the chunks, in git's order
  const n = commits.length;
  const chunks: { id: number; size: number; write: (w: Writer) => void }[] = [];
  chunks.push({
    id: CHUNK_OID_FANOUT,
    size: 1024,
    write: (w) => {
      let count = 0;
      for (let b = 0; b < 256; b++) {
        while (count < n && (commits[count] as WriteCommit).idBytes[0] === b) count++;
        w.u32(count);
      }
    },
  });
  chunks.push({
    id: CHUNK_OID_LOOKUP,
    size: HASH_SIZE * n,
    write: (w) => {
      for (const c of commits) w.bytes(c.idBytes);
    },
  });
  chunks.push({
    id: CHUNK_COMMIT_DATA,
    size: (HASH_SIZE + 16) * n,
    write: (w) => {
      let edges = 0;
      for (let i = 0; i < n; i++) {
        const c = commits[i] as WriteCommit;
        const parents = c.data.parents;
        w.hex(c.data.tree);
        w.u32(parents.length === 0 ? GRAPH_PARENT_NONE : parentPos(c, parents[0] as ObjectId));
        if (parents.length < 2) w.u32(GRAPH_PARENT_NONE);
        else if (parents.length > 2) {
          w.u32((GRAPH_EXTRA_EDGES_NEEDED | edges) >>> 0);
          edges += parents.length - 1;
        } else w.u32(parentPos(c, parents[1] as ObjectId));
        const date = c.data.date;
        const high = Math.floor(date / 0x100000000) & 0x3;
        w.u32(((topo[i] as number) * 4 + high) >>> 0);
        w.u32((date % 0x100000000) >>> 0);
      }
    },
  });
  if (writeGenerationData) {
    chunks.push({
      id: CHUNK_GENERATION_DATA,
      size: 4 * n,
      write: (w) => {
        let k = 0;
        for (let i = 0; i < n; i++) {
          let offset = generationOffset(commits[i] as WriteCommit, gen[i] as number);
          if (offset > GENERATION_NUMBER_V2_OFFSET_MAX)
            offset = (CORRECTED_COMMIT_DATE_OFFSET_OVERFLOW | k++) >>> 0;
          w.u32(offset);
        }
      },
    });
  }
  if (overflows) {
    chunks.push({
      id: CHUNK_GENERATION_DATA_OVERFLOW,
      size: 8 * overflows,
      write: (w) => {
        for (let i = 0; i < n; i++) {
          const offset = generationOffset(commits[i] as WriteCommit, gen[i] as number);
          if (offset > GENERATION_NUMBER_V2_OFFSET_MAX) {
            w.u32(Math.floor(offset / 0x100000000) >>> 0);
            w.u32((offset % 0x100000000) >>> 0);
          }
        }
      },
    });
  }
  if (extraEdges) {
    chunks.push({
      id: CHUNK_EXTRA_EDGES,
      size: 4 * extraEdges,
      write: (w) => {
        for (const c of commits) {
          const parents = c.data.parents;
          if (parents.length <= 2) continue;
          for (let k = 1; k < parents.length; k++) {
            let edge = parentPos(c, parents[k] as ObjectId);
            if (k === parents.length - 1) edge = (edge | GRAPH_LAST_EDGE) >>> 0;
            w.u32(edge);
          }
        }
      },
    });
  }
  if (filters) {
    const list = filters;
    const total = list.reduce((s, f) => s + (f?.length ?? 0), 0);
    chunks.push({
      id: CHUNK_BLOOM_INDEXES,
      size: 4 * n,
      write: (w) => {
        let end = 0;
        for (const f of list) {
          end += f?.length ?? 0;
          w.u32(end);
        }
      },
    });
    chunks.push({
      id: CHUNK_BLOOM_DATA,
      size: 12 + total,
      write: (w) => {
        w.u32(bloom.hashVersion);
        w.u32(bloom.numHashes);
        w.u32(bloom.bitsPerEntry);
        for (const f of list) if (f) w.bytes(f);
      },
    });
  }
  if (numAfter > 1) {
    chunks.push({
      id: CHUNK_BASE,
      size: HASH_SIZE * (numAfter - 1),
      write: (w) => {
        for (const layer of baseLayers) w.bytes(hexToBytes(layer.hash));
      },
    });
    if (baseLayers.length !== numAfter - 1) {
      throw new Error("failed to write correct number of base graph ids");
    }
  }

  const tocSize = (chunks.length + 1) * CHUNK_TOC_ENTRY_SIZE;
  const body = chunks.reduce((s, c) => s + c.size, 0);
  const w = new Writer(GRAPH_HEADER_SIZE + tocSize + body + HASH_SIZE);
  w.u32(GRAPH_SIGNATURE);
  w.u8(GRAPH_VERSION);
  w.u8(GRAPH_HASH_VERSION_SHA1);
  w.u8(chunks.length);
  w.u8(numAfter - 1);
  let offset = GRAPH_HEADER_SIZE + tocSize;
  for (const c of chunks) {
    w.u32(c.id);
    w.u64(offset);
    offset += c.size;
  }
  w.u32(0);
  w.u64(offset);
  for (const c of chunks) {
    const start = w.at;
    c.write(w);
    if (w.at - start !== c.size) {
      throw new Error(
        `expected to write ${c.size} bytes to chunk ${c.id.toString(16)}, but wrote ${w.at - start} instead`,
      );
    }
  }
  const hash = createSha1().update(w.buf.subarray(0, w.at)).digest();
  w.bytes(hash);
  const fileHash = bytesToHex(hash);
  const content = w.buf;

  // the files
  const atomic = atomicFilesOver(files, objectsDir);
  let path: string;
  const hashes: string[] = [];
  if (!split) {
    path = COMMIT_GRAPH_FILE;
    await writeLocked(atomic, objectsDir, path, async (lock) => {
      await atomic.write(lock, content);
      await chmod(files, joinPath(objectsDir, lock), 0o444);
    });
    hashes.push(fileHash);
  } else {
    if (baseGraphName && numAfter > 1) {
      const baseHash = (newBase as CommitGraphLayer).hash;
      filenamesAfter[numAfter - 2] = joinPath(objectsDir, splitGraphFileName(baseHash));
      hashAfter[numAfter - 2] = baseHash;
    }
    path = splitGraphFileName(fileHash);
    await writeLocked(atomic, objectsDir, COMMIT_GRAPH_CHAIN_FILE, async (lock) => {
      // the layer, through a temporary
      const tmp = `${COMMIT_GRAPHS_DIR}/tmp_graph_${randomSuffix()}`;
      await atomic.write(tmp, content);
      await chmod(files, joinPath(objectsDir, tmp), 0o444);
      if (baseGraphName) {
        const dest = filenamesAfter[numAfter > 1 ? numAfter - 2 : numAfter - 1] as string;
        if (baseGraphName !== dest) await files.move(baseGraphName, dest);
      } else {
        await files.remove(joinPath(objectsDir, COMMIT_GRAPH_FILE));
      }
      hashAfter[numAfter - 1] = fileHash;
      filenamesAfter[numAfter - 1] = joinPath(objectsDir, path);
      await atomic.replace(tmp, path);
      for (let i = 0; i < numAfter; i++) hashes.push(hashAfter[i] as string);
      await atomic.write(lock, new TextEncoder().encode(hashes.map((h) => `${h}\n`).join("")));
    });
  }

  // expire: layers dropped from the chain (all of them after a single-file write)
  // one clock read: the layers merged away count as modified now (git's mark_commit_graphs),
  // and the default expire time is that same now, so they are always expired as in git
  const nowMs = now();
  const expireTime = options.expireTime ?? nowMs;
  const touched = new Set<string>();
  if (split) {
    for (let i = numAfter - 1; i < numBefore; i++) {
      const f = filesBefore[i];
      if (f) touched.add(baseName(f));
    }
  }
  const expired: string[] = [];
  const keep = new Set<string>();
  if (!split) {
    await files.remove(joinPath(objectsDir, COMMIT_GRAPH_CHAIN_FILE));
  } else {
    for (const f of filenamesAfter) if (f) keep.add(baseName(f));
  }
  const dir = joinPath(objectsDir, COMMIT_GRAPHS_DIR);
  if ((await files.stats(dir))?.kind === "directory") {
    for await (const e of files.list(dir)) {
      if (e.kind !== "file") continue;
      const mtime = touched.has(e.name)
        ? nowMs
        : (e.lastModified ?? (await files.stats(e.path))?.lastModified ?? nowMs);
      if (Math.floor(mtime / SECOND) > Math.floor(expireTime / SECOND)) continue;
      if (!e.name.endsWith(".graph")) continue;
      if (keep.has(e.name)) continue;
      if (await files.remove(e.path)) expired.push(e.path);
    }
    // git's mark_commit_graphs sets the mtime of the layers merged away to now, so a later
    // write keeps them until --expire-time passes it: the FilesApi has no utime, so the file
    // is copied and the copy renamed over it (a new file, of the current time). A copy a crash
    // leaves behind is not swept later, as git sweeps none of its own `tmp_graph_*` files
    // (expire_commit_graphs removes `.graph` files only; prune cleans objects/pack only)
    for (const name of touched) {
      const path = joinPath(dir, name);
      if (keep.has(name) || expired.includes(path)) continue;
      if ((await files.stats(path))?.kind !== "file") continue;
      const tmp = joinPath(dir, `tmp_graph_${randomSuffix()}`);
      try {
        if (!(await files.copy(path, tmp))) continue;
        await chmod(files, tmp, 0o444);
        await files.move(tmp, path);
      } catch {
        // the mtime only delays the expiry
        await files.remove(tmp).catch(() => false);
      }
    }
  }

  return {
    written: true,
    commits: n,
    path: joinPath(objectsDir, path),
    hashes,
    expired,
    warnings,
    reads,
  };
}

/** git's compute_generation_offset (2.56: against the 34 bits of the date the graph keeps). */
function generationOffset(c: WriteCommit, generation: number): number {
  return generation - (c.data.date % 0x400000000);
}

/**
 * git's compute_reachable_generation_numbers: a level for every commit without one (0), from
 * its parents' (parents outside the list come from `outside`), iteratively.
 */
function computeLevels(
  commits: WriteCommit[],
  index: Map<ObjectId, number>,
  levels: Float64Array,
  next: (c: WriteCommit, maxParent: number) => number,
  outside: (id: ObjectId) => number,
): void {
  const stack: number[] = [];
  for (let i = 0; i < commits.length; i++) {
    if (levels[i] !== 0) continue;
    stack.push(i);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as number;
      const c = commits[top] as WriteCommit;
      let max = 0;
      let ready = true;
      for (const p of c.data.parents) {
        const pi = index.get(p);
        const level = pi === undefined ? outside(p) : (levels[pi] as number);
        if (level === 0 && pi !== undefined) {
          ready = false;
          stack.push(pi);
          break;
        }
        if (level > max) max = level;
      }
      if (ready) {
        stack.pop();
        levels[top] = next(c, max);
      }
    }
  }
}

/** The changed-path filters of the commits (git's compute_bloom_filters), in id order. */
async function computeFilters(
  commits: WriteCommit[],
  index: Map<ObjectId, number>,
  gen: Float64Array,
  objects: Pick<GitObjects, "get">,
  settings: BloomFilterSettings,
  existing: CommitGraph | undefined,
  maxNewFilters: number | undefined,
  reads: { commits: number; trees: number },
): Promise<(Uint8Array | undefined)[]> {
  const filters: (Uint8Array | undefined)[] = new Array(commits.length);
  // commit_gen_cmp: lower generation first, then older
  const order = commits.map((_, i) => i);
  order.sort((a, b) => {
    const ga = gen[a] as number;
    const gb = gen[b] as number;
    if (ga !== gb) return ga - gb;
    return (commits[a] as WriteCommit).data.date - (commits[b] as WriteCommit).data.date;
  });
  const limit = maxNewFilters !== undefined && maxNewFilters >= 0 ? maxNewFilters : commits.length;
  let computed = 0;
  const trees = new TreeReader(objects);
  // the parent's tree without reading the parent again: from the commits written, the graph,
  // or (a parent outside both) the object database
  const commitTree = async (id: ObjectId): Promise<ObjectId | undefined> => {
    const i = index.get(id);
    if (i !== undefined) return (commits[i] as WriteCommit).data.tree;
    const pos = existing ? existing.position(id) : -1;
    if (pos >= 0) return (existing as CommitGraph).treeAt(pos);
    reads.commits++;
    return (await readCommitData(objects, id))?.tree;
  };
  for (const i of order) {
    const c = commits[i] as WriteCommit;
    const pos = existing ? existing.position(c.id) : -1;
    const stored = pos >= 0 ? existing?.bloomFilterAt(pos) : undefined;
    if (stored && stored.data.length > 0) {
      // reused as it is; one of another hash version only when no new filter may be computed
      if (stored.settings.hashVersion === settings.hashVersion || computed >= limit) {
        filters[i] = stored.data;
        continue;
      }
    }
    if (computed >= limit) continue;
    const parent = c.data.parents[0];
    const parentTree = parent ? await commitTree(parent) : undefined;
    const found = changedPaths(trees, parentTree, c.data.tree, settings.maxChangedPaths);
    const paths = found instanceof Promise ? await found : found;
    filters[i] = paths ? computeBloomFilter(paths, settings) : Uint8Array.of(0xff);
    computed++;
  }
  reads.trees += trees.reads;
  return filters;
}

const EMPTY = new Uint8Array(0);

/** How many raw trees `TreeReader` keeps (a commit's diff mostly reads its parent's trees). */
const TREE_CACHE_SIZE = 4096;

/**
 * Reads raw trees for the filters. Trees are kept as their bytes (the oldest dropped):
 * consecutive commits share most of their trees, which git finds again in its delta
 * base cache. A tree is never decoded: the diff walks its bytes.
 */
class TreeReader {
  private readonly cache = new Map<ObjectId, Uint8Array>();
  /** Trees read from the object database (for tests) */
  reads = 0;

  constructor(private readonly objects: Pick<GitObjects, "get">) {}

  /** The tree's bytes, without a promise when cached or held in memory by the store. */
  tree(id: ObjectId): Uint8Array | Promise<Uint8Array> {
    // first in, first out: a diff reads the trees of the commit just before it
    const cached = this.cache.get(id);
    if (cached) return cached;
    this.reads++;
    let obj: ReturnType<GitObjects["get"]> | Awaited<ReturnType<GitObjects["get"]>>;
    try {
      const objects = this.objects as Pick<GitObjects, "get" | "getNow">;
      obj = objects.getNow ? objects.getNow(id) : objects.get(id);
    } catch {
      obj = undefined;
    }
    if (obj instanceof Promise) {
      return obj.then(
        (o) => this.loaded(id, o),
        () => this.loaded(id, undefined),
      );
    }
    return this.loaded(id, obj);
  }

  private loaded(
    id: ObjectId,
    obj: Awaited<ReturnType<GitObjects["get"]>>,
  ): Uint8Array | Promise<Uint8Array> {
    if (!obj) throw new Error(`unable to read tree ${id}`);
    if (!obj.bytes) {
      return readRaw(this.objects, id).then((raw) => {
        if (!raw) throw new Error(`unable to read tree ${id}`);
        return this.keep(id, raw.type, raw.data);
      });
    }
    return this.keep(id, obj.type, obj.bytes);
  }

  private keep(id: ObjectId, type: string, data: Uint8Array): Uint8Array | Promise<Uint8Array> {
    if (type === "commit") return this.tree(parseGraphCommit(data, id).tree);
    if (type !== "tree") throw new Error(`object ${id} is not a tree`);
    this.cache.set(id, data);
    if (this.cache.size > TREE_CACHE_SIZE) {
      this.cache.delete(this.cache.keys().next().value as ObjectId);
    }
    return data;
  }
}

const isTree = (mode: number) => (mode & 0o170000) === 0o040000;

/**
 * A cursor over a raw tree's entries: `at` is where the current entry starts; `next()` reads
 * its mode, where its name ends (the NUL, then the id) and moves `at` past it.
 */
class Entries {
  at = 0;
  mode = 0;
  name = 0;
  nul = 0;
  constructor(readonly d: Uint8Array) {}
  get done(): boolean {
    return this.at >= this.d.length;
  }
  /** Decodes the entry at `at` (mode, name start, NUL). */
  read(): void {
    const d = this.d;
    let p = this.at;
    let mode = 0;
    while (p < d.length && d[p] !== 0x20) mode = mode * 8 + ((d[p++] as number) - 0x30);
    this.mode = mode;
    this.name = ++p;
    while (p < d.length && d[p] !== 0) p++;
    this.nul = p;
  }
  skip(): void {
    this.at = this.nul + 1 + HASH_SIZE;
  }
  nameBytes(): Uint8Array {
    return this.d.subarray(this.name, this.nul);
  }
  id(): ObjectId {
    return bytesToHex(this.d.subarray(this.nul + 1, this.nul + 1 + HASH_SIZE));
  }
}

/**
 * Whether the entries at the cursors are byte for byte the same (mode, name and id): the
 * common case, settled in one pass without decoding either. When it returns true both
 * cursors are past their entries.
 */
function sameRawEntry(a: Entries, b: Entries): boolean {
  const da = a.d;
  const db = b.d;
  let pa = a.at;
  let pb = b.at;
  const la = da.length;
  for (;;) {
    if (pa >= la || pb >= db.length) return false;
    const c = da[pa] as number;
    if (c !== db[pb]) return false;
    pa++;
    pb++;
    if (c === 0) break;
  }
  if (pa + HASH_SIZE > la || pb + HASH_SIZE > db.length) return false;
  for (let k = 0; k < HASH_SIZE; k++) if (da[pa + k] !== db[pb + k]) return false;
  a.at = pa + HASH_SIZE;
  b.at = pb + HASH_SIZE;
  return true;
}

/**
 * git's base_name_compare of the decoded entries at two cursors: names byte by byte, a
 * tree's name followed by "/".
 */
function compareEntries(a: Entries, b: Entries): number {
  const ad = a.d;
  const bd = b.d;
  let pa = a.name;
  let pb = b.name;
  while (pa < a.nul && pb < b.nul) {
    const d = (ad[pa] as number) - (bd[pb] as number);
    if (d !== 0) return d;
    pa++;
    pb++;
  }
  const ca = pa < a.nul ? (ad[pa] as number) : isTree(a.mode) ? 0x2f : 0;
  const cb = pb < b.nul ? (bd[pb] as number) : isTree(b.mode) ? 0x2f : 0;
  return ca - cb;
}

/** Whether the decoded entries at two cursors (of one name) have the same mode and id. */
function sameModeAndId(a: Entries, b: Entries): boolean {
  if (a.mode !== b.mode) return false;
  for (let k = 1; k <= HASH_SIZE; k++) if (a.d[a.nul + k] !== b.d[b.nul + k]) return false;
  return true;
}

const latin1 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] as number);
  return s;
};

/**
 * The changed paths between two trees with every leading directory (git's diff_tree_oid with
 * `recursive`, then the path map of get_or_compute_bloom_filter); undefined when more than
 * `max` files changed (the "too large" filter). The trees are walked side by side in git's
 * tree order over their raw bytes: an entry the same on both sides (most of them) is skipped
 * after one comparison of its bytes, and only differing subtrees are read.
 */
function changedPaths(
  trees: TreeReader,
  from: ObjectId | undefined,
  to: ObjectId,
  max: number,
): Uint8Array[] | undefined | Promise<Uint8Array[] | undefined> {
  return runSteps(changedPathsSteps(trees, from, to, max));
}

/** `changedPaths` for `runSteps`: it yields only for trees not in memory. */
function* changedPathsSteps(
  trees: TreeReader,
  from: ObjectId | undefined,
  to: ObjectId,
  max: number,
): Steps<Uint8Array[] | undefined> {
  const leaves: Uint8Array[] = [];
  const concat = (prefix: Uint8Array, name: Uint8Array) => {
    if (prefix.length === 0) return name;
    const out = new Uint8Array(prefix.length + 1 + name.length);
    out.set(prefix);
    out[prefix.length] = 0x2f;
    out.set(name, prefix.length + 1);
    return out;
  };
  let tooMany = false;
  const leaf = (path: Uint8Array) => {
    leaves.push(path);
    if (leaves.length > max) tooMany = true;
  };
  const read = function* (id: ObjectId): Steps<Uint8Array> {
    const t = trees.tree(id);
    return t instanceof Promise ? ((yield t) as Uint8Array) : t;
  };
  // every file of a tree added or deleted
  const all = function* (tree: ObjectId, prefix: Uint8Array): Steps<void> {
    const e = new Entries(yield* read(tree));
    while (!e.done && !tooMany) {
      e.read();
      const path = concat(prefix, e.nameBytes());
      const sub = isTree(e.mode) ? e.id() : undefined;
      e.skip();
      if (sub) yield* all(sub, path);
      else leaf(path);
    }
  };
  // the decoded entry at a cursor, on one side only: a file is a leaf, a tree's files are
  const one = function* (e: Entries, prefix: Uint8Array): Steps<void> {
    const path = concat(prefix, e.nameBytes());
    const sub = isTree(e.mode) ? e.id() : undefined;
    e.skip();
    if (sub) yield* all(sub, path);
    else leaf(path);
  };
  const diff = function* (a: ObjectId | undefined, b: ObjectId, prefix: Uint8Array): Steps<void> {
    const ea = new Entries(a ? yield* read(a) : EMPTY);
    const eb = new Entries(yield* read(b));
    while (!tooMany) {
      if (ea.done) {
        if (eb.done) break;
        eb.read();
        yield* one(eb, prefix);
        continue;
      }
      if (eb.done) {
        ea.read();
        yield* one(ea, prefix);
        continue;
      }
      if (sameRawEntry(ea, eb)) continue;
      ea.read();
      eb.read();
      const cmp = compareEntries(ea, eb);
      if (cmp < 0) {
        yield* one(ea, prefix);
      } else if (cmp > 0) {
        yield* one(eb, prefix);
      } else {
        if (!sameModeAndId(ea, eb)) {
          if (isTree(ea.mode) && isTree(eb.mode)) {
            const path = concat(prefix, ea.nameBytes());
            const subA = ea.id();
            const subB = eb.id();
            ea.skip();
            eb.skip();
            yield* diff(subA, subB, path);
            continue;
          }
          // same name, both files (a tree sorts apart from a file of its name)
          leaf(concat(prefix, eb.nameBytes()));
        }
        ea.skip();
        eb.skip();
      }
    }
  };
  yield* diff(from, to, EMPTY);
  if (tooMany) return undefined;
  const set = new Map<string, Uint8Array>();
  for (const leaf of leaves) {
    let end = leaf.length;
    let path = leaf;
    for (;;) {
      const key = latin1(path);
      if (set.has(key)) break;
      set.set(key, path);
      end = path.lastIndexOf(0x2f);
      if (end <= 0) break;
      path = path.subarray(0, end);
    }
  }
  return [...set.values()];
}

/** A growing big-endian buffer of a known size. */
class Writer {
  readonly buf: Uint8Array;
  private readonly view: DataView;
  at = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }
  u8(v: number) {
    this.buf[this.at++] = v;
  }
  u32(v: number) {
    this.view.setUint32(this.at, v >>> 0);
    this.at += 4;
  }
  u64(v: number) {
    this.view.setBigUint64(this.at, BigInt(v));
    this.at += 8;
  }
  bytes(b: Uint8Array) {
    this.buf.set(b, this.at);
    this.at += b.length;
  }
  /** A 40-digit lowercase hex id as its 20 bytes. */
  hex(id: string) {
    const buf = this.buf;
    for (let i = 0; i < 20; i++) {
      const hi = id.charCodeAt(2 * i);
      const lo = id.charCodeAt(2 * i + 1);
      buf[this.at++] =
        (((hi > 57 ? hi - 87 : hi - 48) << 4) | (lo > 57 ? lo - 87 : lo - 48)) & 0xff;
    }
  }
}

function randomSuffix(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(6))) s += chars[b % chars.length];
  return s;
}

/** Sets a file's mode where the FilesApi can (git writes graph files 0444). */
async function chmod(files: FilesApi, path: string, mode: number): Promise<void> {
  const posix = files as PosixFilesApi;
  if (typeof posix.chmod === "function") {
    try {
      await posix.chmod(path, mode);
    } catch {
      // the mode is advisory
    }
  }
}

/**
 * git's lock-file protocol for `target` (relative to `objectsDir`): `<target>.lock` created
 * exclusively, filled by `fill`, renamed over `target`; removed on failure.
 */
async function writeLocked(
  atomic: ReturnType<typeof atomicFilesOver>,
  objectsDir: string,
  target: string,
  fill: (lock: string) => Promise<void>,
): Promise<void> {
  const lock = `${target}.lock`;
  if (!(await atomic.createExclusive(lock, new Uint8Array(0)))) {
    throw new Error(
      `Unable to create '${joinPath(objectsDir, lock)}': File exists.\n\nAnother git process seems to be running in this repository.`,
    );
  }
  try {
    await fill(lock);
    await atomic.replace(lock, target);
  } catch (e) {
    await atomic.remove(lock);
    throw e;
  }
}
