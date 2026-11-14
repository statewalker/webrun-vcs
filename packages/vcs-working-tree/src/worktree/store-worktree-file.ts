/**
 * Store a worktree file as a blob, in one pass when its size is known.
 */
import type { Blobs, ObjectId } from "@statewalker/vcs-core";
import type { WorktreeEntry } from "./types.js";
import type { Worktree } from "./worktree.js";

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

const isSizeMismatch = (e: unknown) => (e as Error)?.name === "SizeMismatchError";
const isRegularFile = (entry: WorktreeEntry) =>
  !entry.isDirectory && (entry.mode & S_IFMT) === S_IFREG;

/**
 * A regular file is stored with the size the worktree reported, so the blob is
 * written in one pass without holding the file in memory. If the file changed
 * while it was read (`SizeMismatchError`), it is stat'ed again and stored once
 * more with its new size, as git retries a file that changed during `git add`.
 * If that read disagrees too, or for symlinks and anything else, the content is
 * stored without a size (spooled when it is large; see `Blobs.store`).
 *
 * @example
 * ```typescript
 * const entry = await worktree.getEntry("big.bin");
 * if (entry) await storeWorktreeFile(history.blobs, worktree, "big.bin", entry);
 * ```
 */
export async function storeWorktreeFile(
  blobs: Blobs,
  worktree: Worktree,
  path: string,
  entry: WorktreeEntry,
): Promise<ObjectId> {
  if (isRegularFile(entry)) {
    try {
      return await blobs.store(worktree.readContent(path), entry.size);
    } catch (e) {
      if (!isSizeMismatch(e)) throw e;
    }
    const fresh = await worktree.getEntry(path);
    if (fresh && isRegularFile(fresh)) {
      try {
        return await blobs.store(worktree.readContent(path), fresh.size);
      } catch (e) {
        if (!isSizeMismatch(e)) throw e;
      }
    }
  }
  return blobs.store(worktree.readContent(path));
}
