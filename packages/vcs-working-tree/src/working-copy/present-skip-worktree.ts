/**
 * git's `clear_skip_worktree_from_present_files` (sparse-index.c), run by `repo_read_index`
 * whenever a command reads the index in a sparse checkout: a skip-worktree entry whose path
 * exists in the worktree (any kind, as `lstat` finds it) is taken as in the checkout again.
 */

import type { Staging, StagingEntry } from "../staging/index.js";
import { getWorktreeEntries } from "../status/index.js";
import type { Worktree } from "../worktree/index.js";

/**
 * Clears the skip-worktree flag of the index entries whose files are present in the worktree,
 * as git does on reading the index when `core.sparseCheckout` is on (and
 * `sparse.expectFilesOutsideOfPatterns` is not): the caller checks the configuration. Cheap
 * without skip-worktree entries; the paths are stat'ed in batches (`getEntries`), their
 * leading directories first, so a missing sparse directory costs one stat, as git's
 * `path_found` makes it. The flags are cleared as part of the read (not
 * an edit, see `Staging.clearSkipWorktree`). Returns the paths cleared.
 *
 * @example
 * ```typescript
 * if (sparseCheckout) await clearSkipWorktreeFromPresentFiles(staging, worktree);
 * ```
 */
export async function clearSkipWorktreeFromPresentFiles(
  staging: Staging,
  worktree: Pick<Worktree, "getEntry" | "getEntries">,
): Promise<string[]> {
  const skipped: string[] = [];
  const list = staging.entryList?.();
  const consider = (entry: StagingEntry) => {
    // any stage: git clears every `ce_skip_worktree` entry found (a path once per stage)
    if (entry.skipWorktree && skipped[skipped.length - 1] !== entry.path) skipped.push(entry.path);
  };
  if (list) for (const entry of list) consider(entry);
  else for await (const entry of staging.entries()) consider(entry);
  if (skipped.length === 0) return [];

  const present = await presentPaths(worktree, skipped);
  if (present.size === 0) return [];
  if (typeof staging.clearSkipWorktree === "function") {
    staging.clearSkipWorktree(present);
  } else {
    const editor = staging.createEditor();
    for (const path of present) {
      editor.add({
        path,
        apply: (existing) =>
          existing?.skipWorktree ? { ...existing, skipWorktree: false } : existing,
      });
    }
    await editor.finish();
  }
  return [...present];
}

/** `getWorktreeEntries`, a path that cannot be stat'ed counting as missing (as `lstat` failing). */
async function statAll(
  worktree: Pick<Worktree, "getEntry" | "getEntries">,
  paths: string[],
): Promise<boolean[]> {
  if (paths.length === 0) return [];
  try {
    return (await getWorktreeEntries(worktree, paths)).map((e) => e !== undefined);
  } catch {
    const out: boolean[] = [];
    for (const path of paths)
      out.push((await worktree.getEntry(path).catch(() => undefined)) !== undefined);
    return out;
  }
}

/**
 * The paths that exist (`lstat` succeeds), stat'ed in batches: their leading directories
 * first, one level at a time and only beneath directories found, so a missing directory
 * answers for everything in it with one stat (git's `path_found`), then the paths whose
 * directories all exist.
 */
async function presentPaths(
  worktree: Pick<Worktree, "getEntry" | "getEntries">,
  paths: readonly string[],
): Promise<Set<string>> {
  const found = new Map<string, boolean>();
  const dirsOf = (path: string) => {
    const dirs: string[] = [];
    for (let k = path.indexOf("/"); k > 0; k = path.indexOf("/", k + 1))
      dirs.push(path.slice(0, k));
    return dirs;
  };
  const chains = paths.map(dirsOf);
  for (let depth = 0; ; depth++) {
    const asking = new Set<string>();
    for (const dirs of chains) {
      if (dirs.length <= depth) continue;
      if (depth > 0 && found.get(dirs[depth - 1] as string) !== true) continue;
      const dir = dirs[depth] as string;
      if (!found.has(dir)) asking.add(dir);
    }
    if (asking.size === 0) break;
    const list = [...asking];
    const exists = await statAll(worktree, list);
    for (let i = 0; i < list.length; i++) found.set(list[i] as string, exists[i] === true);
  }
  const candidates = paths.filter((_, i) =>
    (chains[i] as string[]).every((dir) => found.get(dir) === true),
  );
  const exists = await statAll(worktree, candidates);
  return new Set(candidates.filter((_, i) => exists[i]));
}
