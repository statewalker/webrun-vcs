/**
 * git's merge-ort on flat trees (path -> blob, link or gitlink): the merge `merge`,
 * `cherry-pick`, `revert`, `rebase` and `stash apply` run, without writing anything but the
 * blobs of content merges.
 *
 * A port of merge-ort.c's structure: every path (file or directory) of the three trees gets
 * an entry with its three versions (`collect_merge_info`); renames are detected on each side
 * (exact, by basename, then by similarity, for the paths the merge needs), directory renames
 * derived from them move what the other side added into the new directory
 * (`merge.directoryRenames`); then each entry is resolved (`process_entry`), children before
 * their directory, so that a file meeting a directory moves aside only when the directory
 * stays. The result is merge-ort's tree, the conflicted index entries and the messages,
 * sorted by path as git prints them.
 *
 * With `callDepth` > 0 it is one of the inner merges of merge bases that build a virtual
 * merge base (`merge_ort_internal`): longer conflict markers, no messages, conflicts
 * resolved to the base's version where git does, no directory renames.
 */

import { type Blobs, FileMode, type ObjectId } from "@statewalker/vcs-core";
import { type ConflictStyle, mergeLines } from "@statewalker/vcs-utils";
import { encodeGitPath, foldAsciiCase } from "@statewalker/vcs-utils/encoding";

import {
  detectRenames,
  RELEVANT_CONTENT,
  RELEVANT_FOR_ANCESTOR,
  RELEVANT_FOR_SELF,
  RELEVANT_LOCATION,
  type RenameCandidate,
  SimilarityIndex,
} from "../rename/index.js";
import {
  lookupMergeDriver,
  type MergeAttributeValue,
  type MergeDriver,
  type MergeDriverRegistry,
} from "./merge-drivers.js";
import type { CheckedEntry } from "./worktree-overwrite-checks.js";

/** A path the merge could not resolve, as merge-ort leaves it in the index. */
export interface OrtConflict {
  base?: CheckedEntry;
  ours?: CheckedEntry;
  theirs?: CheckedEntry;
  /** Where the stages (and the worktree file) go: the path, or `<path>~<side>` */
  stagePath: string;
  /** The file with conflict markers, for a text conflict (unused: see `tree`) */
  content?: Uint8Array;
  /** What the worktree gets at `stagePath` where it differs from our side's version */
  write?: CheckedEntry;
  /** The path a file/directory or distinct-types conflict moves ours away from */
  moveFrom?: string;
  /** What merge-ort's result tree holds at `stagePath` (none: nothing there) */
  tree?: CheckedEntry;
  mode: number;
}

/** `merge.directoryRenames`: apply them, leave paths as they are, or apply with a conflict. */
export type DirectoryRenames = "true" | "false" | "conflict";

/** The attributes a content merge reads for a path (`merge`, `conflict-marker-size`). */
export interface MergeAttributes {
  merge?: MergeAttributeValue;
  conflictMarkerSize?: MergeAttributeValue;
}

/** Options of {@link ortMerge}. */
export interface OrtMergeOptions {
  /** Our side's name in markers and messages (git's branch1, e.g. `HEAD`) */
  oursLabel: string;
  /** Their side's name (git's branch2: the branch, or `<abbrev> (<subject>)`) */
  theirsLabel: string;
  /** The base's name after `|||||||` (diff3, zdiff3) */
  baseLabel?: string;
  /** Names a file moved aside gets (`<path>~<name>`); default the labels */
  oursName?: string;
  theirsName?: string;
  /** merge.conflictStyle */
  style?: ConflictStyle;
  /** `-X ours`, `-X theirs`: conflicting hunks (and binary files) resolved to a side */
  favor?: "ours" | "theirs" | "union";
  /** A case-folding worktree (core.ignorecase): names taken in another case are taken */
  ignoreCase?: boolean;
  /** Detect renames (default true) */
  renames?: boolean;
  /** merge.directoryRenames (default `conflict`, as git) */
  directoryRenames?: DirectoryRenames;
  /** merge.renameLimit (default 7000, as merge-ort) */
  renameLimit?: number;
  /** Files above this size are binary to the merge (core.bigFileThreshold) */
  bigFileThreshold?: number;
  /** The recursion level of a merge of merge bases (merge-ort's call_depth; default 0) */
  callDepth?: number;
  /** merge.renormalize / `-X renormalize`: content compared and merged as checked in afresh */
  renormalize?: boolean;
  /** The `merge` and `conflict-marker-size` attributes of a path (none: unspecified) */
  attributes?: (path: string) => Promise<MergeAttributes>;
  /** git's renormalize_buffer for a path (with `renormalize`) */
  renormalizeContent?: (path: string, content: Uint8Array) => Promise<Uint8Array>;
  /** Merge drivers by name (the `merge` attribute, `merge.default`) */
  drivers?: MergeDriverRegistry;
  /** merge.default: the driver of a path without a `merge` attribute */
  defaultDriver?: string;
  /** merge.<driver>.recursive: the driver used in merges of merge bases */
  recursiveDriver?: (name: string) => string | undefined;
  /**
   * The trees given as {@link prunedFlatTrees} reads them (directories all three hold alike
   * stand as one TREE entry): per tree (base, ours, theirs), the id of each directory, so a
   * directory taken whole from a side is the side's tree, never read.
   */
  dirTrees?: Map<string, ObjectId>[];
}

/** What {@link ortMerge} found. */
export interface OrtMergeResult {
  /** The cleanly merged entries */
  result: Map<string, CheckedEntry>;
  /** The conflicts, by the path they are staged at */
  conflicts: Map<string, OrtConflict>;
  /** Whether merge-ort calls the merge clean (no conflicts, no directory rename trouble) */
  clean: boolean;
  /** merge-ort's messages (`Auto-merging x`, `CONFLICT (...)`), in git's order */
  messages: string[];
  /** Whether directory renames were found (paths may move into any directory) */
  directoryRenames?: boolean;
}

const sameEntry = (a: CheckedEntry | undefined, b: CheckedEntry | undefined) =>
  a === undefined || b === undefined ? a === b : a.objectId === b.objectId && a.mode === b.mode;

const S_IFMT = 0o170000;
const typeOf = (e?: CheckedEntry) => (e ? e.mode & S_IFMT : 0);
const isReg = (e?: CheckedEntry) => typeOf(e) === 0o100000;
const isLink = (e?: CheckedEntry) => typeOf(e) === 0o120000;
const isGitlink = (e?: CheckedEntry) => typeOf(e) === 0o160000;
const TREE: CheckedEntry = { objectId: "", mode: FileMode.TREE };

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Reads a blob whole. */
export async function readBlob(blobs: Blobs, id: ObjectId): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of (await blobs.load(id)) ?? []) chunks.push(chunk);
  return concatBytes(chunks);
}

type Stages = [CheckedEntry | undefined, CheckedEntry | undefined, CheckedEntry | undefined];

/**
 * A path's entry (merge-ort's merged_info, with conflict_info's fields when `resolved` is
 * false).
 */
interface Info {
  /** The directory holding the path ("" for the top) */
  dir: string;
  /** Resolved while the trees were read (merged_info only) */
  resolved: boolean;
  /** merged.clean */
  clean: boolean;
  /** merged.is_null: nothing at the path in the result */
  isNull: boolean;
  /** merged.result */
  result?: CheckedEntry;
  stages: Stages;
  pathnames: [string, string, string];
  filemask: number;
  dirmask: number;
  matchMask: number;
  dfConflict: boolean;
  pathConflict: boolean;
  /** The path a file/directory or distinct-types conflict moved this entry away from */
  movedFrom?: string;
  /** Moved by a file/directory conflict (its conflict is listed under `movedFrom`) */
  dfMoved?: boolean;
}

/** A rename or add of one side (a diff_filepair after rename detection). */
interface Pair {
  status: "A" | "R";
  /** The source path (the path itself for an add) */
  one: string;
  /** The destination path (changed by a directory rename) */
  two: string;
  /** The side (1: ours, 2: theirs) */
  side: 1 | 2;
}

const dirnameOf = (path: string) => {
  const k = path.lastIndexOf("/");
  return k < 0 ? "" : path.slice(0, k);
};

