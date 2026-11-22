/**
 * How the typed stores (blobs, trees, commits, tags) use `GitObjects`:
 * store content of unknown size, read a header, load content of one type.
 */
import type { ObjectId } from "../../common/id/index.js";
import { CorruptObjectError, type GitObjects, InvalidObjectIdError } from "./git-objects.js";
import { PromisorFetchError } from "./object-promisor.js";
import type { ObjectTypeString } from "./object-types.js";

/**
 * Store content whose size is not known up front (see `GitObjects.putUnsized`:
 * small content stays in memory, longer content is spooled to the store's
 * temporary storage). Callers that know the size use `put` directly.
 */
export function storeObject(
  objects: GitObjects,
  type: ObjectTypeString,
  content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<ObjectId> {
  return objects.putUnsized(type, content);
}

/**
 * The object's type and size, or undefined if it is absent. The read is released at once
 * (`return()` on the content before iterating it). What is read before that depends on the
 * store: a loose object's header; for a packed object, the entry headers (`GitObjects.header`,
 * without applying a delta chain), else the first chunk of a whole object or the resolved
 * result of a delta.
 */
export async function objectHeader(
  objects: GitObjects,
  id: ObjectId,
): Promise<{ type: ObjectTypeString; size: number } | undefined> {
  if (objects.header) {
    const h = await objects.header(id);
    if (h) return h;
  }
  const obj = await objects.get(id);
  if (!obj) return undefined;
  await obj.content[Symbol.asyncIterator]().return?.();
  return { type: obj.type, size: obj.size };
}

/**
 * Whether the stored object `id` has `type`: false if it is absent or of another type. An
 * object that is stored but whose header cannot be read throws `CorruptObjectError` instead
 * of reading as absent, so a reachability walk (gc) never skips what lies behind it.
 */
export async function hasObjectOfType(
  objects: GitObjects,
  id: ObjectId,
  type: ObjectTypeString,
): Promise<boolean> {
  if (!(await objects.has(id))) return false;
  // the type from a packed copy's headers alone, when the store can read them
  const known = objects.objectType ? await objects.objectType(id) : undefined;
  if (known) return known === type;
  let header: Awaited<ReturnType<typeof objectHeader>>;
  try {
    header = await objectHeader(objects, id);
  } catch (e) {
    if (
      e instanceof CorruptObjectError ||
      e instanceof InvalidObjectIdError ||
      e instanceof PromisorFetchError
    ) {
      throw e;
    }
    const reason = e instanceof Error ? `: ${e.message}` : "";
    throw new CorruptObjectError(`object ${id} is stored but cannot be read${reason}`, {
      cause: e,
    });
  }
  return header?.type === type;
}

/**
 * The content of an object that must have `type`. Throws if it is absent or of
 * another type. `release()` gives up a read the caller does not finish.
 */
export async function loadTypedObject(
  objects: GitObjects,
  id: ObjectId,
  type: ObjectTypeString,
): Promise<{ content: AsyncIterable<Uint8Array>; size: number; release(): Promise<void> }> {
  const obj = await objects.get(id);
  if (!obj) throw new Error(`Object not found: ${id}`);
  const it = obj.content[Symbol.asyncIterator]();
  const release = async () => {
    await it.return?.();
  };
  if (obj.type !== type) {
    await release();
    throw new Error(`Object ${id} is not a ${type} (found type: ${obj.type})`);
  }
  return { content: { [Symbol.asyncIterator]: () => it }, size: obj.size, release };
}

/** Remove an object; false if it is absent or `id` is not an object id. */
export async function removeObject(objects: GitObjects, id: ObjectId): Promise<boolean> {
  try {
    return await objects.remove(id);
  } catch (e) {
    if (e instanceof InvalidObjectIdError) return false;
    throw e;
  }
}
