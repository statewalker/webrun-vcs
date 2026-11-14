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

/**
 * Reads a pointer file; `undefined` when `text` is not a v1 SHA-256 pointer.
 *
 * It follows the git-lfs pointer spec: one `key value` line each, `version`
 * first, the other keys after it in strictly ascending (alphabetical) order, so
 * extension keys (`ext-0-…`) come before `oid`, and `oid` before `size`. The
 * oid must be `sha256:` and 64 lowercase hex digits, the size a decimal safe
 * integer. Only the final newline may be missing.
 *
 * @example
 * ```typescript
 * parseLfsPointer(`${LFS_POINTER_VERSION}\noid sha256:${oid}\nsize 12\n`); // { oid, size: 12 }
 * parseLfsPointer(`${LFS_POINTER_VERSION}\nsize 12\noid sha256:${oid}\n`); // undefined: out of order
 * ```
 */
export function parseLfsPointer(text: string): LfsPointer | undefined {
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  if (lines[0] !== LFS_POINTER_VERSION) return undefined;
  const values = new Map<string, string>();
  let previous = "";
  for (const line of lines.slice(1)) {
    const space = line.indexOf(" ");
    if (space <= 0) return undefined;
    const key = line.slice(0, space);
    if (!/^[a-z0-9.-]+$/.test(key) || key <= previous) return undefined;
    values.set(key, line.slice(space + 1));
    previous = key;
  }
  const oid = values.get("oid")?.match(/^sha256:([0-9a-f]{64})$/);
  const sizeText = values.get("size");
  if (!oid || sizeText === undefined || !/^\d+$/.test(sizeText)) return undefined;
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size)) return undefined;
  return { oid: oid[1], size };
}