/** git's strcmp order on paths. */
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const digestCache = new WeakMap<Map<string, CheckedEntry>, Map<string, string>>();

/**
 * A digest of each directory of a flat tree (what its tree id tells git): two directories
 * of two trees hold the same entries when their digests are equal. Kept per map (the flat
 * trees of a rebase are shared).
 */
function dirDigests(tree: Map<string, CheckedEntry>): Map<string, string> {
  const known = digestCache.get(tree);
  if (known) return known;
  const sums = new Map<string, [number, number, number]>();
  for (const [path, entry] of tree) {
    // two independent 32-bit hashes of the entry, summed per directory
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    const text = `${path}\0${entry.mode}\0${entry.objectId}`;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = (Math.imul(h2, 31) + c + (h2 >>> 13)) >>> 0;
    }
    for (let dir = dirnameOf(path); ; dir = dirnameOf(dir)) {
      const s = sums.get(dir) ?? [0, 0, 0];
      s[0] = (s[0] + h1) >>> 0;
      s[1] = (s[1] + h2) >>> 0;
      s[2]++;
      sums.set(dir, s);
      if (dir === "") break;
    }
  }
  const out = new Map<string, string>();
  for (const [dir, [a, b, n]] of sums) out.set(dir, `${a}:${b}:${n}`);
  digestCache.set(tree, out);
  return out;
}

/** git's strhash (FNV-1, 32 bits) over the bytes of a path. */
function strhash(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of encodeGitPath(text)) {
    hash = (Math.imul(hash, 0x01000193) ^ byte) >>> 0;
  }
  return hash;
}

/**
 * The order git's hashmap (a strmap) iterates keys added in this order: buckets by
 * `strhash & (size - 1)`, each a list with the newest first, the table growing fourfold
 * past 80% full (git's hashmap.c).
 */
function gitHashOrder(keys: Iterable<string>): string[] {
  let size = 64;
  let table: string[][] = Array.from({ length: size }, () => []);
  let count = 0;
  for (const key of keys) {
    table[strhash(key) & (size - 1)].unshift(key);
    count++;
    if (count > Math.floor((size * 80) / 100)) {
      const old = table;
      size <<= 2;
      table = Array.from({ length: size }, () => []);
      for (const chain of old) for (const k of chain) table[strhash(k) & (size - 1)].unshift(k);
    }
  }
  return table.flat();
}

/** merge-ort's sort_dirs_next_to_their_children: a directory right before its children. */
function sortDirsNextToChildren(one: string, two: string): number {
  const n = Math.min(one.length, two.length);
  let i = 0;
  while (i < n && one.charCodeAt(i) === two.charCodeAt(i)) i++;
  const c1 = i < one.length ? one.charCodeAt(i) : 47;
  const c2 = i < two.length ? two.charCodeAt(i) : 47;
  if (c1 === c2) return i < one.length ? 1 : -1;
  return c1 - c2;
}

/**
 * How often merges took merge-ort's paths that leave no trace in their result, for tests:
 * `redos` counts the merges redone with the renames the first pass found
 * (redo_after_renames). Not part of the package's API.
 */
export const ortMergeCounters = { redos: 0 };

/**
 * Merges `theirs` into `ours` against `base`, as git's merge-ort
 * (`merge_ort_nonrecursive_internal`). Content-merged blobs are stored in `blobs`.
 */
export async function ortMerge(
  blobs: Blobs,
  baseIn: Map<string, CheckedEntry>,
  oursIn: Map<string, CheckedEntry>,
  theirsIn: Map<string, CheckedEntry>,
  options: OrtMergeOptions,
): Promise<OrtMergeResult> {
  return new OrtMerge(blobs, options).run(baseIn, oursIn, theirsIn);
}

class OrtMerge {
  private readonly paths = new Map<string, Info>();
  /** Folded keys of `paths` (core.ignorecase), for unique names */
  private readonly folded = new Set<string>();
  private readonly conflicted = new Map<string, Info>();
  private readonly notes: { path: string; order: number; text: string }[] = [];
  private order = 0;
  private readonly depth: number;
  private readonly branch1: string;
  private readonly branch2: string;
  private readonly ancestor: string;
  private readonly dirRenamesMode: DirectoryRenames;

  // rename bookkeeping, per side (index 1, 2)
  private readonly deletes: string[][] = [[], [], []];
  private readonly adds: string[][] = [[], [], []];
  private readonly relevant: Map<string, number>[] = [new Map(), new Map(), new Map()];
  private readonly dirsRemoved: Map<string, number>[] = [new Map(), new Map(), new Map()];
  private readonly dirRenameCount: Map<string, Map<string, number>>[] = [
    new Map(),
    new Map(),
    new Map(),
  ];
  private readonly dirRenames: Map<string, string>[] = [new Map(), new Map(), new Map()];
  /** merge-ort's dir_rename_mask while the trees are walked */
  private dirRenameMask = 0;
  /** Whether rename and directory rename processing left the merge clean */
  private renamesClean = true;
  /** merge-ort's deferred[side].trivial_merges_okay */
  private readonly trivialOkay = [false, true, true];
  /** merge-ort's possible_trivial_merges, by side: directory -> dir_rename_mask */
  private possibleTrivial: Map<string, number>[] = [new Map(), new Map(), new Map()];
  /** Directories taken whole from a side (resolve_trivial_directory_merge) */
  private readonly trivialSide = new Map<string, 1 | 2>();
  /** merge-ort's deferred[side].target_dirs: deferred directories a known rename goes into */
  private readonly targetDirs: Set<string>[] = [new Set(), new Set(), new Set()];
  /** Each side's deletions and additions in the order the trees are read (its diff queue) */
  private readonly queue: { path: string; add: boolean }[][] = [[], [], []];
  /**
   * merge-ort's redo_after_renames: 1 when reading the deferred directories tripled the
   * paths read (the merge is then run again with the renames found), 2 while redoing
   */
  private redoAfterRenames = 0;
  /** Whether rename detection gave up on inexact renames (needed_rename_limit) */
  private renameLimitHit = false;
  // what a redo keeps from the first pass, by side: cached_pairs (source -> destination,
  // none for a deletion), cached_target_names, cached_irrelevant
  private readonly cachedPairs: Map<string, string | undefined>[] = [
    new Map(),
    new Map(),
    new Map(),
  ];
  private readonly cachedTargets: Set<string>[] = [new Set(), new Set(), new Set()];
  private readonly cachedIrrelevant: Set<string>[] = [new Set(), new Set(), new Set()];
  /** The three trees */
  private trees: Map<string, CheckedEntry>[] = [];

  constructor(
    private readonly blobs: Blobs,
    private readonly options: OrtMergeOptions,
  ) {
    this.depth = options.callDepth ?? 0;
    this.branch1 = options.oursLabel;
    this.branch2 = options.theirsLabel;
    this.ancestor = options.baseLabel ?? "";
    this.dirRenamesMode = options.directoryRenames ?? "conflict";
  }

  private say(path: string, text: string): void {
    // inner merges are silent (path_msg at call_depth > 0)
    if (this.depth > 0) return;
    this.notes.push({ path, order: this.order++, text });
  }

  /** A name as git's case-insensitive name hashing sees it (`memihash`: ASCII folded) */
  private fold(name: string): string {
    return this.options.ignoreCase ? foldAsciiCase(name) : name;
  }

  private put(path: string, info: Info): void {
    this.paths.set(path, info);
    if (this.options.ignoreCase) this.folded.add(this.fold(path));
  }

  private has(path: string): boolean {
    return (
      this.paths.has(path) || (this.options.ignoreCase === true && this.folded.has(this.fold(path)))
    );
  }

  /** merge-ort's unique_path: `<path>~<branch>` (`/` flattened), numbered while taken. */
  private uniquePath(path: string, branch: string): string {
    const base = `${path}~${branch.replaceAll("/", "_")}`;
    let candidate = base;
    for (let n = 0; this.has(candidate); n++) candidate = `${base}_${n}`;
    // the name is taken from now on (merge-ort puts the entry there)
    if (this.options.ignoreCase) this.folded.add(this.fold(candidate));
    return candidate;
  }

