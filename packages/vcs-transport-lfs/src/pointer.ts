import type { ByteSource } from "./sha256.js";
import type { LfsPointer } from "./types.js";
import { hashing } from "./verify.js";

/** The first line of every Git LFS pointer file. */
export const LFS_POINTER_VERSION = "version https://git-lfs.github.com/spec/v1";

/**
 * The pointer of `content` (its SHA-256 oid and byte size), computed in one
 * streaming pass: what a clean filter needs to replace a large file with its
 * pointer, without holding the file in memory.
 *
 * @example
 * ```typescript
 * const pointer = await createLfsPointer(files.read(["model.bin"]));
 * const text = formatLfsPointer(pointer); // what git stores instead of the file
 * ```
 */
export async function createLfsPointer(content: ByteSource): Promise<LfsPointer> {
  const h = hashing(content);
  for await (const _chunk of h.stream) {
    // hashed and counted on the way through
  }
  return h.pointer();
}

/** The text of the pointer file for `pointer` (spec v1, keys in order, trailing newline). */
export function formatLfsPointer(pointer: LfsPointer): string {
  return `${LFS_POINTER_VERSION}\noid sha256:${pointer.oid}\nsize ${pointer.size}\n`;
}

/** Reads a pointer file; `undefined` when `text` is not a v1 SHA-256 pointer. */
export function parseLfsPointer(text: string): LfsPointer | undefined {
  if (!text.startsWith(`${LFS_POINTER_VERSION}\n`)) return undefined;
  const oid = text.match(/^oid sha256:([0-9a-f]{64})$/m);
  const size = text.match(/^size (\d+)$/m);
  if (!oid || !size) return undefined;
  return { oid: oid[1], size: Number(size[1]) };
}
