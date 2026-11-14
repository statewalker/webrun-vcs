/**
 * Hash a worktree file as a git blob while it streams past, without holding it
 * in memory.
 */
import type { ObjectId } from "@statewalker/vcs-core";
import { createSha1, type Hasher } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { computeObjectIdFromStream } from "@statewalker/vcs-utils/pack";

/** Makes a fresh incremental hasher; the worktrees default to SHA-1 (`createSha1`). */
export type NewHasher = () => Hasher;

/** Where `hashWorktreeFile` reads a file from. */
export interface WorktreeFileSource {
  /** The file's current size in bytes (from stat), or `undefined` when it is gone. */
  size(): Promise<number | undefined>;
  /** The file's content, in chunks. */
  read(): AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

const isSizeMismatch = (e: unknown) => (e as Error)?.name === "SizeMismatchError";

/**
 * The id `hashWorktreeFile` returns for a file whose size kept changing while it
 * was read: all zeros, as long as the hasher's digest. No blob has it, so a
 * caller comparing it with the index sees the file as modified.
 */
export function unknownContentId(newHasher: NewHasher = createSha1): ObjectId {
  return bytesToHex(new Uint8Array(newHasher().digest().length));
}

/**
 * Compute the blob id of a worktree file in one streaming pass.
 *
 * The git header carries the size, so it comes from stat first. If the file
 * produces a different number of bytes (it changed while it was read), it is
 * stat'ed and read once more; if that disagrees too, the file is reported as
 * modified with {@link unknownContentId}, as `storeWorktreeFile` falls back for
 * a file that will not hold still.
 *
 * @example
 * ```typescript
 * const id = await hashWorktreeFile("big.bin", {
 *   size: async () => {
 *     const stats = await files.stats("/repo/big.bin");
 *     return stats?.kind === "file" ? stats.size : undefined;
 *   },
 *   read: () => files.read("/repo/big.bin"),
 * });
 * ```
 */
export async function hashWorktreeFile(
  path: string,
  source: WorktreeFileSource,
  newHasher: NewHasher = createSha1,
): Promise<ObjectId> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const size = await source.size();
    if (size === undefined) throw new Error(`File not found: ${path}`);
    try {
      return await computeObjectIdFromStream("blob", size, source.read(), newHasher);
    } catch (e) {
      if (!isSizeMismatch(e)) throw e;
    }
  }
  return unknownContentId(newHasher);
}