  private newInfo(dir: string, path: string): Info {
    return {
      dir,
      resolved: false,
      clean: false,
      isNull: false,
      stages: [undefined, undefined, undefined],
      pathnames: [path, path, path],
      filemask: 0,
      dirmask: 0,
      matchMask: 0,
      dfConflict: false,
      pathConflict: false,
    };
  }

  async run(
    base: Map<string, CheckedEntry>,
    ours: Map<string, CheckedEntry>,
    theirs: Map<string, CheckedEntry>,
  ): Promise<OrtMergeResult> {
    this.collect([base, ours, theirs]);
    if (this.options.renames !== false && (await this.detectAndProcessRenames())) {
      // redo_after_renames: the trees read again, knowing the renames the merge needs
      ortMergeCounters.redos++;
      this.reset();
      this.collect([base, ours, theirs]);
      await this.detectAndProcessRenames();
    }
    await this.processEntries();
    return this.output(ours);
  }

  /**
   * clear_or_reinit_internal_opts(reinitialize) for a redo: everything but the renames the
   * first pass found (and the directory rename counts, as git keeps them)
   */
  private reset(): void {
    this.paths.clear();
    this.folded.clear();
    this.conflicted.clear();
    this.notes.length = 0;
    for (let i = 0; i < 3; i++) {
      this.deletes[i] = [];
      this.adds[i] = [];
      this.queue[i] = [];
      this.relevant[i].clear();
      this.dirsRemoved[i].clear();
      this.dirRenames[i].clear();
      this.possibleTrivial[i] = new Map();
      this.targetDirs[i].clear();
      this.trivialOkay[i] = i !== 0;
    }
    this.trivialSide.clear();
    this.dirRenameMask = 0;
    this.renamesClean = true;
  }

  // ---- collect_merge_info -------------------------------------------------------------

  private collect(trees: Map<string, CheckedEntry>[]): void {
    interface Node {
      files: Stages;
      dirmask: number;
      children?: string[];
    }
    const nodes = new Map<string, Node>();
    const node = (path: string) => {
      let n = nodes.get(path);
      if (!n) {
        n = { files: [undefined, undefined, undefined], dirmask: 0 };
        nodes.set(path, n);
        if (path !== "") {
          const parent = dirnameOf(path);
          const p = node(parent);
          if (!p.children) p.children = [];
          p.children.push(path);
        }
      }
      return n;
    };
    node("");
    trees.forEach((tree, i) => {
      for (const [path, entry] of tree) {
        node(path).files[i] = entry;
        for (let dir = dirnameOf(path); dir !== ""; dir = dirnameOf(dir)) {
          const d = node(dir);
          if (d.dirmask & (1 << i)) break;
          d.dirmask |= 1 << i;
        }
      }
    });
    const filemaskOf = (n: Node) =>
      (n.files[0] ? 1 : 0) | (n.files[1] ? 2 : 0) | (n.files[2] ? 4 : 0);
    // the same directory in two trees (git compares the tree ids)
    const digests = trees.map((tree) => dirDigests(tree));
    const sameDir = (path: string, i: number, j: number) => {
      const x = digests[i].get(path);
      return x !== undefined && x === digests[j].get(path);
    };

    const traverse = (path: string) => {
      const n = nodes.get(path) as Node;
      // tree order: a directory sorts as `name/`
      const key = (c: string) => {
        const m = nodes.get(c) as Node;
        // a directory, or one all three trees hold alike (a TREE entry standing for it)
        return (m.dirmask && !filemaskOf(m)) || m.files[0]?.mode === FileMode.TREE ? `${c}/` : c;
      };
      const children = (n.children ?? []).sort((x, y) => compareStrings(key(x), key(y)));
      // a directory one side removed: its children read first, to see whether the side
      // that kept it added a file there (traverse_trees_wrapper)
      if (this.dirRenameMask === 2 || this.dirRenameMask === 4) {
        for (const child of children) {
          const fm = filemaskOf(nodes.get(child) as Node);
          if (fm && fm === this.dirRenameMask) this.dirRenameMask = 7;
        }
      }
      for (const child of children) visit(child, path);
    };

    const visit = (path: string, dir: string) => {
      const n = nodes.get(path) as Node;
      const filemask = filemaskOf(n);
      const dirmask = n.dirmask;
      const [b, s1, s2] = n.files;
      const side1MatchesBase = !!b && !!s1 && sameEntry(b, s1);
      const side2MatchesBase = !!b && !!s2 && sameEntry(b, s2);
      const sidesMatch = !!s1 && !!s2 && sameEntry(s1, s2);
      const dirs1 = !b && !s1 && sameDir(path, 0, 1);
      const dirs2 = !b && !s2 && sameDir(path, 0, 2);
      let matchMask = 0;
      if (side1MatchesBase) matchMask = side2MatchesBase ? 7 : 3;
      else if (side2MatchesBase) matchMask = 5;
      else if (sidesMatch) matchMask = 6;
      const prevMask = this.dirRenameMask;
      if (dirmask === 0) {
        const resolvedTo =
          side1MatchesBase && side2MatchesBase
            ? b
            : filemask === 7 && sidesMatch
              ? s1
              : filemask === 7 && side1MatchesBase
                ? s2
                : filemask === 7 && side2MatchesBase
                  ? s1
                  : undefined;
        if (resolvedTo) {
          const info = this.newInfo(dir, path);
          info.resolved = true;
          info.clean = true;
          info.result = resolvedTo;
          this.put(path, info);
          return;
        }
      }
      this.collectRenameInfo(path, dir, filemask, dirmask, matchMask, n.files);
      const info = this.newInfo(dir, path);
      info.stages = [...n.files] as Stages;
      info.filemask = filemask;
      info.dirmask = dirmask;
      info.dfConflict = filemask !== 0 && dirmask !== 0;
      if (dirmask) info.isNull = true;
      info.matchMask = dirmask ? matchMask & filemask : matchMask;
      this.put(path, info);
      if (dirmask) {
        // a directory one side left as it was: the other side's version may be taken whole,
        // decided once the trees are read (possible_trivial_merges)
        const s1m = side1MatchesBase || dirs1;
        const s2m = side2MatchesBase || dirs2;
        let side = s1m && !s2m ? 2 : s2m && !s1m ? 1 : 0;
        if (filemask === 0 && (dirmask === 2 || dirmask === 4)) side = dirmask / 2;
        if (
          this.dirRenameMask !== 7 &&
          side !== 0 &&
          this.trivialOkay[side] &&
          !this.targetDirs[side].has(path)
        ) {
          this.possibleTrivial[side].set(path, this.dirRenameMask);
          this.dirRenameMask = prevMask;
          return;
        }
        traverse(path);
        this.dirRenameMask = prevMask;
      }
    };
    traverse("");

    // the paths git would have read: a directory all three trees hold alike is one entry
    // (the trees given whole hold its files too)
    const identical = new Map<string, boolean>();
    const isIdentical = (dir: string) => {
      let known = identical.get(dir);
      if (known === undefined) {
        known = sameDir(dir, 0, 1) && sameDir(dir, 0, 2);
        identical.set(dir, known);
      }
      return known;
    };
    const countPaths = () => {
      let count = 0;
      for (const path of this.paths.keys()) {
        let inside = false;
        for (let dir = dirnameOf(path); dir !== "" && !inside; dir = dirnameOf(dir)) {
          inside = isIdentical(dir);
        }
        if (!inside) count++;
      }
      return count;
    };
    const countBefore = countPaths();
    let readDeferred = false;

    // handle_deferred_entries: a side whose rename sources the merge needs are all known
    // (none, or found by a first pass) takes its directories whole, but those a known
    // rename goes into; otherwise they are read now (their paths after all the others)
    for (const side of [1, 2] as const) {
      let okay = true;
      for (const source of this.relevant[side].keys()) {
        if (this.cachedIrrelevant[side].has(source)) continue;
        if (!this.cachedPairs[side].has(source)) {
          okay = false;
          break;
        }
        const target = this.cachedPairs[side].get(source);
        if (target === undefined || this.paths.has(target)) continue;
        let dir = target;
        for (let k = dir.lastIndexOf("/"); k >= 0; k = dir.lastIndexOf("/")) {
          dir = dir.slice(0, k);
          if (this.targetDirs[side].has(dir)) break;
          this.targetDirs[side].add(dir);
        }
      }
      if (!okay) readDeferred = true;
      this.trivialOkay[side] = okay;
      const deferred = this.possibleTrivial[side];
      this.possibleTrivial[side] = new Map();
      for (const path of gitHashOrder(deferred.keys())) {
        if (okay && !this.targetDirs[side].has(path)) {
          this.resolveTrivial(path, side);
          continue;
        }
        this.dirRenameMask = deferred.get(path) as number;
        traverse(path);
        this.dirRenameMask = 0;
      }
      for (const path of gitHashOrder(this.possibleTrivial[side].keys())) {
        this.resolveTrivial(path, side);
      }
    }
    if (readDeferred) {
      // reading the deferred directories tripled the paths: worth a second pass once the
      // renames are known (redo_after_renames)
      const countAfter = countPaths();
      if (this.redoAfterRenames === 0 && countBefore > 0) {
        if (Math.floor(countAfter / countBefore) >= 3) this.redoAfterRenames = 1;
      }
    } else if (this.redoAfterRenames === 2) {
      this.redoAfterRenames = 0;
    }
    this.trees = trees;
  }

