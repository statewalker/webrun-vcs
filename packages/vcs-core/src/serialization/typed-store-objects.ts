/**
 * The object-kernel calls `importPack` needs, over typed stores that keep parsed objects (the
 * SQL native stores). Such stores re-encode what they store, so an object whose bytes they would
 * change is refused with `ObjectIdMismatchError` instead of being stored under another id.
 */
import type { ObjectId } from "../common/id/index.js";
import { CorruptObjectError, ObjectIdMismatchError } from "../history/objects/git-objects.js";
import type { ObjectTypeString } from "../history/objects/object-types.js";
import type { UnpackTarget } from "../pack/index.js";

export interface TypedStoreAccess {
  has(id: ObjectId): Promise<boolean>;
  exportObject(
    id: ObjectId,
  ): Promise<{ type: ObjectTypeString; content: AsyncIterable<Uint8Array> }>;
  importObject(type: ObjectTypeString, content: Iterable<Uint8Array>): Promise<ObjectId>;
}

const TYPES = new Set(["blob", "tree", "commit", "tag"]);
const enc = new TextEncoder();

async function collect(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of chunks) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * @example
 * ```typescript
 * const objects = typedStoreObjects({ has, exportObject, importObject });
 * await importPack(objects, packStream);
 * ```
 */
export function typedStoreObjects(access: TypedStoreAccess): UnpackTarget {
  const load = async (id: ObjectId) => {
    if (!(await access.has(id))) return undefined;
    const { type, content } = await access.exportObject(id);
    return { type, data: await collect(content) };
  };
  const store = async (type: ObjectTypeString, data: Uint8Array) =>
    access.importObject(type, [data]);
  return {
    has: (id) => access.has(id),
    async get(id) {
      const obj = await load(id);
      if (!obj) return undefined;
      const { type, data } = obj;
      return {
        type,
        size: data.length,
        content: (async function* () {
          yield data;
        })(),
      };
    },
    getRaw(id) {
      return (async function* () {
        const obj = await load(id);
        if (!obj) return;
        yield enc.encode(`${obj.type} ${obj.data.length}\0`);
        yield obj.data;
      })();
    },
    async put(type, size, content) {
      const data = await collect(content);
      if (data.length !== size)
        throw new CorruptObjectError(`object is ${data.length} bytes, ${size} declared`);
      return store(type, data);
    },
    async putRaw(id, raw) {
      const bytes = await collect(raw);
      const nul = bytes.indexOf(0);
      const head = nul > 0 ? String.fromCharCode(...bytes.subarray(0, nul)) : "";
      const m = /^([a-z]+) (\d+)$/.exec(head);
      if (!m || !TYPES.has(m[1] as string) || Number(m[2]) !== bytes.length - nul - 1)
        throw new CorruptObjectError(`bad object header "${head}"`);
      const stored = await store(m[1] as ObjectTypeString, bytes.subarray(nul + 1));
      if (stored !== id)
        throw new ObjectIdMismatchError(
          `object ${id} cannot be stored byte for byte by these stores (stored as ${stored})`,
        );
    },
  };
}
