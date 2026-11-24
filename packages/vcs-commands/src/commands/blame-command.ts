import type { Commit, ObjectId, PersonIdent } from "@statewalker/vcs-core";
import { DEFAULT_BIG_FILE_THRESHOLD } from "@statewalker/vcs-core";
import {
  ByteLines,
  type InternedText,
  LineInterner,
  parseGitBool,
  type SupportedAlgorithm,
  whitespaceFlags,
  type XdiffAlgorithm,
  type XdiffOptions,
  xdiffHunks,
  xdlHashRecord,
} from "@statewalker/vcs-utils";

import { RefNotFoundError } from "../errors/ref-errors.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import {
  DEFAULT_RENAME_LIMIT,
  DEFAULT_RENAME_SCORE,
  detectRenames,
  GIT_MAX_SCORE,
} from "../rename/index.js";
import { abbrevLengths } from "./core-config.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { type Mailmap, readRepositoryMailmap } from "./mailmap.js";
import { canonicalObjectId } from "./object-id-input.js";

/** Line bytes the interner holds before blame starts a new one (see `setInternerByteLimit`) */
const DEFAULT_INTERNER_BYTE_LIMIT = 64 * 1024 * 1024;
/** Bytes of the files looked in for copies kept interned between commits */
const COPY_SOURCE_CACHE_BYTES = 16 * 1024 * 1024;
/** Bytes of line hashes of the files looked in for copies kept between commits */
const COPY_HASH_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * A single blame entry - represents authorship of one or more consecutive lines.
 */
export interface BlameEntry {
  /** The commit that introduced these lines */
  commit: Commit;
  /** The commit ID */
  commitId: ObjectId;
  /** Original path in the source commit (may differ due to renames) */
  sourcePath: string;
  /** Starting line number in the original file (1-based) */
  sourceStart: number;
  /** Starting line number in the result file (1-based) */
  resultStart: number;
  /** Number of lines in this region */
  lineCount: number;
  /**
   * The parent version the commit's lines were compared with (`previous` of
   * `git blame --porcelain`), when the commit had the file in a parent
   */
  previous?: { commitId: ObjectId; path: string };
  /** A boundary commit (a root commit, unless `setShowRoot(true)`): `^` in git's output */
  boundary?: boolean;
}

/**
 * Detailed tracking information for a single line.
 *
 * Based on JGit's per-line tracking arrays in BlameResult.
 * This provides complete origin information for each line in the result file.
 */
export interface LineTracking {
  /** Line number in the result file (1-based) */
  resultLine: number;
  /** The commit that introduced this line */
  commit: Commit;
  /** The commit ID */
  commitId: ObjectId;
  /** Path in the source commit where this line originated (may differ due to renames) */
  sourcePath: string;
  /** Line number in the source file (1-based) */
  sourceLine: number;
}

/**
 * Result of a blame operation.
 *
 * Contains per-line authorship information for a file.
 */
export interface BlameResult {
  /** Path of the blamed file */
  path: string;
  /** Total number of lines in the file */
  lineCount: number;
  /**
   * Blame entries in line order (git's, after coalescing); they cover all lines, or the
   * line ranges asked for
   */
  entries: BlameEntry[];
  /** The blamed file's content at the start commit */
  content?: Uint8Array;
  /**
   * Get the blame entry for a specific line (1-based).
   *
   * @param line Line number (1-based)
   * @returns Blame entry for that line, or undefined if out of range
   */
  getEntry(line: number): BlameEntry | undefined;
  /**
   * Get the commit that introduced a specific line.
   *
   * @param line Line number (1-based)
   * @returns Commit or undefined if out of range
   */
  getSourceCommit(line: number): Commit | undefined;
  /**
   * Get the author of a specific line.
   *
   * @param line Line number (1-based)
   * @returns PersonIdent or undefined if out of range
   */
  getSourceAuthor(line: number): PersonIdent | undefined;
  /**
   * Get the source line number in the original file.
   *
   * @param line Line number in the result file (1-based)
   * @returns Source line number (1-based), or undefined if out of range
   */
  getSourceLine(line: number): number | undefined;
  /**
   * Get the source path for a specific line.
   *
   * @param line Line number in the result file (1-based)
   * @returns Source path, or undefined if out of range
   */
  getSourcePath(line: number): string | undefined;
  /**
   * Get detailed tracking information for all lines.
   *
   * @returns Array of LineTracking objects ordered by result line number
   */
  getLineTracking(): LineTracking[];
  /**
   * The length git's default output abbreviates the commits to before room for boundary
   * marks (`update_auto_abbrev`): the longest of their unique abbreviations, from
   * `core.abbrev` (auto: from the repository's approximate object count). Pass it to
   * `formatBlame` as `autoAbbrev`.
   */
  autoAbbrev?(): Promise<number>;
}

/** A version of the file in a commit (`struct blame_origin`) */
interface Origin {
  /** Creation order: stands for the pointer order git sorts suspects by (`compare_blame_suspect`) */
  seq: number;
  commitId: ObjectId;
  path: string;
  blobId: ObjectId;
  mode: number;
  /** Lines still suspected on this origin, sorted by `sLno` */
  suspects: Entry | null;
  previous?: Origin;
  guilty: boolean;
  /** The next origin of the same commit */
  next: Origin | null;
  /** The previous origin of the same commit (the list is doubly linked to move one in O(1)) */
  prev: Origin | null;
  /** The blob's lines (split and hashed once), while the origin is compared */
  lines?: InternedText;
}

/** A run of lines (`struct blame_entry`), 0-based */
interface Entry {
  next: Entry | null;
  suspect: Origin;
  /** First line in the final file */
  lno: number;
  /** First line in the suspect's file */
  sLno: number;
  numLines: number;
}

/** Something with a `next` link: a list head or an entry (`struct blame_entry **`) */
interface Slot {
  next: Entry | null;
}

interface CommitState {
  commit: Commit;
  origins: Origin | null;
  /** The origins by path (git's list is searched linearly; `-C -C -C` makes it long) */
  originsByPath: Map<string, Origin>;
  uninteresting: boolean;
}

const S_IFMT = 0o170000;
const TREE_MODE = 0o040000;
const GITLINK_MODE = 0o160000;
/** blame.h's `BLAME_DEFAULT_MOVE_SCORE` and `BLAME_DEFAULT_COPY_SCORE` */
const BLAME_DEFAULT_MOVE_SCORE = 20;
const BLAME_DEFAULT_COPY_SCORE = 40;
const INT_MAX = Number.MAX_SAFE_INTEGER;

/** Whether any line hash is among `wanted` */
function sharesLine(hashes: Int32Array, wanted: Set<number>): boolean {
  for (let i = 0; i < hashes.length; i++) if (wanted.has(hashes[i])) return true;
  return false;
}

/** An origin moved to the front of its commit's list (`get_origin` finding it) */
function moveOriginToFront(st: CommitState, o: Origin): void {
  if (!o.prev) return;
  o.prev.next = o.next;
  if (o.next) o.next.prev = o.prev;
  o.prev = null;
  o.next = st.origins;
  if (st.origins) st.origins.prev = o;
  st.origins = o;
}