  /** resolve_trivial_directory_merge: the directory is the side's, whole. */
  private resolveTrivial(path: string, side: 1 | 2): void {
    const info = this.paths.get(path) as Info;
    info.matchMask = 0;
    info.clean = true;
    this.trivialSide.set(path, side);
  }

  /** merge-ort's collect_rename_info: the rename sources and destinations, their relevance. */
  private collectRenameInfo(
    fullname: string,
    dirname: string,
    filemask: number,
    dirmask: number,
    matchMask: number,
    files: Stages,
  ): void {
    if (this.dirRenameMask !== 7 && (dirmask === 3 || dirmask === 5)) {
      this.dirRenameMask = dirmask & ~1;
    }
    if (dirmask === 1 || dirmask === 3 || dirmask === 5) {
      const sides = (7 - dirmask) / 2;
      const relevance = this.dirRenameMask === 7 ? RELEVANT_FOR_ANCESTOR : 0;
      if (sides & 1) this.dirsRemoved[1].set(fullname, relevance);
      if (sides & 2) this.dirsRemoved[2].set(fullname, relevance);
    }
    if (this.dirRenameMask === 7 && (filemask === 2 || filemask === 4)) {
      const side = 3 - (filemask >> 1);
      this.dirsRemoved[side].set(dirname, RELEVANT_FOR_SELF);
    }
    if (filemask === 0 || filemask === 7) return;
    for (const side of [1, 2] as const) {
      const sideMask = 1 << side;
      if (filemask & 1 && !(filemask & sideMask)) {
        const contentRelevant = (matchMask & filemask) === 0;
        const locationRelevant = this.dirRenameMask === 7;
        if (contentRelevant) this.cachedIrrelevant[side].delete(fullname);
        if (contentRelevant || locationRelevant) {
          this.relevant[side].set(fullname, contentRelevant ? RELEVANT_CONTENT : RELEVANT_LOCATION);
        }
        // a rename (or deletion) a first pass found is not detected again
        if (this.cachedPairs[side].has(fullname) || this.cachedIrrelevant[side].has(fullname)) {
          continue;
        }
        if (files[0]) {
          this.deletes[side].push(fullname);
          this.queue[side].push({ path: fullname, add: false });
        }
      }
      if (!(filemask & 1) && filemask & sideMask && !this.cachedTargets[side].has(fullname)) {
        this.adds[side].push(fullname);
        this.queue[side].push({ path: fullname, add: true });
      }
    }
  }

  // ---- renames --------------------------------------------------------------------------

  /** Rename detection of one side (detect_regular_renames): its renames and adds. */
  private async detectSide(side: 1 | 2): Promise<{ pairs: Pair[]; ran: boolean }> {
    const deletes = this.deletes[side];
    const adds = this.adds[side];
    const pairs: Pair[] = [];
    const addPairs = () => adds.map((p): Pair => ({ status: "A", one: p, two: p, side }));
    // prune_cached_from_relevant: what a first pass found is not looked for again
    for (const path of this.cachedPairs[side].keys()) this.relevant[side].delete(path);
    for (const path of this.cachedIrrelevant[side]) this.relevant[side].delete(path);
    if (deletes.length + adds.length === 0) return { pairs, ran: false };
    // no source the merge needs: no rename detection at all
    if (this.relevant[side].size === 0) return { pairs: addPairs(), ran: false };
    const candidate = (path: string, stage: number): RenameCandidate => {
      const e = this.paths.get(path)?.stages[stage] as CheckedEntry;
      return { path, mode: e.mode, id: e.objectId };
    };
    const renames = await detectRenames(
      deletes.map((p) => candidate(p, 0)),
      adds.map((p) => candidate(p, side)),
      {
        renameEmpty: false,
        renameLimit: this.options.renameLimit ?? 7000,
        load: (c) => readBlob(this.blobs, c.id),
        relevantSources: this.relevant[side],
        dirsRemoved: this.dirsRemoved[side],
        dirRenameCount: this.dirRenameCount[side],
        cachedPairs: this.cachedPairs[side],
        onRenameLimit: () => {
          this.renameLimitHit = true;
        },
        keepOrder: true,
      },
    );
    const renamedTo = new Map(renames.map((r) => [r.to, r.from]));
    for (const p of adds) {
      const from = renamedTo.get(p);
      pairs.push(
        from !== undefined
          ? { status: "R", one: from, two: p, side }
          : { status: "A", one: p, two: p, side },
      );
    }
    return { pairs, ran: true };
  }

  /**
   * possibly_cache_new_pair for each pair of a side's diff queue after rename detection:
   * the renames and deletions of the sources the merge needs, for a redo.
   */
  private cacheRenames(side: 1 | 2, pairs: Pair[]): void {
    const renamedTo = new Map<string, string>();
    for (const p of pairs) if (p.status === "R") renamedTo.set(p.two, p.one);
    const renamedFrom = new Set(renamedTo.values());
    const relevance = (path: string) => this.relevant[side].get(path) ?? -1;
    for (const { path, add } of this.queue[side]) {
      if (add) {
        const from = renamedTo.get(path);
        if (from === undefined || relevance(from) <= 0) continue;
        this.cachedPairs[side].set(from, path);
        this.cachedTargets[side].add(path);
      } else if (!renamedFrom.has(path)) {
        const value = relevance(path);
        if (value === 0) this.cachedIrrelevant[side].add(path);
        if (value > 0) this.cachedPairs[side].set(path, undefined);
      }
    }
  }

  /**
   * use_cached_pairs: the renames a first pass found, but those into a path the merge has
   * no (or a clean) entry for (git >= 2.55).
   */
  private cachedRenamePairs(side: 1 | 2): Pair[] {
    const pairs: Pair[] = [];
    for (const from of gitHashOrder(this.cachedPairs[side].keys())) {
      const to = this.cachedPairs[side].get(from);
      if (to === undefined) continue;
      const info = this.paths.get(to);
      if (!info || info.clean) continue;
      pairs.push({ status: "R", one: from, two: to, side });
    }
    return pairs;
  }

