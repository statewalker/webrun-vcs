/**
 * Store a worktree file as a blob, in one pass when its size is known.
 */
import type { Blobs, ObjectId } from "@statewalker/vcs-core";
import type { Worktree, WorktreeEntry } from "@statewalker/vcs-working-tree";

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

/**
 * A regular file is stored with the size the worktree reported, so the blob is
 * written in one pass without holding the file in memory. If the file changed
 * while it was read (`SizeMismatchError`), what it holds now is stored instead.
 * Symlinks and anything else are collected first.
 */
export async function storeWorktreeFile(
  blobs: Blobs,
  worktree: Worktree,
  path: string,
  entry: WorktreeEntry,
): Promise<ObjectId> {
  if (!entry.isDirectory && (entry.mode & S_IFMT) === S_IFREG) {
    try {
      return await blobs.store(worktree.readContent(path), entry.size);
    } catch (e) {
      if ((e as Error)?.name !== "SizeMismatchError") throw e;
    }
  }
  return blobs.store(worktree.readContent(path));
}