/** An origin no entry refers to taken off its commit's list (`blame_origin_decref` freeing it) */
function unlinkOrigin(st: CommitState, o: Origin): void {
  if (o.prev) o.prev.next = o.next;
  else if (st.origins === o) st.origins = o.next;
  if (o.next) o.next.prev = o.prev;
  o.prev = null;
  o.next = null;
  if (st.originsByPath.get(o.path) === o) st.originsByPath.delete(o.path);
}

/** `reverse_blame`: `head` reversed, ending in `tail` */
function reverseBlame(head: Entry | null, tail: Entry | null): Entry | null {
  let h = head;
  let t = tail;
  while (h) {
    const next = h.next;
    h.next = t;
    t = h;
    h = next;
  }
  return t;
}

/** `blame_merge`: two lists sorted by `sLno` merged */
function blameMerge(list1: Entry | null, list2: Entry | null): Entry | null {
  if (!list1) return list2;
  if (!list2) return list1;
  const head: Slot = { next: null };
  let tail: Slot = head;
  let p1: Entry | null = list1;
  let p2: Entry | null = list2;
  while (p1 && p2) {
    if (p1.sLno <= p2.sLno) {
      tail.next = p1;
      tail = p1;
      p1 = p1.next;
    } else {
      tail.next = p2;
      tail = p2;
      p2 = p2.next;
    }
  }
  tail.next = p1 ?? p2;
  return head.next;
}

/** `split_blame_at`: `e` keeps `len` lines, the rest is returned */
function splitBlameAt(e: Entry, len: number, suspect: Origin): Entry {
  const n: Entry = {
    next: null,
    suspect,
    lno: e.lno + len,
    sLno: e.sLno + len,
    numLines: e.numLines - len,
  };
  e.numLines = len;
  return n;
}

/** One part of a split entry (the on-stack `struct blame_entry` of `split_overlap`) */
interface Part {
  suspect: Origin | null;
  lno: number;
  sLno: number;
  numLines: number;
}

/** `struct blame_entry split[3]`: before the chunk, the chunk the parent takes, after it */
type Split = [Part, Part, Part];

const emptyPart = (): Part => ({ suspect: null, lno: 0, sLno: 0, numLines: 0 });
const emptySplit = (): Split => [emptyPart(), emptyPart(), emptyPart()];

/** A queue appended at its tail (`struct blame_entry ***`); the tail's `next` is set at the end */
interface Queue {
  tail: Slot;
}

/** git's `split_overlap`: `e` cut where `[tlno, same)` (its suspect's lines) came from `parent` */
function splitOverlap(e: Entry, tlno: number, plno: number, same: number, parent: Origin): Split {
  const split = emptySplit();
  let chunkEnd: number;
  if (e.sLno < tlno) {
    // a part before the chunk, not blamed on the parent
    split[0] = { suspect: e.suspect, lno: e.lno, sLno: e.sLno, numLines: tlno - e.sLno };
    split[1].lno = e.lno + tlno - e.sLno;
    split[1].sLno = plno;
  } else {
    split[1].lno = e.lno;
    split[1].sLno = plno + (e.sLno - tlno);
  }
  if (same < e.sLno + e.numLines) {
    // a part after the chunk, not blamed on the parent
    split[2] = {
      suspect: e.suspect,
      lno: e.lno + (same - e.sLno),
      sLno: same,
      numLines: e.sLno + e.numLines - same,
    };
    chunkEnd = split[2].lno;
  } else chunkEnd = e.lno + e.numLines;
  split[1].numLines = chunkEnd - split[1].lno;
  if (split[1].numLines >= 1) split[1].suspect = parent;
  return split;
}

/** git's `add_blame_entry`: a new entry from `src` appended */
function addBlameEntry(queue: Queue, src: Part): void {
  const e: Entry = {
    next: null,
    suspect: src.suspect as Origin,
    lno: src.lno,
    sLno: src.sLno,
    numLines: src.numLines,
  };
  queue.tail.next = e;
  queue.tail = e;
}

/** git's `dup_entry`: `dst` takes `src`'s place and is appended */
function dupEntry(queue: Queue, dst: Entry, src: Part): void {
  dst.suspect = src.suspect as Origin;
  dst.lno = src.lno;
  dst.sLno = src.sLno;
  dst.numLines = src.numLines;
  queue.tail.next = dst;
  queue.tail = dst;
}

/** git's `split_blame`: the parts of `e` queued to the parent's (`blamed`) and its own lists */
function splitBlame(blamed: Queue, unblamed: Queue, split: Split, e: Entry): void {
  if (split[0].suspect && split[2].suspect) {
    dupEntry(unblamed, e, split[0]);
    addBlameEntry(unblamed, split[2]);
    addBlameEntry(blamed, split[1]);
  } else if (!split[0].suspect && !split[2].suspect) {
    dupEntry(blamed, e, split[1]);
  } else if (split[0].suspect) {
    dupEntry(unblamed, e, split[0]);
    addBlameEntry(blamed, split[1]);
  } else {
    dupEntry(blamed, e, split[1]);
    addBlameEntry(unblamed, split[2]);
  }
}

/** A priority queue of commits: newest committer date first, ties first in, first out */
class CommitQueue {
  private heap: Array<{ id: ObjectId; date: number; ctr: number }> = [];
  private ctr = 0;

  private less(i: number, j: number): boolean {
    const a = this.heap[i];
    const b = this.heap[j];
    if (a.date !== b.date) return a.date > b.date;
    return a.ctr < b.ctr;
  }

  put(id: ObjectId, date: number): void {
    const h = this.heap;
    h.push({ id, date, ctr: this.ctr++ });
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }

  get(): ObjectId | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0 && last) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(l, m)) m = l;
        if (r < h.length && this.less(r, m)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top.id;
  }
}

/**
 * Annotate each line of a file with the commit that last changed it.
 *
 * Equivalent to `git blame`, and a port of git's algorithm (`blame.c`): the commits are
 * visited newest first (committer date); each passes the lines it did not change to the
 * parents that have the file (found by path, else, following renames, by git's rename
 * detection), comparing with each parent's version through the same xdiff diff git uses
 * (`diff.algorithm`, default myers, and `diff.indentHeuristic`, default on); the lines left
 * are its own. A parent with the same blob takes all lines. Root commits are boundaries
 * unless `setShowRoot(true)` (`blame.showRoot`).
 *
 * Lines moved within the file (`-M`, `setDetectMoves`) and copied from other files (`-C` up
 * to three times, `setDetectCopies`) are found as git's `find_move_in_parent` and
 * `find_copy_in_parent` find them, and names and emails go through the mailmap
 * (`setUseMailmap`). `--reverse` and `--ignore-rev` are not supported.
 *
 * @example
 * ```typescript
 * const result = await git.blame().setFilePath("src/main.ts").call();
 * const author = result.getSourceAuthor(42);
 *
 * // `git blame --porcelain -w -L 10,20 README.md`
 * const blame = await git.blame().setFilePath("README.md").setIgnoreWhitespace(true)
 *   .setLineRanges([[10, 20]]).call();
 * process.stdout.write(formatBlamePorcelain(blame));
 * ```
 */