  /** detect_and_process_renames; true when the merge is to be redone (redo_after_renames). */
  private async detectAndProcessRenames(): Promise<boolean> {
    const detected = [await this.detectSide(1), await this.detectSide(2)];
    if (this.renameLimitHit) this.redoAfterRenames = 0;
    if (this.redoAfterRenames === 1 && detected.some((d) => d.ran)) {
      this.cacheRenames(1, detected[0].pairs);
      this.cacheRenames(2, detected[1].pairs);
      this.redoAfterRenames = 2;
      return true;
    }
    const sidePairs: Pair[][] = [
      [],
      [...detected[0].pairs, ...this.cachedRenamePairs(1)],
      [...detected[1].pairs, ...this.cachedRenamePairs(2)],
    ];
    if (this.depth === 0 && this.dirRenamesMode !== "false") {
      this.provisionalDirectoryRenames(1);
      this.provisionalDirectoryRenames(2);
      // a directory both sides renamed is no directory rename at all
      for (const dir of [...this.dirRenames[1].keys()]) {
        if (this.dirRenames[2].has(dir)) {
          this.dirRenames[1].delete(dir);
          this.dirRenames[2].delete(dir);
        }
      }
    }
    const collisions: Map<string, { sources: string[]; reported: boolean }>[] = [
      new Map(),
      this.computeCollisions(this.dirRenames[2], sidePairs[1]),
      this.computeCollisions(this.dirRenames[1], sidePairs[2]),
    ];
    const combined: Pair[] = [];
    for (const side of [1, 2] as const) {
      const other = (3 - side) as 1 | 2;
      for (const pair of sidePairs[side]) {
        if (this.dirRenamesMode === "false" && pair.status === "R") {
          combined.push(pair);
          continue;
        }
        const newPath = this.checkForDirectoryRename(
          pair,
          this.dirRenames[other],
          this.dirRenames[side],
          collisions,
        );
        if (pair.status !== "R" && newPath === undefined) continue;
        if (newPath !== undefined) this.applyDirectoryRenameModifications(pair, newPath);
        combined.push(pair);
      }
    }
    // stable, by source path
    combined.sort((a, b) => compareStrings(a.one, b.one));
    await this.processRenames(combined);
    return false;
  }

  /** merge-ort's get_provisional_directory_renames: each removed directory's majority. */
  private provisionalDirectoryRenames(side: 1 | 2): void {
    for (const [sourceDir, counts] of this.dirRenameCount[side]) {
      let max = 0;
      let badMax = 0;
      let best: string | undefined;
      for (const [targetDir, count] of counts) {
        if (count === max) badMax = max;
        else if (count > max) {
          max = count;
          best = targetDir;
        }
      }
      if (max === 0) continue;
      if (badMax === max) {
        this.say(
          sourceDir,
          `CONFLICT (directory rename split): Unclear where to rename ${sourceDir} to; it was renamed to multiple other directories, with no destination getting a majority of the files.`,
        );
        this.renamesClean = false;
      } else if (best !== undefined) {
        this.dirRenames[side].set(sourceDir, best);
      }
    }
  }

  /** The nearest renamed directory above `path` (check_dir_renamed). */
  private checkDirRenamed(
    path: string,
    dirRenames: Map<string, string>,
  ): [string, string] | undefined {
    // each directory above the path, never the top
    let rest = path;
    for (let k = rest.lastIndexOf("/"); k >= 0; k = rest.lastIndexOf("/")) {
      rest = rest.slice(0, k);
      const to = dirRenames.get(rest);
      if (to !== undefined) return [rest, to];
    }
    return undefined;
  }

  /** merge-ort's apply_dir_rename. */
  private applyDirRename([oldDir, newDir]: [string, string], oldPath: string): string {
    const oldLen = oldDir.length + (newDir === "" ? 1 : 0);
    return newDir + oldPath.slice(oldLen);
  }

  private computeCollisions(
    dirRenames: Map<string, string>,
    pairs: Pair[],
  ): Map<string, { sources: string[]; reported: boolean }> {
    const collisions = new Map<string, { sources: string[]; reported: boolean }>();
    if (dirRenames.size === 0) return collisions;
    for (const pair of pairs) {
      const rename = this.checkDirRenamed(pair.two, dirRenames);
      if (!rename) continue;
      const newPath = this.applyDirRename(rename, pair.two);
      let info = collisions.get(newPath);
      if (!info) {
        info = { sources: [], reported: false };
        collisions.set(newPath, info);
      }
      if (!info.sources.includes(pair.two)) {
        info.sources.push(pair.two);
        info.sources.sort(compareStrings);
      }
    }
    return collisions;
  }

  /** merge-ort's path_in_way. */
  private pathInWay(path: string, sideMask: number, pair: Pair): boolean {
    const info = this.paths.get(path);
    if (!info) return false;
    return (
      info.clean ||
      (sideMask & (info.filemask | info.dirmask)) !== 0 ||
      ((info.filemask & 1) !== 0 && pair.one !== path)
    );
  }

  /** merge-ort's check_for_directory_rename (with handle_path_level_conflicts). */
  private checkForDirectoryRename(
    pair: Pair,
    dirRenames: Map<string, string>,
    exclusions: Map<string, string>,
    collisions: Map<string, { sources: string[]; reported: boolean }>[],
  ): string | undefined {
    const path = pair.two;
    const side = pair.side;
    if (dirRenames.size === 0) return undefined;
    if (collisions[3 - side].has(path)) return undefined;
    const rename = this.checkDirRenamed(path, dirRenames);
    if (!rename) return undefined;
    const [oldDir, newDir] = rename;
    if (exclusions.has(newDir)) {
      this.say(
        oldDir,
        `WARNING: Avoiding applying ${oldDir} -> ${newDir} rename to ${path}, because ${newDir} itself was renamed.`,
      );
      return undefined;
    }
    const newPath = this.applyDirRename(rename, path);
    const info = collisions[side].get(newPath) as { sources: string[]; reported: boolean };
    if (info.reported) {
      this.renamesClean = false;
      return undefined;
    }
    if (this.pathInWay(newPath, 1 << side, pair)) {
      info.reported = true;
      this.renamesClean = false;
      this.say(
        newPath,
        `CONFLICT (implicit dir rename): Existing file/dir at ${newPath} in the way of implicit directory rename(s) putting the following path(s) there: ${info.sources.join(", ")}.`,
      );
      return undefined;
    }
    if (info.sources.length > 1) {
      info.reported = true;
      this.renamesClean = false;
      this.say(
        newPath,
        `CONFLICT (implicit dir rename): Cannot map more than one path to ${newPath}; implicit directory renames tried to put these paths there: ${info.sources.join(", ")}`,
      );
      return undefined;
    }
    return newPath;
  }

  /** merge-ort's apply_directory_rename_modifications: the path moves into the new directory. */
  private applyDirectoryRenameModifications(pair: Pair, newPath: string): void {
    const oldPath = pair.two;
    let ci = this.paths.get(oldPath) as Info;
    // the missing directories above the new path
    const dirsToInsert: string[] = [];
    let parent = "";
    for (let cur = newPath; ; ) {
      const k = cur.lastIndexOf("/");
      if (k < 0) {
        parent = "";
        break;
      }
      parent = cur.slice(0, k);
      if (this.paths.has(parent)) break;
      dirsToInsert.push(parent);
      cur = parent;
    }
    for (let i = dirsToInsert.length - 1; i >= 0; i--) {
      const dirCi = this.newInfo(parent, dirsToInsert[i]);
      dirCi.dirmask = ci.filemask;
      this.put(dirsToInsert[i], dirCi);
      parent = dirsToInsert[i];
    }
    if (ci.dirmask === 0) this.paths.delete(oldPath);
    else {
      const moved: Info = { ...ci, stages: [...ci.stages] as Stages, pathnames: [...ci.pathnames] };
      moved.dirmask = 0;
      moved.stages[1] = undefined;
      ci.filemask = 0;
      ci.clean = true;
      for (let i = 0; i < 3; i++) if (!(ci.dirmask & (1 << i))) ci.stages[i] = undefined;
      ci = moved;
    }
    const withNewPath = ci.filemask === 2 ? this.branch1 : this.branch2;
    const withDirRename = ci.filemask === 2 ? this.branch2 : this.branch1;
    ci.dir = parent;
    const existing = this.paths.get(newPath);
    if (!existing) this.put(newPath, ci);
    else {
      existing.filemask |= ci.filemask;
      if (existing.dirmask) existing.dfConflict = true;
      const index = ci.filemask >> 1;
      existing.pathnames[index] = ci.pathnames[index];
      existing.stages[index] = ci.stages[index];
      ci = existing;
    }
    if (this.dirRenamesMode === "true") {
      this.say(
        newPath,
        pair.status === "A"
          ? `Path updated: ${oldPath} added in ${withNewPath} inside a directory that was renamed in ${withDirRename}; moving it to ${newPath}.`
          : `Path updated: ${pair.one} renamed to ${oldPath} in ${withNewPath}, inside a directory that was renamed in ${withDirRename}; moving it to ${newPath}.`,
      );
    } else {
      ci.pathConflict = true;
      this.say(
        newPath,
        pair.status === "A"
          ? `CONFLICT (file location): ${oldPath} added in ${withNewPath} inside a directory that was renamed in ${withDirRename}, suggesting it should perhaps be moved to ${newPath}.`
          : `CONFLICT (file location): ${pair.one} renamed to ${oldPath} in ${withNewPath}, inside a directory that was renamed in ${withDirRename}, suggesting it should perhaps be moved to ${newPath}.`,
      );
    }
    pair.two = newPath;
  }

