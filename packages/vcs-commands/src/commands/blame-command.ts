import type { Commit, ObjectId, PersonIdent } from "@statewalker/vcs-core";
import { DEFAULT_BIG_FILE_THRESHOLD } from "@statewalker/vcs-core";
import {
  type InternedText,
  LineInterner,
  parseGitBool,
  type SupportedAlgorithm,
  whitespaceFlags,
  type XdiffAlgorithm,
  type XdiffOptions,
  xdiffHunks,
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
import { canonicalObjectId } from "./object-id-input.js";

/** Line bytes the interner holds before blame starts a new one (see `setInternerByteLimit`) */
const DEFAULT_INTERNER_BYTE_LIMIT = 64 * 1024 * 1024;

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
  uninteresting: boolean;
}

const S_IFMT = 0o170000;
const TREE_MODE = 0o040000;
const INT_MAX = Number.MAX_SAFE_INTEGER;

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
 * Moves and copies across lines (`-M`, `-C`), `--reverse`, `--ignore-rev` and the mailmap
 * are not supported.
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
  /** Never writes refs: runs in a repository whose ref store only reads. */
  protected override get writesRefs(): boolean {
    return false;
  }

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

    const entries: BlameEntry[] = [];
    for (const e of coalesced) {
      const st = this.states.get(e.suspect.commitId);
      if (!st) continue;
      const prev = e.suspect.previous;
      entries.push({
        commit: st.commit,
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

  /** git's `pass_blame` (without -M/-C) */
  private async passBlame(origin: Origin, queue: CommitQueue): Promise<void> {
    const st = this.states.get(origin.commitId);
    if (!st) return;
    const parents = st.commit.parents;
    const n = parents.length;
    if (n === 0) return;
    const sgOrigin: Array<Origin | undefined> = new Array(n).fill(undefined);
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
      if (!origin.suspects) break;
    }
    origin.lines = undefined;
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
    const hunks = xdiffHunks(fileP, fileO, {
      interner,
      algorithm: this.algorithm,
      indentHeuristic: this.indentHeuristic,
      ignoreWhitespace: this.ignoreWhitespace,
      ...this.diffOptions,
    });
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
    for (let o = parent.origins; o; o = o.next) if (o.path === origin.path) return o;
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
    let l: Origin | null = null;
    for (let o = st.origins; o; l = o, o = o.next) {
      if (o.path === path) {
        if (l) {
          l.next = o.next;
          o.next = st.origins;
          st.origins = o;
        }
        return o;
      }
    }
    const o: Origin = {
      commitId,
      path,
      blobId: "",
      mode: 0,
      suspects: null,
      guilty: false,
      next: st.origins,
    };
    st.origins = o;
    return o;
  }

  private async state(commitId: ObjectId): Promise<CommitState | undefined> {
    const known = this.states.get(commitId);
    if (known) return known;
    const commit = await this.commits.load(commitId).catch(() => undefined);
    if (!commit) return undefined;
    const st: CommitState = { commit, origins: null, uninteresting: false };
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