export class BlameCommand extends GitCommand<BlameResult> {
  private filePath?: string;
  private startCommit?: ObjectId;
  private followRenames = true;
  private renameScore = DEFAULT_RENAME_SCORE;
  private algorithm?: XdiffAlgorithm;
  private bigFileThreshold = DEFAULT_BIG_FILE_THRESHOLD;
  private ignoreWhitespace = false;
  private internerByteLimit = DEFAULT_INTERNER_BYTE_LIMIT;
  private indentHeuristic?: boolean;
  private showRoot?: boolean;
  private lineRanges: Array<[number, number]> = [];
  private diffOptions: Pick<XdiffOptions, "histogramRediff" | "legacyMinimal"> = {};
  private renameCountLastSpan?: boolean;
  /** `-M`: look for lines moved within the file (`PICKAXE_BLAME_MOVE`) */
  private detectMoves = false;
  /** `-C` given this many times (`PICKAXE_BLAME_COPY`, `_HARDER`, `_HARDEST`) */
  private copyLevel = 0;
  private moveScore = BLAME_DEFAULT_MOVE_SCORE;
  private copyScore = BLAME_DEFAULT_COPY_SCORE;
  private useMailmap = true;

  /** The blamed file at the start commit, its line starts and alphanumerics before each line */
  private finalContent: Uint8Array = new Uint8Array(0);
  private finalStarts: Int32Array = new Int32Array(1);
  private finalAlnum: Int32Array = new Int32Array(1);
  private originSeq = 0;
  /** Files looked in for copies, interned, the most recently used last (`copySourceText`) */
  private copySources = new Map<ObjectId, InternedText>();
  private copySourceBytes = 0;
  /** Line hashes of the files looked in for copies (null: over the big file threshold) */
  private copyHashes = new Map<ObjectId, Int32Array | null>();
  private copyHashBytes = 0;
  private copyHashCacheBytes = COPY_HASH_CACHE_BYTES;
  private copySourceCacheBytes = COPY_SOURCE_CACHE_BYTES;
  /** The hash of each line of the final file (`lineHashesOf`) */
  private finalHashes: Int32Array = new Int32Array(0);

  private states = new Map<ObjectId, CommitState>();
  /** Numbers the lines of every version compared, so each is split and hashed once */
  private interner?: LineInterner;

  /**
   * Set the file path to blame.
   *
   * @param path Repository-relative path to the file
   */
  setFilePath(path: string): this {
    this.checkCallable();
    this.filePath = path;
    return this;
  }

  /**
   * Set the starting commit for blame.
   *
   * If not set, defaults to HEAD.
   *
   * @param commit ObjectId of the starting commit
   */
  setStartCommit(commit: ObjectId): this {
    commit = canonicalObjectId(commit);
    this.checkCallable();
    this.startCommit = commit;
    return this;
  }

  /**
   * Set whether to follow whole-file renames (default true, as git; false is
   * `--no-follow`).
   *
   * @param follow Whether to follow renames
   */
  setFollowRenames(follow: boolean): this {
    this.checkCallable();
    this.followRenames = follow;
    return this;
  }

  /**
   * Set the minimum similarity score for rename detection.
   *
   * @param score Similarity threshold (0-100, default 50)
   */
  setRenameScore(score: number): this {
    this.checkCallable();
    this.renameScore = Math.max(0, Math.min(100, score));
    return this;
  }

  /**
   * Set the diff algorithm (`--diff-algorithm`; default `diff.algorithm`, else myers).
   *
   * @param algorithm The algorithm to use
   */
  setAlgorithm(algorithm: SupportedAlgorithm | XdiffAlgorithm): this {
    this.checkCallable();
    this.algorithm = String(algorithm) as XdiffAlgorithm;
    return this;
  }

  /** Ignore whitespace when comparing versions (`-w`) */
  setIgnoreWhitespace(ignore: boolean): this {
    this.checkCallable();
    this.ignoreWhitespace = ignore;
    return this;
  }

  /** The indent heuristic (default `diff.indentHeuristic`, true) */
  setIndentHeuristic(on: boolean): this {
    this.checkCallable();
    this.indentHeuristic = on;
    return this;
  }

  /** Do not treat root commits as boundaries (`--root`; default `blame.showRoot`) */
  setShowRoot(show: boolean): this {
    this.checkCallable();
    this.showRoot = show;
    return this;
  }

  /**
   * Blame only these line ranges (`-L <start>,<end>`, 1-based, inclusive), merged as git
   * merges overlapping ranges.
   */
  setLineRanges(ranges: Array<[number, number]>): this {
    this.checkCallable();
    this.lineRanges = ranges.map(([s, e]) => [s, e]);
    return this;
  }

  /**
   * Find lines moved or copied within the file (`-M[<num>]`): lines a commit moved are blamed
   * on the commit that wrote them. A block is taken when it has more than `score`
   * alphanumeric characters (default 20; 0 keeps the default, as git's).
   */
  setDetectMoves(detect: boolean, score?: number): this {
    this.checkCallable();
    this.detectMoves = detect;
    if (score) this.moveScore = score;
    return this;
  }

  /**
   * Find lines copied from other files (`-C[<num>]` given `level` times; any level also
   * finds moves): 1 looks in the files the commit changed, 2 also in every file of the parent
   * when the blamed file was created or renamed, 3 in every file of the parent always. A block
   * is taken when it has more than `score` alphanumeric characters (default 40; 0 keeps the
   * default).
   */
  setDetectCopies(level: number, score?: number): this {
    this.checkCallable();
    this.copyLevel = Math.max(0, Math.min(3, Math.floor(level)));
    if (this.copyLevel > 0) this.detectMoves = true;
    if (score) this.copyScore = score;
    return this;
  }

  /**
   * Map the names and emails of authors and committers through the mailmap (`.mailmap`,
   * `mailmap.blob`, `mailmap.file`), as git blame always does (default true). The entries'
   * commits then carry the mapped identities.
   */
  setUseMailmap(use: boolean): this {
    this.checkCallable();
    this.useMailmap = use;
    return this;
  }

  /**
   * Diff details that changed between git versions: `histogramRediff` (git 2.54+, default
   * true), `legacyMinimal` (git before 2.5x), and `renameCountLastSpan` (rename scores of
   * git 2.50+, default true)
   */
  setCompatibility(
    options: Pick<XdiffOptions, "histogramRediff" | "legacyMinimal"> & {
      renameCountLastSpan?: boolean;
    },
  ): this {
    this.checkCallable();
    const { renameCountLastSpan, ...diff } = options;
    this.diffOptions = { ...this.diffOptions, ...diff };
    if (renameCountLastSpan !== undefined) this.renameCountLastSpan = renameCountLastSpan;
    return this;
  }

  /**
   * Set the size above which a file is never loaded (git's
   * `core.bigFileThreshold`, default 50 MiB).
   *
   * Blaming a file over it rejects. A parent version over it is not compared:
   * the lines it would have taken stay with the child commit, and it is not a
   * rename candidate.
   *
   * @param threshold Size in bytes
   */
  setBigFileThreshold(threshold: number): this {
    this.checkCallable();
    this.bigFileThreshold = threshold;
    return this;
  }