  /** merge-ort's process_renames. */
  private async processRenames(renames: Pair[]): Promise<void> {
    // process_renames answers the clean flag of its last rename/rename content merge
    let cleanMerge = true;
    for (let i = 0; i < renames.length; i++) {
      const pair = renames[i];
      const oldPath = pair.one;
      const newPath = pair.two;
      const oldinfo = this.paths.get(oldPath);
      const newinfo = this.paths.get(newPath);
      // a directory rename can move a renamed path back where it was (rename-to-self):
      // nothing to move (git >= 2.5x; older versions resolved the path away)
      if (oldPath === newPath) continue;
      if (!oldinfo || oldinfo.clean) continue;

      if (i + 1 < renames.length && renames[i + 1].one === oldPath) {
        // rename/rename(1to2) or rename/rename(1to1)
        const pathnames: [string, string, string] = [oldPath, newPath, renames[i + 1].two];
        const base = this.paths.get(pathnames[0]) as Info;
        const side1 = this.paths.get(pathnames[1]) as Info;
        const side2 = this.paths.get(pathnames[2]) as Info;
        if (pathnames[1] === pathnames[2]) {
          // both sides renamed the same way
          side1.stages[0] = base.stages[0];
          side1.filemask |= 1;
          base.isNull = true;
          base.clean = true;
          i++;
          continue;
        }
        const merged = await this.handleContentMerge(
          oldPath,
          base.stages[0],
          side1.stages[1] as CheckedEntry,
          side2.stages[2] as CheckedEntry,
          pathnames,
          1 + 2 * this.depth,
        );
        cleanMerge = merged.clean;
        const wasBinary =
          !merged.clean &&
          merged.entry.mode === side1.stages[1]?.mode &&
          merged.entry.objectId === side1.stages[1]?.objectId;
        side1.stages[1] = merged.entry;
        side2.stages[2] = wasBinary ? side2.stages[2] : merged.entry;
        side1.pathConflict = true;
        side2.pathConflict = true;
        base.pathConflict = true;
        this.say(
          pathnames[0],
          `CONFLICT (rename/rename): ${pathnames[0]} renamed to ${pathnames[1]} in ${this.branch1} and to ${pathnames[2]} in ${this.branch2}.`,
        );
        i++;
        continue;
      }

      const target = pair.side;
      const otherSource = 3 - target;
      const ni = newinfo as Info;
      const oldSideMask = 1 << otherSource;
      const sourceDeleted = oldinfo.filemask === 1;
      let collision = (ni.filemask & oldSideMask) !== 0;
      const typeChanged =
        !sourceDeleted && isReg(oldinfo.stages[otherSource]) !== isReg(ni.stages[target]);
      if (typeChanged && collision) collision = false;
      const [renameBranch, deleteBranch] =
        target === 1 ? [this.branch1, this.branch2] : [this.branch2, this.branch1];
      if (collision && !sourceDeleted) {
        // rename/add or rename/rename(2to1)
        const pathnames: [string, string, string] = [oldPath, oldPath, oldPath];
        pathnames[target] = newPath;
        const base = this.paths.get(pathnames[0]) as Info;
        const side1 = this.paths.get(pathnames[1]) as Info;
        const side2 = this.paths.get(pathnames[2]) as Info;
        const merged = await this.handleContentMerge(
          oldPath,
          base.stages[0],
          side1.stages[1] as CheckedEntry,
          side2.stages[2] as CheckedEntry,
          pathnames,
          1 + 2 * this.depth,
        );
        ni.stages[target] = merged.entry;
        if (!merged.clean) {
          this.say(
            newPath,
            `CONFLICT (rename involved in collision): rename of ${oldPath} -> ${newPath} has content conflicts AND collides with another path; this may result in nested conflict markers.`,
          );
        }
      } else if (collision && sourceDeleted) {
        ni.pathConflict = true;
        this.say(
          newPath,
          `CONFLICT (rename/delete): ${oldPath} renamed to ${newPath} in ${renameBranch}, but deleted in ${deleteBranch}.`,
        );
      } else {
        ni.stages[0] = oldinfo.stages[0];
        ni.filemask |= 1;
        ni.pathnames[0] = oldPath;
        if (typeChanged) {
          // rename vs. typechange: the original is resolved by removal
          oldinfo.stages[0] = undefined;
          oldinfo.filemask &= 6;
        } else if (sourceDeleted) {
          ni.pathConflict = true;
          this.say(
            newPath,
            `CONFLICT (rename/delete): ${oldPath} renamed to ${newPath} in ${renameBranch}, but deleted in ${deleteBranch}.`,
          );
        } else {
          ni.stages[otherSource] = oldinfo.stages[otherSource];
          ni.filemask |= 1 << otherSource;
          ni.pathnames[otherSource] = oldPath;
        }
      }
      if (!typeChanged) {
        oldinfo.isNull = true;
        oldinfo.clean = true;
      }
    }
    if (!cleanMerge) this.renamesClean = false;
  }

  // ---- content merges -------------------------------------------------------------------

  private async read(e?: CheckedEntry): Promise<Uint8Array> {
    return e && isReg(e) ? readBlob(this.blobs, e.objectId) : new Uint8Array(0);
  }

  /** The driver for a path's `merge` attribute (find_ll_merge_driver). */
  private driverFor(attr: MergeAttributeValue): {
    name: string;
    custom?: MergeDriver;
  } {
    let name: string;
    if (attr === true) return { name: "text" };
    if (attr === false) return { name: "binary" };
    if (attr === undefined) {
      if (!this.options.defaultDriver) return { name: "text" };
      name = this.options.defaultDriver;
    } else name = attr;
    const custom = lookupMergeDriver(this.options.drivers, name);
    if (custom) return { name, custom };
    if (name === "binary" || name === "text" || name === "union") return { name };
    return { name: "text" };
  }

  /**
   * merge-ort's merge_3way (ll_merge): the merge driver of the path's `merge` attribute
   * (text, binary, union or a registered one) with its markers.
   */
  private async merge3way(
    path: string,
    o: CheckedEntry | undefined,
    a: CheckedEntry,
    b: CheckedEntry,
    pathnames: [string, string, string],
    extraMarkerSize: number,
  ): Promise<{ status: "ok" | "conflict" | "binary"; content: Uint8Array }> {
    const same = pathnames[0] === pathnames[1] && pathnames[1] === pathnames[2];
    const baseLabel = same ? this.ancestor : `${this.ancestor}:${pathnames[0]}`;
    const oursLabel = same ? this.branch1 : `${this.branch1}:${pathnames[1]}`;
    const theirsLabel = same ? this.branch2 : `${this.branch2}:${pathnames[2]}`;
    let [orig, src1, src2] = [await this.read(o), await this.read(a), await this.read(b)];
    if (this.options.renormalize && this.options.renormalizeContent) {
      const norm = this.options.renormalizeContent;
      [orig, src1, src2] = [await norm(path, orig), await norm(path, src1), await norm(path, src2)];
    }
    const attrs = (await this.options.attributes?.(path)) ?? {};
    let markerSize = 7;
    const size = attrs.conflictMarkerSize;
    if (typeof size === "string") {
      const parsed = /^[+-]?\d+$/.test(size.trim()) ? Number.parseInt(size, 10) : Number.NaN;
      markerSize = Number.isNaN(parsed) || parsed <= 0 ? 7 : parsed;
    }
    let driver = this.driverFor(attrs.merge);
    if (this.depth > 0) {
      const recursive = driver.custom?.recursive ?? this.options.recursiveDriver?.(driver.name);
      if (recursive) driver = this.driverFor(recursive);
    }
    markerSize += extraMarkerSize;
    const favor = this.depth > 0 ? undefined : this.options.favor;
    const binaryMerge = () => {
      // ll_binary_merge: the base for an inner merge, else ours (or the favored side)
      if (this.depth > 0) return { status: "ok" as const, content: orig };
      if (favor === "ours") return { status: "ok" as const, content: src1 };
      if (favor === "theirs") return { status: "ok" as const, content: src2 };
      return { status: "binary" as const, content: src1 };
    };
    if (driver.custom) {
      const out = await driver.custom.merge({
        path,
        base: orig,
        ours: src1,
        theirs: src2,
        baseLabel,
        oursLabel,
        theirsLabel,
        markerSize,
      });
      return { status: out.conflict ? "conflict" : "ok", content: out.content };
    }
    if (driver.name === "binary") return binaryMerge();
    const threshold = this.options.bigFileThreshold ?? 512 * 1024 * 1024;
    if (
      [orig, src1, src2].some(
        (bytes) => bytes.length > threshold || SimilarityIndex.isBinary(bytes),
      )
    ) {
      return binaryMerge();
    }
    const lines = mergeLines(orig, src1, src2, {
      oursLabel,
      theirsLabel,
      baseLabel,
      style: this.options.style,
      favor: driver.name === "union" ? "union" : favor,
      markerSize,
    });
    return { status: lines.conflicts > 0 ? "conflict" : "ok", content: lines.content };
  }

