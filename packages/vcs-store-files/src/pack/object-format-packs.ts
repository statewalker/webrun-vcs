/**
 * Packs in a SHA-256 repository: the pack, `.idx`, `.rev`, `.mtimes`, multi-pack-index and
 * bitmap readers and writers hold 20-byte ids, so a SHA-256 repository with packs is refused
 * when it is opened, and every pack write into one is refused, with
 * `UnsupportedObjectFormatError` (rather than reading 32-byte ids as 20-byte ones). Loose
 * objects, refs and reflogs work in either format.
 */
import type { FilesApi, PackSet } from "@statewalker/vcs-core";
import { type ObjectFormat, UnsupportedObjectFormatError } from "@statewalker/vcs-utils/hash";

/** What a pack directory holds that only a SHA-1 reader reads today. */
const PACK_FILE = /\.(?:pack|idx)$|^multi-pack-index/;

/**
 * Throws `UnsupportedObjectFormatError` when `format` is not SHA-1 and `packDir` holds a pack,
 * an index of one or a multi-pack-index. A missing directory holds none.
 *
 * @example
 * ```typescript
 * await assertNoPacksInFormat(files, ".git/objects/pack", format.objectFormat);
 * ```
 */
export async function assertNoPacksInFormat(
  files: FilesApi,
  packDir: string,
  format: ObjectFormat,
): Promise<void> {
  if (format.name === "sha1") return;
  if ((await files.stats(packDir))?.kind !== "directory") return;
  for await (const entry of files.list(packDir)) {
    if (PACK_FILE.test(entry.name)) {
      throw new UnsupportedObjectFormatError("pack files", format.name);
    }
  }
}

/**
 * `packs` with its writes (`install`, `writePromisor`) refused in a repository whose format is
 * not SHA-1; the set itself as is in a SHA-1 one.
 */
export function refusePackWritesInFormat(packs: PackSet, format: ObjectFormat): PackSet {
  if (format.name === "sha1") return packs;
  const refuse = (): never => {
    throw new UnsupportedObjectFormatError("pack files", format.name);
  };
  packs.install = async () => refuse();
  if (packs.writePromisor) packs.writePromisor = async () => refuse();
  return packs;
}