  /**
   * Set how many bytes of distinct lines the line interner may hold (default 64 MiB). The
   * interner keeps every distinct line it has seen; past this size blame starts a new one for
   * the versions it reads next, and re-interns a version from the old one when it is compared
   * with one from the new. The output does not change.
   *
   * @param bytes Size in bytes
   */
  setInternerByteLimit(bytes: number): this {
    this.checkCallable();
    this.internerByteLimit = bytes;
    return this;
  }

  /**
   * Set how many bytes the caches of `-C` keep between commits (default 32 MiB of line hashes
   * of the files looked in, 16 MiB of their contents): a file not kept is read again for the
   * next commit, as git reads it. The output does not change.
   *
   * @param bytes Size in bytes
   */
  setCopyCacheByteLimit(bytes: number): this {
    this.checkCallable();
    this.copyHashCacheBytes = bytes;
    this.copySourceCacheBytes = bytes;
    return this;
  }

  /**
   * Execute the blame command.
   *
   * @returns BlameResult with per-line authorship
   */
  async call(): Promise<BlameResult> {
    this.checkCallable();
    this.setCallable(false);

    if (!this.filePath) {
      throw new Error("File path must be set");
    }
    const config = RemoteConfigStore.from(this.workingCopy);
    this.algorithm ??= algorithmValue(config.value("diff.algorithm")) ?? "myers";
    this.indentHeuristic ??= boolValue(config.value("diff.indentHeuristic")) ?? true;
    this.showRoot ??= boolValue(config.value("blame.showRoot")) ?? false;

    let startId = this.startCommit;
    if (!startId) {
      const head = await this.refsStore.resolve("HEAD");
      if (!head?.objectId) {
        throw new Error("No HEAD commit found");
      }
      startId = head.objectId;
    }

    const resultPath = this.filePath;
    const start = await this.state(startId);
    if (!start) {
      throw new RefNotFoundError(`Cannot find commit: ${startId}`);
    }
    const entry = await this.lookup(start.commit.tree, resultPath);
    if (!entry) {
      throw new Error(`File not found: ${resultPath}`);
    }
    const size = await this.blobs.size(entry.id);
    if (size > this.bigFileThreshold) {
      throw new Error(
        `${resultPath} is ${size} bytes, larger than bigFileThreshold (${this.bigFileThreshold})`,
      );
    }
    const finalOrigin = this.getOrigin(startId, resultPath);
    finalOrigin.blobId = entry.id;
    finalOrigin.mode = entry.mode;
    const content = await this.readBlob(entry.id);
    finalOrigin.lines = this.lineInterner().text(content);
    const lineCount = countLines(content);
    if (this.detectMoves || this.copyLevel > 0) this.prepareLines(content, lineCount);

    // the initial entries: the whole file, or the -L ranges (sorted and merged)
    const ranges = this.ranges(lineCount);
    let head: Entry | null = null;
    for (let i = ranges.length - 1; i >= 0; i--) {
      const [s, e] = ranges[i];
      head = { next: head, suspect: finalOrigin, lno: s, sLno: s, numLines: e - s };
    }
    const final: Slot = { next: null };
    if (head) {
      finalOrigin.suspects = head;
      const queue = new CommitQueue();
      queue.put(startId, start.commit.committer.timestamp);
      await this.assignBlame(queue, final);
    }

    // blame_sort_final, blame_coalesce
    const ents: Entry[] = [];
    for (let e = final.next; e; e = e.next) ents.push(e);
    ents.sort((a, b) => a.lno - b.lno);
    const coalesced: Entry[] = [];
    for (const e of ents) {
      const last = coalesced[coalesced.length - 1];
      if (
        last &&
        last.suspect === e.suspect &&
        last.sLno + last.numLines === e.sLno &&
        last.lno + last.numLines === e.lno
      ) {
        last.numLines += e.numLines;
      } else coalesced.push({ ...e });
    }

    const mailmap = this.useMailmap ? await this.loadMailmap() : undefined;
    const mapped = new Map<ObjectId, Commit>();
    const commitOf = (st: CommitState, id: ObjectId): Commit => {
      if (!mailmap || mailmap.empty) return st.commit;
      let c = mapped.get(id);
      if (!c) {
        const author = mapIdent(mailmap, st.commit.author);
        const committer = mapIdent(mailmap, st.commit.committer);
        c =
          author === st.commit.author && committer === st.commit.committer
            ? st.commit
            : { ...st.commit, author, committer };
        mapped.set(id, c);
      }
      return c;
    };
    const entries: BlameEntry[] = [];
    for (const e of coalesced) {
      const st = this.states.get(e.suspect.commitId);
      if (!st) continue;
      const prev = e.suspect.previous;
      entries.push({
        commit: commitOf(st, e.suspect.commitId),
        commitId: e.suspect.commitId,
        sourcePath: e.suspect.path,
        sourceStart: e.sLno + 1,
        resultStart: e.lno + 1,
        lineCount: e.numLines,
        ...(prev ? { previous: { commitId: prev.commitId, path: prev.path } } : {}),
        boundary: st.uninteresting,
      });
    }
    const result = createBlameResult(resultPath, lineCount, entries, content);
    const workingCopy = this.workingCopy;
    result.autoAbbrev = async () => {
      const lengths = await abbrevLengths(
        workingCopy,
        entries.map((e) => e.commitId),
      );
      return lengths.size > 0 ? Math.max(...lengths.values()) : 7;
    };
    return result;
  }