  /** merge-ort's handle_content_merge: two versions of a type merged, with their mode. */
  private async handleContentMerge(
    path: string,
    o: CheckedEntry | undefined,
    a: CheckedEntry,
    b: CheckedEntry,
    pathnames: [string, string, string],
    extraMarkerSize: number,
  ): Promise<{ entry: CheckedEntry; clean: boolean }> {
    let clean = true;
    let mode: number;
    if (a.mode === b.mode || a.mode === o?.mode) mode = b.mode;
    else {
      mode = a.mode;
      clean = b.mode === o?.mode;
    }
    if (a.objectId === b.objectId || a.objectId === o?.objectId) {
      return { entry: { objectId: b.objectId, mode }, clean };
    }
    if (b.objectId === o?.objectId) return { entry: { objectId: a.objectId, mode }, clean };
    if (isReg(a)) {
      const twoWay = typeOf(o) !== typeOf(a);
      const merged = await this.merge3way(
        path,
        twoWay ? undefined : o,
        a,
        b,
        pathnames,
        extraMarkerSize,
      );
      const objectId = await this.blobs.store([merged.content]);
      if (merged.status === "binary") {
        const [, n1, n2] =
          pathnames[0] === pathnames[1] && pathnames[1] === pathnames[2]
            ? [this.ancestor, this.branch1, this.branch2]
            : [
                `${this.ancestor}:${pathnames[0]}`,
                `${this.branch1}:${pathnames[1]}`,
                `${this.branch2}:${pathnames[2]}`,
              ];
        this.say(path, `warning: Cannot merge binary files: ${path} (${n1} vs. ${n2})`);
      }
      this.say(path, `Auto-merging ${path}`);
      return { entry: { objectId, mode }, clean: clean && merged.status === "ok" };
    }
    if (isGitlink(a)) {
      // merge_submodule cannot look into the submodule: ours stands (the base's inside
      // a merge of merge bases), a conflict
      const twoWay = typeOf(o) !== typeOf(a);
      if (this.depth > 0) {
        if (twoWay) return { entry: o ?? { objectId: "", mode: 0 }, clean: false };
        return { entry: { objectId: (o as CheckedEntry).objectId, mode }, clean: false };
      }
      return { entry: { objectId: a.objectId, mode }, clean: false };
    }
    if (isLink(a)) {
      if (this.depth > 0) {
        return { entry: o ? { ...o } : { objectId: "", mode: 0 }, clean: false };
      }
      if (this.options.favor === "ours") return { entry: { objectId: a.objectId, mode }, clean };
      if (this.options.favor === "theirs") {
        return { entry: { objectId: b.objectId, mode }, clean };
      }
      return { entry: { objectId: a.objectId, mode }, clean: false };
    }
    return { entry: { objectId: a.objectId, mode }, clean: false };
  }

