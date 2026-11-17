/**
 * git's rename detection (`diffcore_rename`) over deleted and added paths: exact renames
 * first (the same blob), then renames between files of the same unique basename scoring at
 * least halfway between the threshold and 100%, then the best remaining pairs scoring at
 * least the threshold, as long as the candidates fit the rename limit.
 */

import { EMPTY_BLOB_ID, type ObjectId } from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import {
  estimateSimilarity,
  GIT_DEFAULT_RENAME_SCORE,
  GIT_MAX_SCORE,
  type SimilaritySide,
  type SpanCounts,
  spanCounts,
} from "./git-similarity.js";

/** A deleted (source) or added (destination) path. */
export interface RenameCandidate {
  path: string;
  mode: number;
  /** The blob id (for a worktree file: the id of its content) */
  id: ObjectId;
}

/** A source paired with a destination. */
export interface RenamePair {
  from: string;
  to: string;
  /** 0..{@link GIT_MAX_SCORE} (git's `p->score`); exact renames score the full score */
  score: number;
}

/** What rename detection needs. */
export interface DetectRenamesOptions {
  /** The content of a candidate, for inexact renames */
  load(candidate: RenameCandidate, side: "source" | "destination"): Promise<Uint8Array>;
  /**
   * The size of a candidate without reading it (`Blobs.size`), when known: a candidate is
   * then read only when it is compared, and its content is not kept afterwards
   */
  size?(candidate: RenameCandidate, side: "source" | "destination"): Promise<number | undefined>;
  /**
   * Whether empty files are paired (git's `rename_empty`): on for `diff` and `status`
   * (default), off in merges (merge-ort), where an empty file is never a rename
   */
  renameEmpty?: boolean;
  /**
   * Called when inexact renames were skipped because the candidates exceed the rename limit,
   * with the limit that would have been needed (git's `needed_rename_limit`)
   */
  onRenameLimit?(needed: number): void;
  /** Threshold, 0..{@link GIT_MAX_SCORE} (default 50%) */
  minimumScore?: number;
  /**
   * git's `diff.renameLimit`: inexact renames are looked for only when the remaining sources
   * times destinations stay within its square (default 1000; 0 or less: 32767, as git)
   */
  renameLimit?: number;
  /** Count a last span without a newline, as git 2.5x (default); false as git 2.43 */
  countLastSpan?: boolean;
  /**
   * merge-ort: the sources a merge needs paired (git's `relevant_sources`, by path:
   * {@link RELEVANT_CONTENT} or {@link RELEVANT_LOCATION}). Every source takes part in exact
   * renames; only these in the others
   */
  relevantSources?: Map<string, number>;
  /**
   * merge-ort: the directories this side removed (git's `dirs_removed`, by path:
   * {@link NOT_RELEVANT}, {@link RELEVANT_FOR_ANCESTOR} or {@link RELEVANT_FOR_SELF}); may be
   * changed (a directory whose rename is already clear is then needed for its ancestors only)
   */
  dirsRemoved?: Map<string, number>;
  /**
   * merge-ort: filled with how many files moved from each removed directory to each other
   * directory (git's `dir_rename_count`), for directory rename detection
   */
  dirRenameCount?: Map<string, Map<string, number>>;
  /**
   * merge-ort: the renames (source -> destination; none: a deletion) already known from a
   * first pass (git's `cached_pairs`), counted into `dirRenameCount` with the others
   */
  cachedPairs?: Iterable<[string, string | undefined]>;
  /** Keep the order the candidates are given in (default: sorted by path) */
  keepOrder?: boolean;
}

/** A source a merge needs for its content (the other side changed it). */
export const RELEVANT_CONTENT = 1;
/** A source a merge needs only to tell where its directory went. */
export const RELEVANT_LOCATION = 2;
/** A removed directory whose rename no path needs. */
export const NOT_RELEVANT = 0;
/** A removed directory whose rename only paths under a subdirectory need. */
export const RELEVANT_FOR_ANCESTOR = 1;
/** A removed directory the other side added a path to. */
export const RELEVANT_FOR_SELF = 2;

/** git's placeholder destination of a source not paired yet (a directory cannot be "/"). */
const UNKNOWN_DIR = "/";

const dirnameOf = (path: string) => {
  const k = path.lastIndexOf("/");
  return k < 0 ? "" : path.slice(0, k);
};

/** The directory rename bookkeeping of a merge's rename detection (git's `dir_rename_info`). */
class DirRenameInfo {
  /** Each removed directory's most likely new directory so far (`dir_rename_guess`) */
  readonly guess = new Map<string, string>();
  /** The destinations not paired yet, by path (`idx_map`) */
  readonly idx = new Map<string, number>();

