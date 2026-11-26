/**
 * Loose writes that keep the compatibility map, as git's `odb_write_object_ext` and
 * `write_loose_object`: before an object not yet stored is written, its compatibility id is
 * computed (a blob hashed in the other format, a tree, commit or tag converted through the
 * map first) and, once the object is written, recorded in `loose-object-idx`. An object git
 * cannot convert (an id the map lacks) fails before anything is written, with git's lines
 * (`CompatObjectConversionError`); an object already stored (packed, loose, in an alternate)
 * is only freshened, and gets no line, as git's `odb_freshen_object` returns first.
 */

import type { GitObjects, ObjectTypeString } from "@statewalker/vcs-core";
import { bytesToHex, type ObjectFormat } from "@statewalker/vcs-utils/hash";

import type { LooseObjectMap } from "./loose-object-map.js";
import { convertObjectContent, latin1, objectIdOf } from "./object-convert.js";

export interface CompatWriteOptions {
  /** The map the written objects go to (and which converts their ids) */
  map: LooseObjectMap;
  /**
   * Whether the repository already has `id` (packs, loose objects, alternates): such a write
   * only freshens it, without a line in the map
   */
  has: (id: string) => Promise<boolean>;
}

async function collect(content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of content as AsyncIterable<Uint8Array>) {
    chunks.push(c.slice());
    n += c.length;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The compat id of an object of `type` held whole (a blob hashed as it is). */
async function compatIdOf(
  map: LooseObjectMap,
  type: ObjectTypeString,
  content: Uint8Array,
): Promise<string> {
  const converted = await convertObjectContent(type, content, map.storage, map.compat, (id) =>
    map.toCompat(id),
  );
  return objectIdOf(type, converted, map.compat);
}

/** `chunks` hashed in `format` as they pass, the header first (a streamed blob). */
function teeHash(
  format: ObjectFormat,
  header: Uint8Array | undefined,
  content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): { stream: AsyncIterable<Uint8Array>; digest: () => string } {
  const hasher = format.createHasher();
  if (header) hasher.update(header);
  async function* stream() {
    for await (const c of content as AsyncIterable<Uint8Array>) {
      hasher.update(c);
      yield c;
    }
  }
  return { stream: stream(), digest: () => bytesToHex(hasher.digest()) };
}

/**
 * `loose` (the loose object store of an objects directory) writing the compatibility id of
 * every new object to `options.map`.
 */
export function withCompatWrites(loose: GitObjects, options: CompatWriteOptions): GitObjects {
  const { map, has } = options;
  const storage = map.storage;

  async function putWhole(type: ObjectTypeString, content: Uint8Array): Promise<string> {
    const id = objectIdOf(type, content, storage);
    if (await has(id)) return loose.put(type, content.length, [content]);
    const compatId = await compatIdOf(map, type, content);
    const written = await loose.put(type, content.length, [content]);
    await map.add(written, compatId);
    return written;
  }

  return {
    ...loose,
    async put(type, size, content) {
      if (type !== "blob") return putWhole(type, await collect(content));
      // a blob is the same bytes in both formats: hashed in the other one as it is written
      const header = new TextEncoder().encode(`blob ${size}\0`);
      const tee = teeHash(map.compat, header, content);
      const id = await loose.put(type, size, tee.stream);
      await map.add(id, tee.digest());
      return id;
    },
    async putUnsized(type, content) {
      return putWhole(type, await collect(content));
    },
    async putRaw(id, raw) {
      if (await has(id)) return loose.putRaw(id, raw);
      const bytes = await collect(raw);
      const nul = bytes.indexOf(0);
      const header = nul < 0 ? "" : latin1(bytes.subarray(0, nul));
      const type = header.slice(0, header.indexOf(" ")) as ObjectTypeString;
      if (nul < 0 || !["blob", "tree", "commit", "tag"].includes(type)) {
        // malformed: the store refuses it with its own error
        return loose.putRaw(id, [bytes]);
      }
      const compatId = await compatIdOf(map, type, bytes.subarray(nul + 1));
      await loose.putRaw(id, [bytes]);
      await map.add(id, compatId);
    },
  };
}
