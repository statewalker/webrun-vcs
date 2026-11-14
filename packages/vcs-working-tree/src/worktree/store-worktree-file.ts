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

/** What `storeWorktreeFile` stored, and the stat to record for it in the index. */
export interface StoredWorktreeFile {
  /** The blob id. */
  id: ObjectId;
  /**
   * The stat that matched the stored content: the entry given, or the fresh
   * stat of a retry. When the content was stored without a size, the latest
   * stat with `size` set to the stored blob's size.
   */
  entry: WorktreeEntry;
}

/**
 * A regular file is stored with the size the worktree reported, so the blob is
 * written in one pass without holding the file in memory. If the file changed
 * while it was read (`SizeMismatchError`), it is stat'ed again and stored once
 * more with its new size, as git retries a file that changed during `git add`.
 * If that read disagrees too, or for symlinks and anything else, the content is
 * stored without a size (spooled when it is large; see `Blobs.store`).
 *
 * Returns the id together with the stat that matched it, which is what the
 * index must record (not the first stat, after a retry).
 *
 * @example
 * ```typescript
 * const entry = await worktree.getEntry("big.bin");
 * if (entry) {
 *   const stored = await storeWorktreeFile(history.blobs, worktree, "big.bin", entry);
 *   // stored.id, stored.entry.size, stored.entry.mtime
 * }
 * ```
 */
export async function storeWorktreeFile(
  blobs: Blobs,
  worktree: Worktree,
  path: string,
  entry: WorktreeEntry,
): Promise<StoredWorktreeFile> {
  let latest = entry;
  if (isRegularFile(entry)) {
    try {
      return { id: await blobs.store(worktree.readContent(path), entry.size), entry };
    } catch (e) {
      if (!isSizeMismatch(e)) throw e;
    }
    const fresh = await worktree.getEntry(path);
    if (fresh) latest = fresh;
    if (fresh && isRegularFile(fresh)) {
      try {
        return { id: await blobs.store(worktree.readContent(path), fresh.size), entry: fresh };
      } catch (e) {
        if (!isSizeMismatch(e)) throw e;
      }
    }
    const id = await blobs.store(worktree.readContent(path));
    // no stat matched what was read: record the stored size, so the index never
    // claims a size the blob does not have
    const size = await blobs.size(id);
    return { id, entry: size >= 0 ? { ...latest, size } : latest };
  }
  return { id: await blobs.store(worktree.readContent(path)), entry };
}
