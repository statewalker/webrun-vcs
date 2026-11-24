/**
 * The index as git's sparse-index-aware commands see it before they expand it: a sparse
 * index keeps each directory outside the cone as one sparse directory entry (`out/`, mode
 * 040000, skip-worktree), and a command such as `git rm` walks those entries as they are
 * unless its pathspec could match part of one (`pathspec_needs_expanded_index`). Ours always
 * holds the index expanded; this tells which directories git would still see collapsed.
 */

import type {
  SparseCheckoutPatterns,
  Staging,
  StagingEntry,
  Worktree,
} from "@statewalker/vcs-working-tree";
import { wildmatch } from "@statewalker/vcs-working-tree";
import { DO_MATCH_DIRECTORY, matchPathspecSeen, type PathspecItem } from "./pathspec.js";

/**
 * The sparse directories git leaves collapsed for `items` (pathspec.c's
 * `pathspec_needs_expanded_index` answered no), or undefined when the index was no sparse
 * index or git expands it. `sparseDirs` are the sparse directory entries the index file held
 * (`Staging.indexLayout().sparseDirectories`), `entries` the expanded index.
 *
 * @example
 * ```typescript
 * collapsedSparseDirectories(parsePathspec(["out"]), ["out/"], entries, patterns); // ["out/"]
 * collapsedSparseDirectories(parsePathspec(["out/f*"]), ["out/"], entries, patterns); // undefined
 * ```
 */
export function collapsedSparseDirectories(
  items: readonly PathspecItem[],
  sparseDirs: readonly string[] | undefined,
  entries: readonly StagingEntry[],
  patterns: SparseCheckoutPatterns | undefined,
): string[] | undefined {
  if (!sparseDirs || sparseDirs.length === 0) return undefined;
  // a magic pathspec: git assumes the index must be expanded
  if (items.some((i) => i.exclude || i.glob || i.icase || i.attr || i.prefix !== undefined)) {
    return undefined;
  }
  // path_in_cone_mode_sparse_checkout: an empty path, no patterns or non-cone ones accept it
  const inCone = (path: string) =>
    path === "" || !patterns || !patterns.cone || patterns.includes(path);
  const dirs = [...sparseDirs];
  const underDir = (path: string) => dirs.some((d) => path.startsWith(d));
  // matches_skip_worktree over the collapsed index: its skip-worktree entries (the sparse
  // directories among them) and those outside the patterns
  let skipSeen: number[] | undefined;
  const matchesSkipWorktree = (i: number): boolean => {
    if (!skipSeen) {
      const seen = items.map(() => 0);
      const list = items as PathspecItem[];
      for (const entry of entries) {
        if (underDir(entry.path)) continue;
        if (entry.skipWorktree || (patterns !== undefined && !patterns.includes(entry.path))) {
          const flags = entry.mode === 0o160000 ? DO_MATCH_DIRECTORY : 0;
          matchPathspecSeen(list, entry.path, flags, seen);
        }
      }
      for (const dir of dirs) matchPathspecSeen(list, dir, DO_MATCH_DIRECTORY, seen);
      skipSeen = seen;
    }
    return (skipSeen[i] ?? 0) > 0;
  };
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as PathspecItem;
    const match = item.match;
    if (item.nowildcardLen < match.length) {
      // a path in the cone followed by stars alone cannot match part of a sparse directory
      const rest = match.slice(item.nowildcardLen);
      if (/^\*+$/.test(rest) && inCone(match)) continue;
      for (const dir of dirs) {
        if (item.nowildcardLen > dir.length && match.startsWith(dir)) return undefined;
        if (
          match.slice(0, item.nowildcardLen) === dir.slice(0, item.nowildcardLen) &&
          !wildmatch(match, dir)
        ) {
          return undefined;
        }
      }
    } else if (!inCone(match) && !matchesSkipWorktree(i)) {
      return undefined;
    }
  }
  return dirs;
}

/**
 * git 2.5x's `advice.sparseIndexExpanded` (sparse-index.c `ADVICE_MSG`), given the first time
 * a command expands a sparse index to a full one, as its lines.
 */
export const SPARSE_INDEX_EXPANDED_HINT: readonly string[] = [
  "hint: The sparse index is expanding to a full index, a slow operation.",
  "hint: Your working directory likely has contents that are outside of",
  "hint: your sparse-checkout patterns. Use 'git sparse-checkout list' to",
  "hint: see your sparse-checkout definition and compare it to your working",
  "hint: directory contents. Cleaning up any merge conflicts or staged",
  "hint: changes before running 'git sparse-checkout clean' or 'git",
  "hint: sparse-checkout reapply' may assist in this cleanup.",
  'hint: Disable this message with "git config set advice.sparseIndexExpanded false"',
];

/**
 * The sparse directories of the index as git holds it once read (`repo_read_index`): the
 * sparse directory entries the file held, unless one of them is present in the worktree, in
 * which case git's `clear_skip_worktree_from_present_files` expands the whole index at once
 * (`expanded`; 2.5x gives its hint then). Nothing is cleared without `core.sparseCheckout`
 * or with `sparse.expectFilesOutsideOfPatterns`.
 *
 * @example
 * ```typescript
 * const read = await sparseIndexAsRead(staging, worktree, config);
 * if (read.expanded) hint.push(...SPARSE_INDEX_EXPANDED_HINT);
 * ```
 */
export async function sparseIndexAsRead(
  staging: Staging,
  worktree: Worktree | undefined,
  configBool: (key: string, fallback: boolean) => boolean,
): Promise<{ sparseDirs?: readonly string[]; expanded: boolean }> {
  const sparseDirs = staging.indexLayout?.().sparseDirectories;
  if (!sparseDirs || sparseDirs.length === 0) return { expanded: false };
  if (
    worktree &&
    configBool("core.sparseCheckout", false) &&
    !configBool("sparse.expectFilesOutsideOfPatterns", false)
  ) {
    for (const dir of sparseDirs) {
      // path_found: lstat of the directory's name
      const path = dir.replace(/\/+$/, "");
      if (await worktree.getEntry(path).catch(() => undefined)) return { expanded: true };
    }
  }
  return { sparseDirs, expanded: false };
}
