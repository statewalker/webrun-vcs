/**
 * One commit-graph file (a layer), as git's `commit-graph.c` parses it (`parse_commit_graph`,
 * Documentation/gitformat-commit-graph):
 *
 * ```text
 * header   "CGPH" | version 1 | hash version (1: SHA-1, 2: SHA-256) | chunk count | base graph count
 * TOC      (chunk count + 1) entries of chunk id (4 bytes) and offset (8 bytes), the last id 0
 * OIDF     256 fanout counts (4 bytes each)
 * OIDL     the commit ids, sorted
 * CDAT     per commit: tree id, parent 1, parent 2 (graph positions, 0x70000000 for none, or
 *          0x80000000 | an EDGE index for an octopus), 30 bits of topological level and the
 *          top 2 bits of the commit date, the low 32 bits of the date
 * GDA2     per commit: corrected commit date minus commit date (bit 31: a GDO2 index)
 * GDO2     64-bit offsets too large for GDA2
 * EDGE     the second and later parents of octopus merges (bit 31 marks the last)
 * BIDX     per commit: the end of its changed-path Bloom filter in BDAT
 * BDAT     hash version, hash count, bits per entry, then the filters
 * BASE     the checksums of the layers below this one (split chains)
 * trailer  the hash of everything before it (SHA-1, or SHA-256 in a SHA-256 repository)
 * ```
 *
 * Ids, the BASE checksums and the trailer are `rawLength` bytes of the repository's object
 * format (git's `rawsz`), and the header's hash version is the format's (`oid_version`): a
 * layer is parsed for the format it is read in (`CommitGraphReadSettings.objectFormat`), never
 * guessed from its length.
 *
 * Validation is git's on load: signature, version, hash version, the size of the table of
 * contents and of each chunk, the fanout order. The checksum is checked only by `verify`.
 */

