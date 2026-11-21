import type { Staging } from "./staging.js";

/**
 * git's `is_index_unborn`: no entries and no index file read or written yet (a clone with
 * `--no-checkout`, `worktree add --no-checkout`, a deleted `.git/index`). checkout and the
 * two-tree `read-tree -m` then run unpack-trees as an initial checkout, writing every entry
 * of the target where an empty index would read as all of HEAD's files staged as deleted.
 * Stores that never lack an index (memory, KV, SQL: their update time is set at creation)
 * are never unborn.
 */
export async function isIndexUnborn(staging: Staging): Promise<boolean> {
  if (staging.getUpdateTime() !== 0) return false;
  return (await staging.getEntryCount()) === 0;
}
