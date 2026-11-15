/**
 * Receiving a pack, as git's fetch-pack and receive-pack do: a pack of at least
 * `transfer.unpackLimit` objects is kept as a pack (`index-pack --fix-thin`), a smaller one is
 * exploded into loose objects (`unpack-objects`). The decision reads only the pack header; the
 * stream is never buffered.
 */
import type { ObjectId } from "../common/id/index.js";
import type { GitObjects, ObjectQuarantine } from "../history/objects/git-objects.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";
import type { InstalledPack, InstallPackOptions } from "./index-pack.js";
import { PackError } from "./index-pack.js";
import {
  type UnpackObjectsOptions,
  type UnpackResult,
  type UnpackTarget,
  unpackObjects,
} from "./unpack-objects.js";

/** git's `transfer.unpackLimit` default. */
export const DEFAULT_UNPACK_LIMIT = 100;

export interface ImportPackOptions extends UnpackObjectsOptions {
  /**
   * Where packs are kept (a `PackSet`, as the files backend has). Without it every pack is
   * unpacked, as the memory, KV and SQL stores do.
   */
  packs?: {
    install(
      source: AsyncIterable<Uint8Array>,
      options?: InstallPackOptions,
    ): Promise<InstalledPack>;
  };
  /** Packs with at least this many objects are kept as packs (git's `transfer.unpackLimit`). Default 100. */
  unpackLimit?: number;
  /**
   * Import into a quarantine (git's receive-pack `tmp_objdir`) when `objects` can open one
   * (`GitObjects.beginQuarantine`): the objects stay invisible to readers of `objects` until
   * `result.quarantine.commit()`, and `result.quarantine.discard()` removes them. A kept pack
   * goes to the quarantine's `packs` (not `options.packs`). A failed import discards the
   * quarantine itself. Objects that cannot quarantine are imported directly, and the result
   * has no `quarantine`: the caller sees that the objects are already published.
   */
  quarantine?: boolean;
}

export interface ImportPackResult {
  /** objects in the pack (for a kept thin pack, the received ones and the appended bases) */
  count: number;
  /** objects per type */
  types: Record<ObjectTypeString, number>;
  /** the pack as installed, when it was kept */
  kept?: InstalledPack;
  /** what was unpacked, when it was not kept */
  unpacked?: UnpackResult;
  /**
   * The quarantine holding the objects, with `quarantine: true` on objects that can open one:
   * the caller must `commit()` or `discard()` it.
   */
  quarantine?: ObjectQuarantine;
  /**
   * With `quarantine: true`: whether the objects were quarantined (true, `quarantine` set) or,
   * `objects` being unable to, imported straight into the store (false). Absent otherwise.
   */
  quarantined?: boolean;
}

/** What `importPack` writes to: the unpack target, and a quarantine when it can open one. */
export type ImportTarget = UnpackTarget & Partial<Pick<GitObjects, "beginQuarantine">>;

/**
 * Imports a received pack into `objects`: kept as a pack through `options.packs` when it has at
 * least `unpackLimit` objects (thin packs completed from `objects`), otherwise unpacked into loose
 * objects. A corrupt pack is refused with `PackError`. An empty stream (no pack, as after a push
 * that only deletes refs) imports nothing.
 *
 * @example
 * ```typescript
 * const { objects, packs } = await createGitFilesBackend({ files });
 * const result = await importPack(objects, packStream, { packs });
 * // result.kept for 100 objects or more, result.unpacked below
 *
 * // receive-pack: kept aside until the push is accepted
 * const pushed = await importPack(objects, packStream, { packs, quarantine: true });
 * await connectivityCheck(pushed.quarantine?.objects ?? objects);
 * await pushed.quarantine?.commit(); // or discard() when the push is refused
 * ```
 */
export async function importPack(
  objects: ImportTarget,
  pack: AsyncIterable<Uint8Array>,
  options: ImportPackOptions = {},
): Promise<ImportPackResult> {
  if (options.quarantine && objects.beginQuarantine) {
    const quarantine = await objects.beginQuarantine();
    try {
      const result = await importPack(quarantine.objects, pack, {
        ...options,
        quarantine: false,
        packs: quarantine.packs,
      });
      return { ...result, quarantine, quarantined: true };
    } catch (err) {
      await quarantine.discard().catch(() => {});
      throw err;
    }
  }
  if (options.quarantine) {
    // asked for, but these objects cannot keep a quarantine: said in the result
    const result = await importPack(objects, pack, { ...options, quarantine: false });
    return { ...result, quarantined: false };
  }
  const unpackLimit = options.unpackLimit ?? DEFAULT_UNPACK_LIMIT;
  const maxObjectSize = options.maxObjectSize ?? 2 ** 30;
  const it = pack[Symbol.asyncIterator]();
  const head: Uint8Array[] = [];
  let seen = 0;
  while (seen < 12) {
    const r = await it.next();
    if (r.done) break;
    head.push(r.value);
    seen += r.value.length;
  }
  if (seen === 0) return { count: 0, types: { commit: 0, tree: 0, blob: 0, tag: 0 } };
  // The importer ends this stream early on a corrupt pack: pass that on to the source, so a
  // response body behind it is released.
  const stream = (async function* () {
    try {
      yield* head;
      head.length = 0;
      for (let r = await it.next(); !r.done; r = await it.next()) yield r.value;
    } finally {
      // a source whose cleanup fails must not hide the import's own error
      await it.return?.()?.catch?.(() => {});
    }
  })();
  const count = seen >= 12 ? headerCount(head) : 0;
  try {
    return await importStream(objects, stream, count, unpackLimit, maxObjectSize, options);
  } catch (err) {
    await stream.return(undefined); // also when the importer failed before reading it
    throw err;
  }
}

async function importStream(
  objects: UnpackTarget,
  stream: AsyncGenerator<Uint8Array>,
  count: number,
  unpackLimit: number,
  maxObjectSize: number,
  options: ImportPackOptions,
): Promise<ImportPackResult> {
  if (options.packs && count >= unpackLimit) {
    const externalBase = async (id: ObjectId) => {
      const obj = await objects.get(id);
      if (!obj) return undefined;
      if (obj.size > maxObjectSize) {
        await obj.content[Symbol.asyncIterator]().return?.();
        throw new PackError(`base ${id} is larger than the limit of ${maxObjectSize}`);
      }
      const data = new Uint8Array(obj.size);
      let o = 0;
      for await (const c of obj.content) {
        data.set(c, o);
        o += c.length;
      }
      return { type: obj.type, data };
    };
    const kept = await options.packs.install(stream, {
      externalBase,
      maxObjectSize,
      baseCacheBytes: options.baseCacheBytes,
    });
    return { count: kept.count, types: kept.types, kept };
  }
  const unpacked = await unpackObjects(objects, stream, options);
  return { count: unpacked.count, types: unpacked.types, unpacked };
}

/** The object count of a pack header split over `chunks` (at least 12 bytes in all). */
function headerCount(chunks: Uint8Array[]): number {
  const b = new Uint8Array(12);
  let o = 0;
  for (const c of chunks) {
    const k = Math.min(12 - o, c.length);
    b.set(c.subarray(0, k), o);
    o += k;
    if (o === 12) break;
  }
  if (String.fromCharCode(...b.subarray(0, 4)) !== "PACK") return 0; // refused by the unpacker
  return new DataView(b.buffer).getUint32(8);
}