import { type ObjectFormat, SHA1_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";

export const GRAPH_SIGNATURE = 0x43475048; // "CGPH"
export const GRAPH_VERSION = 1;
/** git's `oid_version` of SHA-1. */
export const GRAPH_HASH_VERSION_SHA1 = 1;
export const CHUNK_OID_FANOUT = 0x4f494446; // "OIDF"
export const CHUNK_OID_LOOKUP = 0x4f49444c; // "OIDL"
export const CHUNK_COMMIT_DATA = 0x43444154; // "CDAT"
export const CHUNK_GENERATION_DATA = 0x47444132; // "GDA2"
export const CHUNK_GENERATION_DATA_OVERFLOW = 0x47444f32; // "GDO2"
export const CHUNK_EXTRA_EDGES = 0x45444745; // "EDGE"
export const CHUNK_BLOOM_INDEXES = 0x42494458; // "BIDX"
export const CHUNK_BLOOM_DATA = 0x42444154; // "BDAT"
export const CHUNK_BASE = 0x42415345; // "BASE"

export const GRAPH_EXTRA_EDGES_NEEDED = 0x80000000;
export const GRAPH_EDGE_LAST_MASK = 0x7fffffff;
export const GRAPH_PARENT_NONE = 0x70000000;
export const GRAPH_LAST_EDGE = 0x80000000;
export const GRAPH_HEADER_SIZE = 8;
export const GRAPH_FANOUT_SIZE = 4 * 256;
export const CHUNK_TOC_ENTRY_SIZE = 12;
/** A SHA-1 id's bytes (a layer's own width is `CommitGraphLayer.hashSize`). */
export const HASH_SIZE = 20;
/** A SHA-1 layer's CDAT record: tree id, two parent positions, generation and date. */
export const GRAPH_DATA_WIDTH = HASH_SIZE + 16;

/** git's graph_data_width: a CDAT record of ids `rawLength` bytes wide. */
export function graphDataWidth(rawLength: number): number {
  return rawLength + 16;
}

/** git's graph_min_size for ids `rawLength` bytes wide. */
export function graphMinSize(rawLength: number): number {
  return GRAPH_HEADER_SIZE + 4 * CHUNK_TOC_ENTRY_SIZE + GRAPH_FANOUT_SIZE + rawLength;
}
export const CORRECTED_COMMIT_DATE_OFFSET_OVERFLOW = 0x80000000;
/** git's GENERATION_NUMBER_V1_MAX: the largest topological level CDAT holds. */
export const GENERATION_NUMBER_V1_MAX = 0x3fffffff;
/** git's GENERATION_NUMBER_V2_OFFSET_MAX: the largest offset GDA2 holds inline. */
export const GENERATION_NUMBER_V2_OFFSET_MAX = 0x7fffffff;
/** The BDAT header: hash version, number of hashes, bits per entry. */
export const BLOOMDATA_CHUNK_HEADER_SIZE = 12;
/** git's DEFAULT_BLOOM_MAX_CHANGES. */
export const DEFAULT_BLOOM_MAX_CHANGES = 512;

/** git's graph_min_size of a SHA-1 layer: header, four TOC entries, the fanout and the trailer. */
export const GRAPH_MIN_SIZE = graphMinSize(HASH_SIZE);

/** The changed-path Bloom filter settings of a layer (BDAT's header). */
export interface BloomFilterSettings {
  /** 1: murmur3 over signed chars (git before 2.46 and `changedPathsVersion=1`); 2: unsigned */
  hashVersion: number;
  /** Hashes per key (git: 7) */
  numHashes: number;
  /** Filter bits per changed path (git: 10) */
  bitsPerEntry: number;
  /** Paths above which a commit gets the "too large" filter (git: 512) */
  maxChangedPaths: number;
}

/** A message git prints while loading a graph (`error:` or `warning:`). */
export interface CommitGraphDiagnostic {
  level: "error" | "warning";
  message: string;
}

/** What `parseCommitGraphLayer` reads besides the bytes. */
export interface CommitGraphReadSettings {
  /** git's `commitGraph.generationVersion` (default 2): GDA2/GDO2 are read only at 2 or more */
  generationVersion?: number;
  /**
   * git's `commitGraph.changedPathsVersion` (default -1; `commitGraph.readChangedPaths=false`
   * makes it 0): BIDX/BDAT are read unless it is 0
   */
  changedPathsVersion?: number;
  /**
   * The repository's object format (default SHA-1): the header's hash version must be its
   * `version`, and ids, BASE entries and the trailer are its `rawLength` bytes wide
   */
  objectFormat?: ObjectFormat;
}

/** A chunk's place in the file. */
interface ChunkRef {
  offset: number;
  size: number;
}

/**
 * One parsed commit-graph file. Positions are local here (0 to `numCommits - 1`); a chain
 * adds `numCommitsInBase`.
 */
export class CommitGraphLayer {
  /** The file's checksum (its trailer), hex: a split layer's name `graph-<hash>.graph` */
  readonly hash: string;
  readonly numCommits: number;
  /** Commits in the layers below (set when the layer joins a chain) */
  numCommitsInBase = 0;
  /** Whether GDA2 is used (git's `read_generation_data`; a chain turns it off unless every layer has one) */
  readGenerationData: boolean;
  /** The changed-path filter settings, when both BIDX and BDAT are read */
  bloomSettings?: BloomFilterSettings;
  /** The number of base layers the header claims (byte 7) */
  readonly headerBaseCount: number;
  /** The chunk ids in the order of the table of contents */
  readonly chunkIds: number[];
  /** The object format the layer was read in */
  readonly objectFormat: ObjectFormat;
  /** Bytes of an id (the format's `rawLength`: git's `rawsz`) */
  readonly hashSize: number;
  /** Bytes of a CDAT record (`hashSize + 16`) */
  readonly dataWidth: number;

  readonly fanout: ChunkRef;
  readonly oidLookup: ChunkRef;
  readonly commitData: ChunkRef;
  readonly generationData?: ChunkRef;
  readonly generationOverflow?: ChunkRef;
  readonly extraEdges?: ChunkRef;
  readonly baseGraphs?: ChunkRef;
  bloomIndexes?: ChunkRef;
  bloomData?: ChunkRef;

  private readonly view: DataView;

  constructor(
    readonly bytes: Uint8Array,
    /** Where the layer was read from (for messages), if from a file */
    readonly path: string | undefined,
    parts: {
      numCommits: number;
      headerBaseCount: number;
      chunkIds: number[];
      fanout: ChunkRef;
      oidLookup: ChunkRef;
      commitData: ChunkRef;
      generationData?: ChunkRef;
      generationOverflow?: ChunkRef;
      extraEdges?: ChunkRef;
      baseGraphs?: ChunkRef;
      bloomIndexes?: ChunkRef;
      bloomData?: ChunkRef;
      bloomSettings?: BloomFilterSettings;
    },
    objectFormat: ObjectFormat = SHA1_OBJECT_FORMAT,
  ) {
    this.objectFormat = objectFormat;
    this.hashSize = objectFormat.rawLength;
    this.dataWidth = graphDataWidth(this.hashSize);
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.numCommits = parts.numCommits;
    this.headerBaseCount = parts.headerBaseCount;
    this.chunkIds = parts.chunkIds;
    this.fanout = parts.fanout;
    this.oidLookup = parts.oidLookup;
    this.commitData = parts.commitData;
    this.generationData = parts.generationData;
    this.generationOverflow = parts.generationOverflow;
    this.extraEdges = parts.extraEdges;
    this.baseGraphs = parts.baseGraphs;
    this.bloomIndexes = parts.bloomIndexes;
    this.bloomData = parts.bloomData;
    this.bloomSettings = parts.bloomSettings;
    this.readGenerationData = parts.generationData !== undefined;
    this.hash = bytesToHex(bytes.subarray(bytes.length - this.hashSize));
  }

  /** A big-endian 32-bit value at `offset`. */
  u32(offset: number): number {
    return this.view.getUint32(offset);
  }

  /** The fanout count of first byte `b` (commits with a first id byte at most `b`). */
  fanoutAt(b: number): number {
    return this.u32(this.fanout.offset + 4 * b);
  }

  /** The id bytes of local position `i`. */
  oidBytes(i: number): Uint8Array {
    const at = this.oidLookup.offset + this.hashSize * i;
    return this.bytes.subarray(at, at + this.hashSize);
  }

  /** The local position of `id` (`hashSize` bytes), or -1 (git's bsearch_hash over the fanout). */
  find(id: Uint8Array): number {
    const first = id[0] as number;
    let lo = first === 0 ? 0 : this.fanoutAt(first - 1);
    let hi = this.fanoutAt(first);
    const bytes = this.bytes;
    const base = this.oidLookup.offset;
    const size = this.hashSize;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const at = base + size * mid;
      let cmp = 0;
      for (let k = 0; k < size; k++) {
        const d = (bytes[at + k] as number) - (id[k] as number);
        if (d !== 0) {
          cmp = d;
          break;
        }
      }
      if (cmp === 0) return mid;
      if (cmp < 0) lo = mid + 1;
      else hi = mid;
    }
    return -1;
  }

  /** The offset of local position `i`'s CDAT record. */
  dataOffset(i: number): number {
    return this.commitData.offset + this.dataWidth * i;
  }

  /** The commit date of local position `i` (34 bits, as git stores it). */
  commitDate(i: number): number {
    const at = this.dataOffset(i) + this.hashSize + 8;
    return (this.u32(at) & 0x3) * 0x100000000 + this.u32(at + 4);
  }

  /** The topological level of local position `i` (CDAT's 30 bits: generation v1). */
  topoLevel(i: number): number {
    return this.u32(this.dataOffset(i) + this.hashSize + 8) >>> 2;
  }

  /** The changed-path filter of local position `i`, or undefined (git's load_bloom_filter_from_graph). */
  bloomFilter(i: number): Uint8Array | undefined {
    const { bloomIndexes, bloomData } = this;
    if (!bloomIndexes || !bloomData) return undefined;
    const end = this.u32(bloomIndexes.offset + 4 * i);
    const start = i > 0 ? this.u32(bloomIndexes.offset + 4 * (i - 1)) : 0;
    const max = bloomData.size - BLOOMDATA_CHUNK_HEADER_SIZE;
    if (end > max || start > max || end < start) return undefined;
    const at = bloomData.offset + BLOOMDATA_CHUNK_HEADER_SIZE;
    return this.bytes.subarray(at + start, at + end);
  }
}