  constructor(
    readonly counts: Map<string, Map<string, number>>,
    readonly dirsRemoved: Map<string, number> | undefined,
  ) {}

  increment(oldDir: string, newDir: string): void {
    let counts = this.counts.get(oldDir);
    if (!counts) {
      counts = new Map();
      this.counts.set(oldDir, counts);
    }
    counts.set(newDir, (counts.get(newDir) ?? 0) + 1);
  }

  /**
   * git's update_dir_rename_counts: a rename counts for the old file's directory, and for
   * each removed ancestor needed for itself as long as the trailing directories agree
   * (`a/b/c/f` -> `x/c/f` counts `a/b/c` -> `x/c` and `a/b` -> `x`)
   */
  update(oldName: string, newName: string): void {
    let prevOld = oldName;
    let prevNew = newName;
    let first = true;
    for (;;) {
      const oldDir = dirnameOf(prevOld);
      if (this.dirsRemoved && !this.dirsRemoved.has(oldDir)) break;
      const newDir = dirnameOf(prevNew);
      if (!first && basename(prevOld) !== basename(prevNew)) break;
      const flag = this.dirsRemoved?.get(oldDir) ?? NOT_RELEVANT;
      if (flag === RELEVANT_FOR_SELF || first) this.increment(oldDir, newDir);
      first = false;
      if (flag === NOT_RELEVANT) break;
      if (!oldDir || !newDir) break;
      prevOld = oldDir;
      prevNew = newDir;
    }
  }

  /** The new path of `path` by the best directory guess, as a destination index (or -1). */
  possibleRename(path: string): number {
    const newDir = this.guess.get(dirnameOf(path));
    if (newDir === undefined) return -1;
    return this.idx.get(`${newDir}/${basename(path)}`) ?? -1;
  }
}

/** The destination directory with the highest count (the first of equals). */
function highestRenamePath(counts: Map<string, number>): string | undefined {
  let highest = 0;
  let best: string | undefined;
  for (const [dir, count] of counts) {
    if (count > highest) {
      highest = count;
      best = dir;
    }
  }
  return best;
}

/** Whether more sources point to one directory than to all others and the unknown together. */
function dirRenameAlreadyDeterminable(counts: Map<string, number>): boolean {
  let first = 0;
  let second = 0;
  let unknown = 0;
  for (const [dir, count] of counts) {
    if (dir === UNKNOWN_DIR) unknown = count;
    else if (count >= first) {
      second = first;
      first = count;
    } else if (count >= second) second = count;
  }
  return first > second + unknown;
}

/** git's default `diff.renameLimit`. */
export const DEFAULT_RENAME_LIMIT = 1000;

/** The limit git uses for a `diff.renameLimit` of 0 or less. */
const MAX_RENAME_LIMIT = 32767;

const S_IFMT = 0o170000;
const isRegular = (mode: number) => (mode & S_IFMT) === 0o100000;
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const byPath = (a: RenameCandidate, b: RenameCandidate) => compareBytes(a.path, b.path);

/** git's path order (bytes, as `strcmp`). */
function compareBytes(a: string, b: string): number {
  return compareGitPaths(a, b);
}

/** git keeps this many best sources per destination (`NUM_CANDIDATE_PER_DST`). */
const CANDIDATES_PER_DESTINATION = 4;

interface Score {
  dst: number;
  src: number;
  score: number;
  nameScore: number;
}

/** git's `score_compare`: unused slots last, then higher score, then a same basename. */
function scoreCompare(a: Score, b: Score): number {
  if (a.dst < 0) return b.dst >= 0 ? 1 : 0;
  if (b.dst < 0) return -1;
  if (a.score === b.score) return b.nameScore - a.nameScore;
  return b.score - a.score;
}

/**
 * Pairs deleted paths with added ones as git's `diffcore_rename` (renames, not copies):
 * each source and each destination in at most one pair.
 *
 * @example
 * ```typescript
 * const pairs = await detectRenames(deleted, added, { load: (c) => readBlob(c.id) });
 * // [{ from: "a.txt", to: "b.txt", score: 60000 }]
 * ```
 */