  /** The -L ranges as 0-based half-open ranges, sorted and merged; the whole file otherwise */
  private ranges(lineCount: number): Array<[number, number]> {
    if (this.lineRanges.length === 0) return lineCount > 0 ? [[0, lineCount]] : [];
    const out: Array<[number, number]> = [];
    for (const [s, e] of this.lineRanges) {
      let bottom = s;
      let top = e;
      if (top < bottom) [bottom, top] = [top, bottom];
      if (bottom < 1) bottom = 1;
      if (lineCount < bottom) {
        throw new Error(`file ${this.filePath} has only ${lineCount} lines`);
      }
      if (top > lineCount) top = lineCount;
      out.push([bottom - 1, top]);
    }
    out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const r of out) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    return merged;
  }

  /** git's `assign_blame` */
  private async assignBlame(queue: CommitQueue, final: Slot): Promise<void> {
    let commitId = queue.get();
    while (commitId) {
      const st = this.states.get(commitId);
      let suspect = st?.origins ?? null;
      while (suspect && !suspect.suspects) suspect = suspect.next;
      if (!st || !suspect) {
        commitId = queue.get();
        continue;
      }
      if (!st.uninteresting) await this.passBlame(suspect, queue);
      // treat root commit as boundary
      if (st.commit.parents.length === 0 && !this.showRoot) st.uninteresting = true;
      // take responsibility for the remaining entries
      let ent = suspect.suspects;
      if (ent) {
        suspect.guilty = true;
        while (ent.next) ent = ent.next;
        ent.next = final.next;
        final.next = suspect.suspects;
        suspect.suspects = null;
      }
    }
  }

  /** git's `pass_blame` */
  private async passBlame(origin: Origin, queue: CommitQueue): Promise<void> {
    const st = this.states.get(origin.commitId);
    if (!st) return;
    const parents = st.commit.parents;
    const n = parents.length;
    const sgOrigin: Array<Origin | undefined> = new Array(n).fill(undefined);
    const blames: Slot = { next: null };
    const blamed: Queue = { tail: blames };
    const toosmall: Slot = { next: null };
    await this.passBlameSteps(origin, parents, sgOrigin, blamed, toosmall, queue);
    blamed.tail.next = null;
    this.distributeBlame(blames.next, queue);
    // the entries too small to look for are the origin's again (unsorted, as git leaves them)
    if (toosmall.next) {
      let tail = toosmall.next;
      while (tail.next) tail = tail.next;
      tail.next = origin.suspects;
      origin.suspects = toosmall.next;
    }
    for (const porigin of sgOrigin) if (porigin && !porigin.suspects) porigin.lines = undefined;
    origin.lines = undefined;
  }

  /**
   * The steps of `pass_blame` before its `finish`: the parents' versions found and compared,
   * then moves and copies looked for; returning is git's `goto finish`
   */
  private async passBlameSteps(
    origin: Origin,
    parents: ObjectId[],
    sgOrigin: Array<Origin | undefined>,
    blamed: Queue,
    toosmall: Slot,
    queue: CommitQueue,
  ): Promise<void> {
    const n = parents.length;
    if (n === 0) return;
    for (let pass = 0; pass < (this.followRenames ? 2 : 1); pass++) {
      for (let i = 0; i < n; i++) {
        if (sgOrigin[i]) continue;
        const parent = await this.state(parents[i]);
        if (!parent) continue;
        const porigin = pass
          ? await this.findRename(parents[i], origin)
          : await this.findOrigin(parents[i], origin);
        if (!porigin) continue;
        if (porigin.blobId === origin.blobId) {
          this.passWholeBlame(origin, porigin, queue);
          return;
        }
        let same = false;
        for (let j = 0; j < i; j++) {
          if (sgOrigin[j] && sgOrigin[j]?.blobId === porigin.blobId) {
            same = true;
            break;
          }
        }
        if (!same) sgOrigin[i] = porigin;
      }
    }
    for (let i = 0; i < n; i++) {
      const porigin = sgOrigin[i];
      if (!porigin) continue;
      if (!origin.previous) origin.previous = porigin;
      await this.passBlameToParent(origin, porigin, queue);
      if (!origin.suspects) return;
    }
    // optionally find moves in the parents' files
    if (this.detectMoves) {
      this.filterSuspects(toosmall, origin, this.moveScore);
      if (origin.suspects) {
        for (let i = 0; i < n; i++) {
          const porigin = sgOrigin[i];
          if (!porigin) continue;
          await this.findMoveInParent(blamed, toosmall, origin, porigin);
          if (!origin.suspects) break;
        }
      }
    }
    // optionally find copies from the parents' files
    if (this.copyLevel > 0) {
      if (this.copyScore > this.moveScore) {
        this.filterSuspects(toosmall, origin, this.copyScore);
      } else if (this.copyScore < this.moveScore) {
        origin.suspects = blameMerge(origin.suspects, toosmall.next);
        toosmall.next = null;
        this.filterSuspects(toosmall, origin, this.copyScore);
      }
      if (!origin.suspects) return;
      for (let i = 0; i < n; i++) {
        await this.findCopyInParent(blamed, toosmall, origin, parents[i], sgOrigin[i]);
        if (!origin.suspects) return;
      }
    }
  }

  /** `filter_small` of the origin's suspects into `toosmall` */
  private filterSuspects(toosmall: Slot, origin: Origin, scoreMin: number): void {
    const src: Slot = { next: origin.suspects };
    this.filterSmall(toosmall, src, scoreMin);
    origin.suspects = src.next;
  }

  /**
   * git's `filter_small`: the entries of `source` scoring at most `scoreMin` moved to the
   * front of the list after `small`; returns the link before the old head of that list
   */
  private filterSmall(small: Slot, source: Slot, scoreMin: number): Slot {
    let p = source.next;
    const oldsmall = small.next;
    let sm = small;
    let src = source;
    while (p) {
      if (this.entryScore(p.lno, p.numLines) <= scoreMin) {
        sm.next = p;
        sm = p;
      } else {
        src.next = p;
        src = p;
      }
      p = p.next;
    }
    sm.next = oldsmall;
    src.next = null;
    return sm;
  }

  /** git's `blame_entry_score`: one more than the alphanumerics of the lines in the final file */
  private entryScore(lno: number, numLines: number): number {
    return 1 + this.finalAlnum[lno + numLines] - this.finalAlnum[lno];
  }

  /** git's `prepare_lines`, and the alphanumerics before each line for `entryScore` */
  private prepareLines(content: Uint8Array, lineCount: number): void {
    const starts = new Int32Array(lineCount + 1);
    const alnum = new Int32Array(lineCount + 1);
    let line = 0;
    let count = 0;
    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
        count++;
      } else if (c === 0x0a && ++line < lineCount) {
        starts[line] = i + 1;
        alnum[line] = count;
      }
    }
    starts[lineCount] = content.length;
    alnum[lineCount] = count;
    this.finalContent = content;
    this.finalStarts = starts;
    this.finalAlnum = alnum;
    if (this.copyLevel > 0) this.finalHashes = this.lineHashesOf(content);
  }

  /** git's `copy_split_if_better`: `potential` kept in `best` when it scores no lower */
  private copySplitIfBetter(best: Split, potential: Split): void {
    if (!potential[1].suspect) return;
    if (
      best[1].suspect &&
      this.entryScore(potential[1].lno, potential[1].numLines) <
        this.entryScore(best[1].lno, best[1].numLines)
    ) {
      return;
    }
    best[0] = potential[0];
    best[1] = potential[1];
    best[2] = potential[2];
  }

  /**
   * git's `find_copy_in_blob`: the best run of `ent`'s lines (in the final file) that the
   * parent's file has, as a split of `ent`
   */
  private findCopyInBlob(ent: Entry, parent: Origin, file: { text: InternedText }): Split {
    const split = emptySplit();
    const interner = this.lineInterner();
    if (file.text.interner !== interner) file.text = interner.text(file.text.content);
    const slice = this.finalContent.subarray(
      this.finalStarts[ent.lno],
      this.finalStarts[ent.lno + ent.numLines],
    );
    const hunks = xdiffHunks(file.text, slice, this.xdiffOptions(interner));
    let tlno = 0;
    let plno = 0;
    const handleSplit = (same: number) => {
      if (ent.numLines <= tlno || tlno >= same) return;
      const potential = splitOverlap(ent, tlno + ent.sLno, plno, same + ent.sLno, parent);
      this.copySplitIfBetter(split, potential);
    };
    for (const h of hunks) {
      handleSplit(h.i2);
      plno = h.i1 + h.chg1;
      tlno = h.i2 + h.chg2;
    }
    // the rest, if any, matches the parent
    handleSplit(ent.numLines);
    return split;
  }

  /** git's `find_move_in_parent`: lines the target is suspected for found in the parent's file */
  private async findMoveInParent(
    blamed: Queue,
    toosmallHead: Slot,
    target: Origin,
    parent: Origin,
  ): Promise<void> {
    let unblamed = target.suspects;
    if (!unblamed) return;
    const file = { text: await this.originContent(parent) };
    let toosmall = toosmallHead;
    let leftover: Entry | null = null;
    do {
      const head: Slot = { next: null };
      const rest: Queue = { tail: head };
      let next: Entry | null;
      for (let e: Entry | null = unblamed; e; e = next) {
        next = e.next;
        const split = this.findCopyInBlob(e, parent, file);
        if (split[1].suspect && this.moveScore < this.entryScore(split[1].lno, split[1].numLines)) {
          splitBlame(blamed, rest, split, e);
        } else {
          e.next = leftover;
          leftover = e;
        }
      }
      rest.tail.next = null;
      toosmall = this.filterSmall(toosmall, head, this.moveScore);
      unblamed = head.next;
    } while (unblamed);
    parent.lines = file.text;
    target.suspects = reverseBlame(leftover, null);
  }

  /**
   * git's `find_copy_in_parent`: lines the target is suspected for found in other files of
   * the parent (`porigin`, the parent's version of the file, was tried by the move pass)
   */
  private async findCopyInParent(
    blamed: Queue,
    toosmallHead: Slot,
    target: Origin,
    parentId: ObjectId,
    porigin: Origin | undefined,
  ): Promise<void> {
    let unblamed = target.suspects;
    if (!unblamed) return;
    const parent = await this.state(parentId);
    const child = this.states.get(target.commitId);
    if (!parent || !child) return;
    const harder =
      this.copyLevel >= 3 || (this.copyLevel >= 2 && (!porigin || target.path !== porigin.path));
    const candidates = await this.copyCandidates(parent.commit.tree, child.commit.tree, harder);
    /** Origins this call made: git frees those no split took (`blame_origin_decref`) */
    const created = new Set<Origin>();
    const taken = new Set<Origin>();
    let toosmall = toosmallHead;
    let leftover: Entry | null = null;
    do {
      const head: Slot = { next: null };
      const rest: Queue = { tail: head };
      const list: Array<{ ent: Entry; split: Split }> = [];
      // the line hashes of the entries: a file sharing none of them cannot give a split
      const wanted = new Set<number>();
      for (let e: Entry | null = unblamed; e; e = e.next) {
        list.push({ ent: e, split: emptySplit() });
        for (let l = e.lno; l < e.lno + e.numLines; l++) wanted.add(this.finalHashes[l]);
      }
      for (const c of candidates) {
        // find_move already dealt with this path
        if (porigin && c.path === porigin.path) continue;
        let hashes = this.copyHashes.get(c.id);
        let content: Uint8Array | undefined;
        if (hashes === undefined) {
          if (c.id !== target.blobId && (await this.isBig(c.id))) hashes = null;
          else {
            content = await this.readBlob(c.id, true);
            hashes = this.lineHashesOf(content);
          }
          this.keepCopyHashes(c.id, hashes);
        }
        if (hashes === null) continue;
        if (!sharesLine(hashes, wanted)) {
          // git's get_origin still moves a known origin to the front
          const known = parent.originsByPath.get(c.path);
          if (known) moveOriginToFront(parent, known);
          continue;
        }
        const isNew = !parent.originsByPath.has(c.path);
        const norigin = this.getOrigin(parentId, c.path);
        if (isNew) created.add(norigin);
        norigin.blobId = c.id;
        norigin.mode = c.mode;
        const file = {
          text:
            norigin.lines ??
            this.copySources.get(c.id) ??
            this.lineInterner().text(content ?? (await this.readBlob(c.id, true))),
        };
        for (const item of list) {
          this.copySplitIfBetter(item.split, this.findCopyInBlob(item.ent, norigin, file));
        }
        this.keepCopySourceText(c.id, file.text);
      }
      for (const { ent, split } of list) {
        if (split[1].suspect && this.copyScore < this.entryScore(split[1].lno, split[1].numLines)) {
          taken.add(split[1].suspect);
          splitBlame(blamed, rest, split, ent);
        } else {
          ent.next = leftover;
          leftover = ent;
        }
      }
      rest.tail.next = null;
      toosmall = this.filterSmall(toosmall, head, this.copyScore);
      unblamed = head.next;
    } while (unblamed);
    target.suspects = reverseBlame(leftover, null);
    for (const o of created) if (!taken.has(o) && !o.suspects) unlinkOrigin(parent, o);
  }

  /**
   * The hash of each line, as the line interner hashes it (`xdl_hash_record` under
   * whitespace flags): lines a diff can match hash alike
   */
  private lineHashesOf(content: Uint8Array): Int32Array {
    const lines = new ByteLines(content);
    const ws = whitespaceFlags({ ignoreWhitespace: this.ignoreWhitespace });
    const n = lines.size();
    if (!ws) return lines.lineHashes.slice(0, n);
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++)
      out[i] = xdlHashRecord(content, lines.start(i), lines.start(i + 1), ws);
    return out;
  }

  /**
   * Kept while the cache has room (and never evicted): a commit scans its parent's files in
   * the order the next one scans them, so evicting the oldest would evict every file before
   * its next use
   */
  private keepCopyHashes(blobId: ObjectId, hashes: Int32Array | null): void {
    const size = 64 + (hashes ? hashes.byteLength : 0);
    if (this.copyHashBytes + size > this.copyHashCacheBytes) return;
    this.copyHashes.set(blobId, hashes);
    this.copyHashBytes += size;
  }

  /** A file a copy was looked for in, interned, kept as `keepCopyHashes` keeps hashes */
  private keepCopySourceText(blobId: ObjectId, text: InternedText): void {
    const old = this.copySources.get(blobId);
    if (old) {
      this.copySources.set(blobId, text);
      return;
    }
    if (this.copySourceBytes + text.content.length > this.copySourceCacheBytes) return;
    this.copySources.set(blobId, text);
    this.copySourceBytes += text.content.length;
  }

  /**
   * The parent's files `find_copy_in_parent` looks in, in the order git's tree diff lists
   * them: those the commit changed or removed, or (`harder`, find_copies_harder) all of
   * them; never gitlinks
   */
  private async copyCandidates(
    parentTree: ObjectId,
    childTree: ObjectId,
    harder: boolean,
  ): Promise<Array<{ path: string; id: ObjectId; mode: number }>> {
    const out: Array<{ path: string; id: ObjectId; mode: number }> = [];
    const walk = async (tree: ObjectId, other: ObjectId | undefined, prefix: string) => {
      if (!harder && tree === other) return;
      const others = new Map<string, { id: ObjectId; mode: number }>();
      if (other && !harder) {
        for await (const e of this.trees.loadTree(other)) others.set(e.name, e);
      }
      for await (const e of this.trees.loadTree(tree)) {
        const path = prefix + e.name;
        const o = others.get(e.name);
        const kind = e.mode & S_IFMT;
        if (kind === TREE_MODE) {
          await walk(e.id, o && (o.mode & S_IFMT) === TREE_MODE ? o.id : undefined, `${path}/`);
        } else if (kind !== GITLINK_MODE) {
          if (!harder && o && o.id === e.id && o.mode === e.mode) continue;
          out.push({ path, id: e.id, mode: e.mode });
        }
      }
    };
    await walk(parentTree, childTree, "");
    return out;
  }

  /** git's `distribute_blame`: the entries found in parents queued to their origins */
  private distributeBlame(blamed: Entry | null, queue: CommitQueue): void {
    const ents: Entry[] = [];
    for (let e = blamed; e; e = e.next) ents.push(e);
    ents.sort((a, b) => a.suspect.seq - b.suspect.seq || a.sLno - b.sLno);
    let i = 0;
    while (i < ents.length) {
      const porigin = ents[i].suspect;
      let j = i;
      while (j + 1 < ents.length && ents[j + 1].suspect === porigin) {
        ents[j].next = ents[j + 1];
        j++;
      }
      ents[j].next = null;
      this.queueBlames(porigin, ents[i], queue);
      i = j + 1;
    }
  }

  /** The diff options of every comparison (`sb->xdl_opts`) */
  private xdiffOptions(interner: LineInterner): XdiffOptions {
    return {
      interner,
      algorithm: this.algorithm,
      indentHeuristic: this.indentHeuristic,
      ignoreWhitespace: this.ignoreWhitespace,
      ...this.diffOptions,
    };
  }

  /** mailmap.c's read_mailmap: `.mailmap` (not in a bare repository), `mailmap.blob`, `mailmap.file` */
  private async loadMailmap(): Promise<Mailmap> {
    const config = RemoteConfigStore.from(this.workingCopy);
    return readRepositoryMailmap({
      config: (key) => config.value(key),
      worktree: this.worktreeAccess,
      environment: hostEnvironmentOf(this.workingCopy),
      readBlobNamed: async (name) => {
        const id = await this.revisionResolver()
          .resolve(name)
          .catch(() => undefined);
        return id ? this.readBlob(id).catch(() => undefined) : undefined;
      },
    });
  }

  /** git's `pass_whole_blame` */
  private passWholeBlame(origin: Origin, porigin: Origin, queue: CommitQueue): void {
    if (!porigin.lines && origin.lines) {
      porigin.lines = origin.lines;
      origin.lines = undefined;
    }
    const suspects = origin.suspects;
    origin.suspects = null;
    for (let e = suspects; e; e = e.next) e.suspect = porigin;
    this.queueBlames(porigin, suspects, queue);
  }

  /** git's `queue_blames` */
  private queueBlames(porigin: Origin, sorted: Entry | null, queue: CommitQueue): void {
    if (porigin.suspects) {
      porigin.suspects = blameMerge(porigin.suspects, sorted);
      return;
    }
    const st = this.states.get(porigin.commitId);
    for (let o = st?.origins ?? null; o; o = o.next) {
      if (o.suspects) {
        porigin.suspects = sorted;
        return;
      }
    }
    porigin.suspects = sorted;
    if (st) queue.put(porigin.commitId, st.commit.committer.timestamp);
  }

  /** git's `pass_blame_to_parent` */
  private async passBlameToParent(
    target: Origin,
    parent: Origin,
    queue: CommitQueue,
  ): Promise<void> {
    if (!target.suspects) return;
    const newdest: Slot = { next: null };
    const src: Slot = { next: target.suspects };
    const d = { offset: 0, dstq: newdest as Slot, srcq: src as Slot };
    let fileP = await this.originContent(parent);
    let fileO = await this.originContent(target);
    // ids are comparable only within one interner: a version interned before blame started
    // a new interner is interned again in the current one
    const interner = this.lineInterner();
    if (fileP.interner !== interner) fileP = parent.lines = interner.text(fileP.content);
    if (fileO.interner !== interner) fileO = target.lines = interner.text(fileO.content);
    const hunks = xdiffHunks(fileP, fileO, this.xdiffOptions(interner));
    for (const h of hunks) {
      blameChunk(d, h.i2, h.i1 - h.i2, h.i2 + h.chg2, parent);
      d.offset = h.i1 + h.chg1 - (h.i2 + h.chg2);
    }
    blameChunk(d, INT_MAX, d.offset, INT_MAX, parent);
    d.dstq.next = null;
    target.suspects = src.next;
    this.queueBlames(parent, newdest.next, queue);
  }

  /** git's `find_origin`: the parent's version at the same path, of the same kind */
  private async findOrigin(parentId: ObjectId, origin: Origin): Promise<Origin | undefined> {
    const parent = this.states.get(parentId);
    if (!parent) return undefined;
    const known = parent.originsByPath.get(origin.path);
    if (known) return known;
    const entry = await this.lookup(parent.commit.tree, origin.path);
    if (!entry || (entry.mode & S_IFMT) !== (origin.mode & S_IFMT)) return undefined;
    if (entry.id !== origin.blobId && (await this.isBig(entry.id))) return undefined;
    const porigin = this.getOrigin(parentId, origin.path);
    porigin.blobId = entry.id;
    porigin.mode = entry.mode;
    return porigin;
  }

  /** git's `find_rename`: a file of the parent the commit's file was renamed from */
  private async findRename(parentId: ObjectId, origin: Origin): Promise<Origin | undefined> {
    const parent = this.states.get(parentId);
    const child = this.states.get(origin.commitId);
    if (!parent || !child) return undefined;
    // the path is a rename destination only when added (not a kind change)
    const inParent = await this.lookup(parent.commit.tree, origin.path);
    if (inParent) return undefined;
    const before = new Map<string, { id: ObjectId; mode: number }>();
    const after = new Map<string, { id: ObjectId; mode: number }>();
    await this.collectBlobs(parent.commit.tree, "", before);
    await this.collectBlobs(child.commit.tree, "", after);
    const sources = [];
    for (const [path, e] of before) {
      if (!after.has(path) && !(await this.isBig(e.id))) sources.push({ path, ...e });
    }
    if (sources.length === 0) return undefined;
    const config = RemoteConfigStore.from(this.workingCopy);
    const limit = intValue(config.value("diff.renameLimit")) ?? DEFAULT_RENAME_LIMIT;
    const pairs = await detectRenames(
      sources,
      [{ path: origin.path, id: origin.blobId, mode: origin.mode }],
      {
        renameLimit: limit,
        minimumScore: Math.round((this.renameScore * GIT_MAX_SCORE) / 100),
        countLastSpan: this.renameCountLastSpan,
        size: async (c) => this.blobs.size(c.id),
        load: async (c) => this.readBlob(c.id),
      },
    );
    const pair = pairs.find((p) => p.to === origin.path);
    if (!pair) return undefined;
    const src = before.get(pair.from);
    if (!src) return undefined;
    const porigin = this.getOrigin(parentId, pair.from);
    porigin.blobId = src.id;
    porigin.mode = src.mode;
    return porigin;
  }

  /** git's `get_origin`: the commit's origin for a path, moved to the front, or a new one */
  private getOrigin(commitId: ObjectId, path: string): Origin {
    const st = this.states.get(commitId);
    if (!st) throw new Error(`commit ${commitId} not loaded`);
    const known = st.originsByPath.get(path);
    if (known) {
      moveOriginToFront(st, known);
      return known;
    }
    const o: Origin = {
      seq: this.originSeq++,
      commitId,
      path,
      blobId: "",
      mode: 0,
      suspects: null,
      guilty: false,
      next: st.origins,
      prev: null,
    };
    if (st.origins) st.origins.prev = o;
    st.origins = o;
    st.originsByPath.set(path, o);
    return o;
  }

  private async state(commitId: ObjectId): Promise<CommitState | undefined> {
    const known = this.states.get(commitId);
    if (known) return known;
    const commit = await this.commits.load(commitId).catch(() => undefined);
    if (!commit) return undefined;
    const st: CommitState = {
      commit,
      origins: null,
      originsByPath: new Map(),
      uninteresting: false,
    };
    this.states.set(commitId, st);
    return st;
  }

  private async originContent(o: Origin): Promise<InternedText> {
    o.lines ??= this.lineInterner().text(await this.readBlob(o.blobId, true));
    return o.lines;
  }

  /**
   * The interner compared versions' lines go through (see `passBlameToParent`); a new one
   * once the current one holds more than `internerByteLimit` bytes of lines, so a long walk
   * does not keep every distinct line it has seen
   */
  private lineInterner(): LineInterner {
    if (!this.interner || this.interner.byteSize > this.internerByteLimit) {
      this.interner = new LineInterner(
        whitespaceFlags({ ignoreWhitespace: this.ignoreWhitespace }),
      );
    }
    return this.interner;
  }

  /** Whether a blob is over the threshold (from its size, without reading it). */
  private async isBig(blobId: ObjectId): Promise<boolean> {
    return (await this.blobs.size(blobId)) > this.bigFileThreshold;
  }

  /**
   * A blob's content; `shared` (for content only read here) takes a single chunk as it
   * comes (a resolved pack object) instead of copying it
   */
  private async readBlob(blobId: ObjectId, shared = false): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const content = await this.blobs.load(blobId);
    if (content) {
      for await (const chunk of content) {
        chunks.push(chunk);
        total += chunk.length;
      }
    }
    if (shared && chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  /** The non-tree entry at `path` in a tree */
  private async lookup(
    treeId: ObjectId,
    path: string,
  ): Promise<{ id: ObjectId; mode: number } | undefined> {
    const parts = path.split("/").filter((p) => p.length > 0);
    let current = treeId;
    for (let i = 0; i < parts.length; i++) {
      const entry = await this.trees.getEntry(current, parts[i]);
      if (!entry) return undefined;
      const isTree = (entry.mode & S_IFMT) === TREE_MODE;
      if (i === parts.length - 1) return isTree ? undefined : { id: entry.id, mode: entry.mode };
      if (!isTree) return undefined;
      current = entry.id;
    }
    return undefined;
  }

  private async collectBlobs(
    treeId: ObjectId,
    prefix: string,
    out: Map<string, { id: ObjectId; mode: number }>,
  ): Promise<void> {
    for await (const entry of this.trees.loadTree(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if ((entry.mode & S_IFMT) === TREE_MODE) await this.collectBlobs(entry.id, path, out);
      else out.set(path, { id: entry.id, mode: entry.mode });
    }
  }
}

/** git's `blame_chunk`: lines before `tlno` go to the parent, `[tlno, same)` stay */
function blameChunk(
  d: { offset: number; dstq: Slot; srcq: Slot },
  tlno: number,
  offset: number,
  same: number,
  parent: Origin,
): void {
  let e = d.srcq.next;
  let samep: Entry | null = null;
  let diffp: Entry | null = null;
  while (e && e.sLno < tlno) {
    const next: Entry | null = e.next;
    if (e.sLno + e.numLines > tlno) {
      const n = splitBlameAt(e, tlno - e.sLno, e.suspect);
      n.next = diffp;
      diffp = n;
    }
    e.suspect = parent;
    e.sLno += offset;
    e.next = samep;
    samep = e;
    e = next;
  }
  if (samep) {
    d.dstq.next = reverseBlame(samep, d.dstq.next);
    d.dstq = samep;
  }
  e = reverseBlame(diffp, e);
  samep = null;
  diffp = null;
  while (e && e.sLno < same) {
    const next: Entry | null = e.next;
    if (e.sLno + e.numLines > same) {
      const n = splitBlameAt(e, same - e.sLno, e.suspect);
      n.next = samep;
      samep = n;
    }
    e.next = diffp;
    diffp = e;
    e = next;
  }
  d.srcq.next = reverseBlame(diffp, reverseBlame(samep, e));
  if (diffp) d.srcq = diffp;
}

/** An identity mapped through the mailmap (`map_user`), the same object when nothing changes */
function mapIdent(mailmap: Mailmap, ident: PersonIdent): PersonIdent {
  const m = mailmap.map(ident.name, ident.email);
  if (m.name === ident.name && m.email === ident.email) return ident;
  return { ...ident, name: m.name, email: m.email };
}

/** Lines as git counts them: LF-terminated, an unterminated last line one more */
function countLines(content: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < content.length; i++) if (content[i] === 0x0a) n++;
  if (content.length > 0 && content[content.length - 1] !== 0x0a) n++;
  return n;
}