  /** merge-ort's blob_unchanged (with renormalize): the side's change only a renormalization. */
  private async blobUnchanged(
    base: CheckedEntry | undefined,
    side: CheckedEntry | undefined,
    path: string,
  ): Promise<boolean> {
    if (!base || !side || base.mode !== side.mode) return false;
    if (base.objectId === side.objectId) return true;
    const norm = this.options.renormalizeContent;
    if (!norm) return false;
    const [x, y] = [
      await norm(path, await readBlob(this.blobs, base.objectId)),
      await norm(path, await readBlob(this.blobs, side.objectId)),
    ];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  // ---- process_entries ------------------------------------------------------------------

  private readonly nonEmptyDirs = new Set<string>();
  private readonly recorded = new Map<string, CheckedEntry>();

  /** record_entry_for_tree: the entry is in the result tree (its directories not empty). */
  private record(path: string, info: Info): void {
    if (info.isNull || !info.result) return;
    // a directory's own entry is no content (TREE), unless it stands for a stored tree
    if (info.result !== TREE) this.recorded.set(path, info.result);
    for (let dir = dirnameOf(path); ; dir = dirnameOf(dir)) {
      if (this.nonEmptyDirs.has(dir)) break;
      this.nonEmptyDirs.add(dir);
      if (dir === "") break;
    }
  }

  private async processEntries(): Promise<void> {
    const plist = [...this.paths.keys()].sort(sortDirsNextToChildren);
    for (let k = plist.length - 1; k >= 0; k--) {
      const path = plist[k];
      const info = this.paths.get(path);
      if (!info) continue;
      const trivial = this.trivialSide.get(path);
      if (trivial !== undefined && info.clean) {
        // a directory taken whole from one side (its file, or everything under it)
        const kept = info.stages[trivial];
        if (kept) {
          info.result = kept;
          info.isNull = false;
          this.record(path, info);
        } else if (this.options.dirTrees?.[trivial]?.has(path)) {
          // the side's tree as it is
          const id = this.options.dirTrees[trivial].get(path) as ObjectId;
          this.record(path, {
            ...info,
            result: { objectId: id, mode: FileMode.TREE },
            isNull: false,
          });
        } else {
          const prefix = `${path}/`;
          for (const [p, e] of this.trees[trivial]) {
            if (p.startsWith(prefix)) this.record(p, { ...info, result: e, isNull: false });
          }
        }
        continue;
      }
      if (info.dirmask && !info.resolved) {
        // write_completed_directory: the directory holds something, or nothing
        if (this.nonEmptyDirs.has(path)) {
          info.isNull = false;
          info.result = TREE;
        } else {
          info.isNull = true;
          info.result = undefined;
        }
      }
      if (info.clean) this.record(path, info);
      else await this.processEntry(path, info);
    }
  }

  private async processEntry(pathIn: string, ciIn: Info): Promise<void> {
    let path = pathIn;
    let ci = ciIn;
    let dfFileIndex = 0;
    if (ci.dirmask) {
      this.record(path, ci);
      if (ci.filemask === 0) return;
    }
    if (ci.dfConflict && !ci.result) {
      // the directory went away: the file takes the path
      ci.dfConflict = false;
      ci.clean = false;
      ci.isNull = false;
      ci.matchMask &= ~ci.dirmask;
      ci.dirmask = 0;
      for (let i = 0; i < 3; i++) if (!(ci.filemask & (1 << i))) ci.stages[i] = undefined;
    } else if (ci.dfConflict && ci.result) {
      // the directory stays: the file moves aside
      if (ci.filemask === 1) {
        ci.filemask = 0;
        return;
      }
      const moved: Info = {
        ...ci,
        stages: [...ci.stages] as Stages,
        pathnames: [...ci.pathnames],
        result: undefined,
        isNull: false,
      };
      moved.matchMask &= ~moved.dirmask;
      moved.dirmask = 0;
      for (let i = 0; i < 3; i++) if (!(moved.filemask & (1 << i))) moved.stages[i] = undefined;
      dfFileIndex = ci.dirmask & 2 ? 2 : 1;
      const branch = dfFileIndex === 1 ? this.branch1 : this.branch2;
      const oldPath = path;
      path = this.uniquePath(path, this.nameOf(dfFileIndex));
      moved.movedFrom = oldPath;
      moved.dfMoved = true;
      this.put(path, moved);
      this.say(
        path,
        `CONFLICT (file/directory): directory in the way of ${oldPath} from ${branch}; moving it to ${path} instead.`,
      );
      ci.filemask = 0;
      ci = moved;
    }

    if (ci.matchMask) {
      ci.clean = !ci.dfConflict && !ci.pathConflict;
      if (ci.matchMask === 6) {
        ci.result = ci.stages[1];
      } else {
        const othermask = 7 & ~ci.matchMask;
        const side = othermask === 4 ? 2 : 1;
        ci.result = ci.stages[side];
        ci.isNull = !ci.result;
        if (ci.isNull) ci.clean = true;
      }
    } else if (ci.filemask >= 6 && typeOf(ci.stages[1]) !== typeOf(ci.stages[2])) {
      // two different kinds of things (file, link, submodule)
      if (this.depth > 0) {
        ci.clean = false;
        ci.result = ci.stages[0];
        ci.isNull = !ci.result;
      } else {
        const [o, a, b] = ci.stages;
        let renameA = false;
        let renameB = false;
        if (isReg(a)) renameA = true;
        else if (isReg(b)) renameB = true;
        else {
          renameA = true;
          renameB = true;
        }
        const aPath = renameA ? this.uniquePath(path, this.nameOf(1)) : undefined;
        let bPath = renameB ? this.uniquePath(path, this.nameOf(2)) : undefined;
        this.say(
          path,
          renameA && renameB
            ? `CONFLICT (distinct types): ${path} had different types on each side; renamed both of them so each can be recorded somewhere.`
            : `CONFLICT (distinct types): ${path} had different types on each side; renamed one of them so each can be recorded somewhere.`,
        );
        ci.clean = false;
        const newCi: Info = {
          ...ci,
          stages: [...ci.stages] as Stages,
          pathnames: [...ci.pathnames],
        };
        newCi.result = b;
        newCi.stages[1] = undefined;
        newCi.filemask = 5;
        if (typeOf(b) !== typeOf(o)) {
          newCi.stages[0] = undefined;
          newCi.filemask = 4;
        }
        ci.result = a;
        ci.stages[2] = undefined;
        ci.filemask = 3;
        if (typeOf(a) !== typeOf(o)) {
          ci.stages[0] = undefined;
          ci.filemask = 2;
        }
        if (aPath) {
          ci.movedFrom = path;
          this.put(aPath, ci);
        }
        if (!bPath) bPath = path;
        else newCi.movedFrom = path;
        this.put(bPath, newCi);
        if (renameA && renameB) this.paths.delete(path);
        this.conflicted.set(bPath, newCi);
        this.record(bPath, newCi);
        if (aPath) path = aPath;
      }
    } else if (ci.filemask >= 6) {
      // a two-way or three-way content merge
      const merged = await this.handleContentMerge(
        path,
        ci.stages[0],
        ci.stages[1] as CheckedEntry,
        ci.stages[2] as CheckedEntry,
        ci.pathnames,
        this.depth * 2,
      );
      ci.clean = merged.clean && !ci.dfConflict && !ci.pathConflict;
      ci.result = merged.entry.mode ? merged.entry : undefined;
      ci.isNull = !merged.entry.mode;
      if (merged.clean && ci.dfConflict) {
        ci.filemask = 1 << dfFileIndex;
        ci.stages[dfFileIndex] = merged.entry;
      }
      if (!merged.clean) {
        let reason = "content";
        if (ci.filemask === 6) reason = "add/add";
        if (isGitlink(merged.entry)) reason = "submodule";
        this.say(path, `CONFLICT (${reason}): Merge conflict in ${path}`);
      }
    } else if (ci.filemask === 3 || ci.filemask === 5) {
      // modify/delete
      const side = ci.filemask === 5 ? 2 : 1;
      const index = this.depth > 0 ? 0 : side;
      ci.result = ci.stages[index];
      ci.isNull = !ci.result;
      ci.clean = false;
      const modifyBranch = side === 1 ? this.branch1 : this.branch2;
      const deleteBranch = side === 1 ? this.branch2 : this.branch1;
      if (
        this.options.renormalize &&
        (await this.blobUnchanged(ci.stages[0], ci.stages[side], path))
      ) {
        if (!ci.pathConflict) {
          // unchanged after renormalization: no modify/delete after all
          ci.isNull = true;
          ci.result = undefined;
          ci.clean = true;
          ci.dfConflict = false;
        }
      } else if (ci.pathConflict && ci.stages[0]?.objectId === ci.stages[side]?.objectId) {
        // a rename/delete of an unchanged file: reported already
      } else {
        this.say(
          path,
          `CONFLICT (modify/delete): ${path} deleted in ${deleteBranch} and modified in ${modifyBranch}.  Version ${modifyBranch} of ${path} left in tree.`,
        );
      }
    } else if (ci.filemask === 2 || ci.filemask === 4) {
      // added on one side
      const side = ci.filemask === 4 ? 2 : 1;
      ci.result = ci.stages[side];
      ci.isNull = false;
      ci.clean = !ci.dfConflict && !ci.pathConflict;
    } else if (ci.filemask === 1) {
      // deleted on both sides
      ci.isNull = true;
      ci.result = undefined;
      ci.clean = !ci.pathConflict;
    }
    if (!ci.clean) this.conflicted.set(path, ci);
    this.record(path, ci);
  }

  /** The name a side's file moved aside takes (`<path>~<name>`). */
  private nameOf(side: number): string {
    return side === 1
      ? (this.options.oursName ?? this.branch1)
      : (this.options.theirsName ?? this.branch2);
  }

  // ---- result ---------------------------------------------------------------------------

  private output(ours: Map<string, CheckedEntry>): OrtMergeResult {
    const result = new Map<string, CheckedEntry>();
    for (const [path, entry] of this.recorded) {
      if (!this.conflicted.has(path)) result.set(path, entry);
    }
    const conflicts = new Map<string, OrtConflict>();
    for (const [path, ci] of [...this.conflicted].sort((x, y) => compareStrings(x[0], y[0]))) {
      const tree = ci.isNull ? undefined : this.recorded.get(path);
      const stage = (i: number) => (ci.filemask & (1 << i) ? ci.stages[i] : undefined);
      const conflict: OrtConflict = {
        stagePath: path,
        mode: tree?.mode ?? stage(1)?.mode ?? stage(2)?.mode ?? stage(0)?.mode ?? 0,
      };
      const [b, o, t] = [stage(0), stage(1), stage(2)];
      if (b) conflict.base = b;
      if (o) conflict.ours = o;
      if (t) conflict.theirs = t;
      if (tree) {
        conflict.tree = tree;
        if (!sameEntry(tree, ours.get(path))) conflict.write = tree;
      }
      if (ci.movedFrom && o && ours.has(ci.movedFrom)) conflict.moveFrom = ci.movedFrom;
      conflicts.set(ci.dfMoved && ci.movedFrom ? ci.movedFrom : path, conflict);
    }
    const messages = this.notes
      .sort((x, y) => compareStrings(x.path, y.path) || x.order - y.order)
      .map((n) => n.text);
    return {
      result,
      conflicts,
      messages,
      clean: this.renamesClean && this.conflicted.size === 0,
      directoryRenames: this.dirRenames[1].size > 0 || this.dirRenames[2].size > 0,
    };
  }
}

/**
 * merge-ort's result tree as a flat map: the merged entries, and at each conflict's path
 * what git's result tree holds there (the file with markers, the surviving side, ours).
 */
export async function ortResultEntries(
  blobs: Blobs,
  merge: OrtMergeResult,
): Promise<Map<string, CheckedEntry>> {
  const out = new Map(merge.result);
  for (const conflict of merge.conflicts.values()) {
    if (conflict.content) {
      out.set(conflict.stagePath, {
        objectId: await blobs.store([conflict.content]),
        mode: conflict.mode,
      });
    } else if (conflict.tree) {
      out.set(conflict.stagePath, conflict.tree);
    }
  }
  return out;
}