/** A table-of-contents entry. */
interface TocEntry {
  id: number;
  offset: number;
  size: number;
}

/** git's read_table_of_contents (expected alignment 1); undefined after an error. */
function readTableOfContents(
  bytes: Uint8Array,
  view: DataView,
  tocOffset: number,
  count: number,
  report: (d: CommitGraphDiagnostic) => void,
  hashSize: number,
): TocEntry[] | undefined {
  const entries: TocEntry[] = [];
  let at = tocOffset;
  const limit = bytes.length - hashSize;
  for (let n = 0; n < count; n++) {
    const id = view.getUint32(at);
    const offset = Number(view.getBigUint64(at + 4));
    if (id === 0) {
      report({ level: "error", message: "terminating chunk id appears earlier than expected" });
      return undefined;
    }
    at += CHUNK_TOC_ENTRY_SIZE;
    const next = Number(view.getBigUint64(at + 4));
    if (next < offset || next > limit) {
      report({
        level: "error",
        message: `improper chunk offset(s) ${offset.toString(16)} and ${next.toString(16)}`,
      });
      return undefined;
    }
    if (entries.some((e) => e.id === id)) {
      report({ level: "error", message: `duplicate chunk ID ${id.toString(16)} found` });
      return undefined;
    }
    entries.push({ id, offset, size: next - offset });
  }
  const last = view.getUint32(at);
  if (last !== 0) {
    report({ level: "error", message: `final chunk has non-zero id ${last.toString(16)}` });
    return undefined;
  }
  return entries;
}

