/**
 * Reading objects through the object kernel the way the transport adapters need
 * them: a header, or a whole (small) object as one buffer.
 */
import type { GitObjects, ObjectId, ObjectTypeString } from "@statewalker/vcs-core";

/** The object's type and size, or null if absent (only the header is inflated). */
export async function headerOf(
  objects: GitObjects,
  id: ObjectId,
): Promise<{ type: ObjectTypeString; size: number } | null> {
  const obj = await objects.get(id);
  if (!obj) return null;
  await obj.content[Symbol.asyncIterator]().return?.();
  return { type: obj.type, size: obj.size };
}

/** The object's header and whole content; throws if it is absent. */
export async function loadObject(
  objects: GitObjects,
  id: ObjectId,
): Promise<{ header: { type: ObjectTypeString; size: number }; content: Uint8Array }> {
  const obj = await objects.get(id);
  if (!obj) throw new Error(`Object not found: ${id}`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of obj.content) {
    chunks.push(chunk);
    length += chunk.length;
  }
  const content = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.length;
  }
  return { header: { type: obj.type, size: obj.size }, content };
}