/** A git boolean (`git_config_bool`), undefined when unset or not one. */
const boolValue = (v: string | undefined): boolean | undefined => parseGitBool(v);

function intValue(value: string | undefined): number | undefined {
  const m = value?.trim().match(/^(-?\d+)([kmg]?)$/i);
  if (!m) return undefined;
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()] ?? 1;
  return Number(m[1]) * unit;
}

function algorithmValue(v: string | undefined): XdiffAlgorithm | undefined {
  const s = v?.trim().toLowerCase();
  if (s === "default") return "myers";
  return s === "myers" || s === "minimal" || s === "patience" || s === "histogram" ? s : undefined;
}

/**
 * Create a BlameResult from entries.
 */
function createBlameResult(
  path: string,
  lineCount: number,
  entries: BlameEntry[],
  content: Uint8Array,
): BlameResult {
  const lineToEntry = new Map<number, BlameEntry>();
  for (const entry of entries) {
    for (let i = 0; i < entry.lineCount; i++) lineToEntry.set(entry.resultStart + i, entry);
  }
  const sourceLine = (line: number): number | undefined => {
    const entry = lineToEntry.get(line);
    return entry ? entry.sourceStart + (line - entry.resultStart) : undefined;
  };
  return {
    path,
    lineCount,
    entries,
    content,
    getEntry: (line) => lineToEntry.get(line),
    getSourceCommit: (line) => lineToEntry.get(line)?.commit,
    getSourceAuthor: (line) => lineToEntry.get(line)?.commit.author,
    getSourceLine: sourceLine,
    getSourcePath: (line) => lineToEntry.get(line)?.sourcePath,
    getLineTracking(): LineTracking[] {
      const tracking: LineTracking[] = [];
      for (let line = 1; line <= lineCount; line++) {
        const entry = lineToEntry.get(line);
        if (entry) {
          tracking.push({
            resultLine: line,
            commit: entry.commit,
            commitId: entry.commitId,
            sourcePath: entry.sourcePath,
            sourceLine: entry.sourceStart + (line - entry.resultStart),
          });
        }
      }
      return tracking;
    },
  };
}
