/**
 * How the typed stores (blobs, trees, commits, tags) use `GitObjects`:
 * store content of unknown size, read a header, load content of one type.
 */
import type { ObjectId } from "../../common/id/index.js";
import { type GitObjects, InvalidObjectIdError } from "./git-objects.js";
import type { ObjectTypeString } from "./object-types.js";

/**
 * Store content whose size is not known up front: the chunks are collected,
 * then put with their total size. Callers that know the size use `put` directly.
 */
export async function storeObject(
  objects: GitObjects,
  type: ObjectTypeString,
  content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<ObjectId> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of content) {
    chunks.push(chunk);
    size += chunk.length;
  }
  return objects.put(type, size, chunks);
}

/**
 * The object's type and size, or undefined if it is absent. The read is released at once
 * (`return()` on the content before iterating it). What is read before that depends on the
 * store: a loose object's header; for a packed object, the first chunk of a whole object, or
 * the resolved result of a delta.
 */
export async function objectHeader(
  objects: GitObjects,
  id: ObjectId,
): Promise<{ type: ObjectTypeString; size: number } | undefined> {
  const obj = await objects.get(id);
  if (!obj) return undefined;
  await obj.content[Symbol.asyncIterator]().return?.();
  return { type: obj.type, size: obj.size };
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
