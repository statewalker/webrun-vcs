/**
 * Packs in a SHA-256 repository: the pack, `.idx`, `.rev` and `.mtimes` readers and writers
 * take the repository's object format (32-byte ids and SHA-256 checksums), but the
 * multi-pack-index reader still holds 20-byte ids, so a SHA-256 repository with a
 * multi-pack-index (or a chain of them) is refused when it is opened, with
 * `UnsupportedObjectFormatError` (rather than reading 32-byte ids as 20-byte ones). Its
 * bitmaps are not used (`PackSet.bitmap()` answers none), and nothing writes one.
 */
import type { FilesApi } from "@statewalker/vcs-core";
import { type ObjectFormat, UnsupportedObjectFormatError } from "@statewalker/vcs-utils/hash";

/** What a pack directory holds that only a SHA-1 reader reads today. */
const MIDX_FILE = /^multi-pack-index/;

/**
 * Throws `UnsupportedObjectFormatError` when `format` is not SHA-1 and `packDir` holds a
 * multi-pack-index (`multi-pack-index`, its `.d` chain). A missing directory holds none.
 *
 * @example
 * ```typescript
 * await assertNoMultiPackIndexInFormat(files, ".git/objects/pack", format.objectFormat);
 * ```
 */
export async function assertNoMultiPackIndexInFormat(
  files: FilesApi,
  packDir: string,
  format: ObjectFormat,
): Promise<void> {
  if (format.name === "sha1") return;
  if ((await files.stats(packDir))?.kind !== "directory") return;
  for await (const entry of files.list(packDir)) {
    if (MIDX_FILE.test(entry.name)) {
      throw new UnsupportedObjectFormatError("the multi-pack-index", format.name);
    }
  }
}
