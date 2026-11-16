/**
 * git's rename detection (`diffcore_rename`) over deleted and added paths: exact renames
 * first (the same blob), then renames between files of the same unique basename scoring at
 * least halfway between the threshold and 100%, then the best remaining pairs scoring at
 * least the threshold, as long as the candidates fit the rename limit.
 */

import { EMPTY_BLOB_ID, type ObjectId } from "@statewalker/vcs-core";
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
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n; i++) if (ea[i] !== eb[i]) return ea[i] - eb[i];
  return ea.length - eb.length;
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
  const src = sources.filter(keep).sort(byPath);
  const dst = destinations.filter(keep).sort(byPath);
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

  // renames between the only source and the only destination of a basename
  // (`find_basename_matches`), at the higher threshold
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
  for (const s of liveSources()) {
    const base = basename(src[s].path);
    if (srcNames.get(base) !== s || !dstNames.has(base)) continue;
    const d = dstNames.get(base) ?? -1;
    if (d < 0 || dstDone.has(d)) continue;
    const score = await similarity(s, d, minimumBasenameScore);
    if (score < minimumBasenameScore) continue;
    record(d, s, score);
  }

  // the best remaining pairs, within the rename limit
  const remainingSources = liveSources();
  const remainingDestinations = dst.map((_, i) => i).filter((i) => !dstDone.has(i));
  if (remainingSources.length === 0 || remainingDestinations.length === 0) return pairs;
  if (remainingSources.length * remainingDestinations.length > renameLimit * renameLimit) {
    options.onRenameLimit?.(Math.max(remainingSources.length, remainingDestinations.length));
    return pairs;
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
    record(m.dst, m.src, m.score);
  }
  return pairs;
}
