/**
 * git's `clear_skip_worktree_from_present_files` (sparse-index.c), run by `repo_read_index`
 * whenever a command reads the index in a sparse checkout: a skip-worktree entry whose path
 * exists in the worktree (any kind, as `lstat` finds it) is taken as in the checkout again.
 */

import type { Staging, StagingEntry } from "../staging/index.js";
import type { Worktree } from "../worktree/index.js";

/**
 * Clears the skip-worktree flag of the index entries whose files are present in the worktree,
 * as git does on reading the index when `core.sparseCheckout` is on (and
 * `sparse.expectFilesOutsideOfPatterns` is not): the caller checks the configuration. Cheap
 * without skip-worktree entries; missing directories are remembered, as git's `path_found`
 * does, so a sparse directory costs one stat. The flags are cleared as part of the read (not
 * an edit, see `Staging.clearSkipWorktree`). Returns the paths cleared.
 *
 * @example
 * ```typescript
 * if (sparseCheckout) await clearSkipWorktreeFromPresentFiles(staging, worktree);
 * ```
 */
export async function clearSkipWorktreeFromPresentFiles(
  staging: Staging,
  worktree: Pick<Worktree, "getEntry">,
): Promise<string[]> {
  const skipped: string[] = [];
  const list = staging.entryList?.();
  const consider = (entry: StagingEntry) => {
    if (entry.skipWorktree && entry.stage === 0) skipped.push(entry.path);
  };
  if (list) for (const entry of list) consider(entry);
  else for await (const entry of staging.entries()) consider(entry);
  if (skipped.length === 0) return [];

  const exists = async (path: string) => {
    try {
      return (await worktree.getEntry(path)) !== undefined;
    } catch {
      return false;
    }
  };
  // git's path_found: `missing` is a path known not to exist, with a trailing slash
  let missing = "";
  const found = async (path: string): Promise<boolean> => {
    if (missing && path.startsWith(missing)) return false;
    if (await exists(path)) return true;
    // the top-most missing directory of `path`, from the parent `missing` shares with it
    let common = 0;
    for (let i = 0; i < path.length && i < missing.length; i++) {
      if (path[i] !== missing[i]) break;
      if (path[i] === "/") common = i + 1;
    }
    let dir = missing.slice(0, common);
    while (true) {
      const slash = path.indexOf("/", dir.length);
      if (slash < 0) {
        missing = `${path}/`;
        return false;
      }
      dir = path.slice(0, slash + 1);
      if (!(await exists(dir.slice(0, -1)))) {
        missing = dir;
        return false;
      }
    }
  };
  const present = new Set<string>();
  for (const path of skipped) if (await found(path)) present.add(path);
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