export async function detectRenames(
  sources: RenameCandidate[],
  destinations: RenameCandidate[],
  options: DetectRenamesOptions,
): Promise<RenamePair[]> {
  const minimumScore = options.minimumScore ?? GIT_DEFAULT_RENAME_SCORE;
  const configured = options.renameLimit ?? DEFAULT_RENAME_LIMIT;
  const renameLimit = configured <= 0 ? MAX_RENAME_LIMIT : configured;
  // merges leave empty files out of rename detection (git's rename_empty = 0)
  const keep = (c: RenameCandidate) => options.renameEmpty !== false || c.id !== EMPTY_BLOB_ID;
  // in path order, or as given (a merge: the order its trees were read in)
  const src = options.keepOrder ? sources.filter(keep) : sources.filter(keep).sort(byPath);
  const dst = options.keepOrder
    ? destinations.filter(keep)
    : destinations.filter(keep).sort(byPath);
  const pairs: RenamePair[] = [];
  if (src.length === 0 || dst.length === 0) return pairs;
  const srcUsed = new Set<number>();
  const dstDone = new Set<number>();
  const record = (d: number, s: number, score: number) => {
    dstDone.add(d);
    srcUsed.add(s);
    pairs.push({ from: src[s].path, to: dst[d].path, score });
  };

  // exact renames (`find_exact_renames`): an unused source of the same blob, one of the same
  // basename preferred; links and submodules only of the same mode
  const byId = new Map<string, number[]>();
  src.forEach((s, i) => {
    const list = byId.get(s.id) ?? [];
    list.push(i);
    byId.set(s.id, list);
  });
  for (let d = 0; d < dst.length; d++) {
    const target = dst[d];
    let best = -1;
    let bestScore = -1;
    let left = 100;
    for (const s of byId.get(target.id) ?? []) {
      const source = src[s];
      if ((!isRegular(source.mode) || !isRegular(target.mode)) && source.mode !== target.mode) {
        continue;
      }
      if (srcUsed.has(s)) continue;
      const score = 1 + (basename(source.path) === basename(target.path) ? 1 : 0);
      if (score > bestScore) {
        best = s;
        bestScore = score;
        if (score === 2) break;
      }
      if (!--left) break;
    }
    if (best >= 0) record(d, best, GIT_MAX_SCORE);
  }
  if (minimumScore >= GIT_MAX_SCORE) return pairs;

  // each candidate's size, and its span counts once first compared; the content itself is
  // dropped as soon as its spans are counted
  const sides = new Map<RenameCandidate, Promise<SimilaritySide>>();
  const side = (candidate: RenameCandidate, role: "source" | "destination") => {
    let known = sides.get(candidate);
    if (!known) {
      known = (async () => {
        let bytes: Uint8Array | undefined;
        let size = await options.size?.(candidate, role);
        if (size === undefined) {
          bytes = await options.load(candidate, role);
          size = bytes.length;
        }
        let spans: SpanCounts | undefined;
        return {
          mode: candidate.mode,
          size,
          spans: async () => {
            if (!spans) {
              const content = bytes ?? (await options.load(candidate, role));
              bytes = undefined;
              spans = spanCounts(content, { countLastSpan: options.countLastSpan });
            }
            return spans;
          },
        };
      })();
      sides.set(candidate, known);
    }
    return known;
  };
  const similarity = async (s: number, d: number, minimum: number) =>
    isRegular(src[s].mode) && isRegular(dst[d].mode)
      ? estimateSimilarity(await side(src[s], "source"), await side(dst[d], "destination"), minimum)
      : 0;

  // merge-ort's directory rename bookkeeping (`initialize_dir_rename_info`): the exact
  // renames counted, a first guess of where each removed directory went
  const relevant = options.relevantSources;
  const dirsRemoved = options.dirsRemoved;
  const info =
    relevant || dirsRemoved
      ? new DirRenameInfo(options.dirRenameCount ?? new Map(), dirsRemoved)
      : undefined;
  if (info) {
    info.counts.clear();
    const renamedTo = new Map(pairs.map((p) => [p.to, p.from]));
    dst.forEach((d, i) => {
      const from = renamedTo.get(d.path);
      if (from === undefined) info.idx.set(d.path, i);
      else info.update(from, d.path);
    });
    for (const [from, to] of options.cachedPairs ?? []) if (to !== undefined) info.update(from, to);
    for (const [dir, counts] of info.counts) {
      const best = highestRenamePath(counts);
      if (best !== undefined) info.guess.set(dir, best);
    }
  }
  const recordPair = (d: number, s: number, score: number) => {
    record(d, s, score);
    info?.update(src[s].path, dst[d].path);
  };

  // renames between the only source and the only destination of a basename, or where the
  // directory guess puts a source of a shared basename (`find_basename_matches`), at the
  // higher threshold; a merge only for the sources it needs
  const minimumBasenameScore = minimumScore + Math.trunc(0.5 * (GIT_MAX_SCORE - minimumScore));
  const unique = (paths: Array<[number, string]>) => {
    const map = new Map<string, number>();
    for (const [i, path] of paths) {
      const base = basename(path);
      map.set(base, map.has(base) ? -1 : i);
    }
    return map;
  };
  const liveSources = () => src.map((s, i) => i).filter((i) => !srcUsed.has(i));
  const srcNames = unique(liveSources().map((i) => [i, src[i].path]));
  const dstNames = unique(
    dst.map((d, i) => [i, d.path] as [number, string]).filter(([i]) => !dstDone.has(i)),
  );
  for (const i of liveSources()) {
    if (relevant && !relevant.has(src[i].path)) continue;
    const base = basename(src[i].path);
    if (!dstNames.has(base)) continue;
    let s = srcNames.get(base) ?? -1;
    let d = dstNames.get(base) ?? -1;
    if (s < 0 || d < 0) {
      s = i;
      d = info ? info.possibleRename(src[i].path) : -1;
    }
    if (d < 0 || dstDone.has(d) || srcUsed.has(s)) continue;
    const score = await similarity(s, d, minimumBasenameScore);
    if (score < minimumBasenameScore) continue;
    recordPair(d, s, score);
  }

  // a merge drops the sources it does not need (`remove_unneeded_paths_from_src`), then
  // the ones only needed for a directory rename that is already clear
  // (`handle_early_known_dir_renames`)
  let candidates = liveSources();
  if (relevant) candidates = candidates.filter((s) => relevant.has(src[s].path));
  if (info && relevant && dirsRemoved) {
    for (const s of candidates) {
      for (
        let dir = dirnameOf(src[s].path);
        dir !== "" && (dirsRemoved.get(dir) ?? NOT_RELEVANT) !== NOT_RELEVANT;
        dir = dirnameOf(dir)
      ) {
        info.increment(dir, UNKNOWN_DIR);
      }
    }
    for (const [dir, counts] of info.counts) {
      if (dirsRemoved.get(dir) === RELEVANT_FOR_SELF && dirRenameAlreadyDeterminable(counts)) {
        dirsRemoved.set(dir, RELEVANT_FOR_ANCESTOR);
      }
    }
    candidates = candidates.filter((s) => {
      if (relevant.get(src[s].path) !== RELEVANT_LOCATION) return true;
      for (let dir = dirnameOf(src[s].path); ; dir = dirnameOf(dir)) {
        const flag = dirsRemoved.get(dir) ?? NOT_RELEVANT;
        if (flag === NOT_RELEVANT) break;
        if (flag === RELEVANT_FOR_SELF) return true;
      }
      relevant.set(src[s].path, 0);
      return false;
    });
  }
  const finish = () => {
    // only the removed directories still needed keep their counts (`cleanup_dir_rename_info`)
    if (!info || !dirsRemoved) return pairs;
    for (const [dir, counts] of [...info.counts]) {
      if (!dirsRemoved.get(dir)) info.counts.delete(dir);
      else counts.delete(UNKNOWN_DIR);
    }
    return pairs;
  };

  // the best remaining pairs, within the rename limit
  const remainingSources = candidates;
  const remainingDestinations = dst.map((_, i) => i).filter((i) => !dstDone.has(i));
  if (remainingSources.length === 0 || remainingDestinations.length === 0) return finish();
  if (remainingSources.length * remainingDestinations.length > renameLimit * renameLimit) {
    options.onRenameLimit?.(Math.max(remainingSources.length, remainingDestinations.length));
    return finish();
  }
  const matrix: Score[] = [];
  for (const d of remainingDestinations) {
    const slots: Score[] = Array.from({ length: CANDIDATES_PER_DESTINATION }, () => ({
      dst: -1,
      src: -1,
      score: 0,
      nameScore: 0,
    }));
    for (const s of remainingSources) {
      const candidate: Score = {
        dst: d,
        src: s,
        score: await similarity(s, d, minimumScore),
        nameScore: basename(src[s].path) === basename(dst[d].path) ? 1 : 0,
      };
      // `record_if_better`: replaces the worst slot when better
      let worst = 0;
      for (let k = 1; k < slots.length; k++) {
        if (scoreCompare(slots[k], slots[worst]) > 0) worst = k;
      }
      if (scoreCompare(slots[worst], candidate) > 0) slots[worst] = candidate;
    }
    matrix.push(...slots);
  }
  matrix.sort(scoreCompare);
  for (const m of matrix) {
    if (m.dst < 0 || m.score < minimumScore) break;
    if (dstDone.has(m.dst) || srcUsed.has(m.src)) continue;
    recordPair(m.dst, m.src, m.score);
  }
  return finish();
}