const hex8 = (n: number) => n.toString(16).toUpperCase();

/**
 * Parses one commit-graph file as git's `parse_commit_graph` (2.56): undefined when git would
 * refuse it, with the messages git prints in `diagnostics`.
 *
 * @example
 * ```typescript
 * const layer = parseCommitGraphLayer(bytes, "objects/info/commit-graph");
 * if (layer) console.log(layer.numCommits, layer.hash);
 * ```
 */
export function parseCommitGraphLayer(
  bytes: Uint8Array,
  path?: string,
  settings: CommitGraphReadSettings = {},
  diagnostics: CommitGraphDiagnostic[] = [],
): CommitGraphLayer | undefined {
  const report = (d: CommitGraphDiagnostic) => diagnostics.push(d);
  const objectFormat = settings.objectFormat ?? SHA1_OBJECT_FORMAT;
  const hashSize = objectFormat.rawLength;
  const dataWidth = graphDataWidth(hashSize);
  if (bytes.length < graphMinSize(hashSize)) {
    report({ level: "error", message: "commit-graph file is too small" });
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = view.getUint32(0);
  if (signature !== GRAPH_SIGNATURE) {
    report({
      level: "error",
      message: `commit-graph signature ${hex8(signature)} does not match signature ${hex8(GRAPH_SIGNATURE)}`,
    });
    return undefined;
  }
  const version = bytes[4] as number;
  if (version !== GRAPH_VERSION) {
    report({
      level: "error",
      message: `commit-graph version ${hex8(version)} does not match version ${hex8(GRAPH_VERSION)}`,
    });
    return undefined;
  }
  const hashVersion = bytes[5] as number;
  if (hashVersion !== objectFormat.version) {
    report({
      level: "error",
      message: `commit-graph hash version ${hex8(hashVersion)} does not match version ${hex8(objectFormat.version)}`,
    });
    return undefined;
  }
  const numChunks = bytes[6] as number;
  const headerBaseCount = bytes[7] as number;
  if (
    bytes.length <
    GRAPH_HEADER_SIZE + (numChunks + 1) * CHUNK_TOC_ENTRY_SIZE + GRAPH_FANOUT_SIZE + hashSize
  ) {
    report({
      level: "error",
      message: `commit-graph file is too small to hold ${numChunks} chunks`,
    });
    return undefined;
  }
  const toc = readTableOfContents(bytes, view, GRAPH_HEADER_SIZE, numChunks, report, hashSize);
  if (!toc) return undefined;
  const chunk = (id: number): ChunkRef | undefined => {
    const e = toc.find((c) => c.id === id);
    return e ? { offset: e.offset, size: e.size } : undefined;
  };

  const fanout = chunk(CHUNK_OID_FANOUT);
  let numCommits = 0;
  let fanoutOk = false;
  if (fanout) {
    if (fanout.size !== GRAPH_FANOUT_SIZE) {
      report({ level: "error", message: "commit-graph oid fanout chunk is wrong size" });
    } else {
      numCommits = view.getUint32(fanout.offset + 4 * 255);
      fanoutOk = true;
      for (let i = 0; i < 255; i++) {
        if (view.getUint32(fanout.offset + 4 * i) > view.getUint32(fanout.offset + 4 * (i + 1))) {
          report({ level: "error", message: "commit-graph fanout values out of order" });
          fanoutOk = false;
          break;
        }
      }
    }
  }
  if (!fanout || !fanoutOk) {
    report({
      level: "error",
      message: "commit-graph required OID fanout chunk missing or corrupted",
    });
    return undefined;
  }
  const oidLookup = chunk(CHUNK_OID_LOOKUP);
  if (oidLookup && Math.floor(oidLookup.size / hashSize) !== numCommits) {
    report({ level: "error", message: "commit-graph OID lookup chunk is the wrong size" });
  }
  if (!oidLookup || Math.floor(oidLookup.size / hashSize) !== numCommits) {
    report({
      level: "error",
      message: "commit-graph required OID lookup chunk missing or corrupted",
    });
    return undefined;
  }
  const commitData = chunk(CHUNK_COMMIT_DATA);
  if (commitData && Math.floor(commitData.size / dataWidth) !== numCommits) {
    report({ level: "error", message: "commit-graph commit data chunk is wrong size" });
  }
  if (!commitData || Math.floor(commitData.size / dataWidth) !== numCommits) {
    report({
      level: "error",
      message: "commit-graph required commit data chunk missing or corrupted",
    });
    return undefined;
  }

  const extraEdges = chunk(CHUNK_EXTRA_EDGES);
  const baseGraphs = chunk(CHUNK_BASE);

  let generationData: ChunkRef | undefined;
  let generationOverflow: ChunkRef | undefined;
  if ((settings.generationVersion ?? 2) >= 2) {
    const gda = chunk(CHUNK_GENERATION_DATA);
    if (gda) {
      if (Math.floor(gda.size / 4) !== numCommits) {
        report({ level: "error", message: "commit-graph generations chunk is wrong size" });
      } else {
        generationData = gda;
      }
    }
    generationOverflow = chunk(CHUNK_GENERATION_DATA_OVERFLOW);
  }

  let bloomIndexes: ChunkRef | undefined;
  let bloomData: ChunkRef | undefined;
  let bloomSettings: BloomFilterSettings | undefined;
  if ((settings.changedPathsVersion ?? -1) !== 0) {
    const bidx = chunk(CHUNK_BLOOM_INDEXES);
    if (bidx) {
      if (Math.floor(bidx.size / 4) !== numCommits) {
        report({ level: "warning", message: "commit-graph changed-path index chunk is too small" });
      } else {
        bloomIndexes = bidx;
      }
    }
    const bdat = chunk(CHUNK_BLOOM_DATA);
    if (bdat) {
      if (bdat.size < BLOOMDATA_CHUNK_HEADER_SIZE) {
        report({
          level: "warning",
          message: `ignoring too-small changed-path chunk (${bdat.size} < ${BLOOMDATA_CHUNK_HEADER_SIZE}) in commit-graph file`,
        });
      } else {
        bloomData = bdat;
        bloomSettings = {
          hashVersion: view.getUint32(bdat.offset),
          numHashes: view.getUint32(bdat.offset + 4),
          bitsPerEntry: view.getUint32(bdat.offset + 8),
          maxChangedPaths: DEFAULT_BLOOM_MAX_CHANGES,
        };
      }
    }
    // both chunks, or neither
    if (!bloomIndexes || !bloomData) {
      bloomIndexes = undefined;
      bloomData = undefined;
      bloomSettings = undefined;
    }
  }

  return new CommitGraphLayer(
    bytes,
    path,
    {
      numCommits,
      headerBaseCount,
      chunkIds: toc.map((e) => e.id),
      fanout,
      oidLookup,
      commitData,
      generationData,
      generationOverflow,
      extraEdges,
      baseGraphs,
      bloomIndexes,
      bloomData,
      bloomSettings,
    },
    objectFormat,
  );
}
