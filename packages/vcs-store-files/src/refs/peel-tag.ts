import type { GitObjects, ObjectId } from "@statewalker/vcs-core";

/**
 * What an annotated tag peels to, following a chain of tags (git's `peel_object`): undefined
 * when `id` is not a tag or a tag on the way is missing or malformed (the object a tag names
 * as no tag is not read: it may be missing).
 */
export async function peelTag(objects: GitObjects, id: ObjectId): Promise<ObjectId | undefined> {
  let current = id;
  for (let depth = 0; depth < 64; depth++) {
    const object = await objects.get(current);
    if (!object) return undefined;
    if (object.type !== "tag") {
      await object.content[Symbol.asyncIterator]().return?.();
      return current === id ? undefined : current;
    }
    let bytes = object.bytes;
    if (!bytes) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of object.content) chunks.push(chunk);
      bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    }
    const head = new TextDecoder().decode(bytes.subarray(0, 96));
    const m = /^object ([0-9a-f]{40}|[0-9a-f]{64})\ntype ([a-z]+)\n/.exec(head);
    if (!m) return undefined;
    current = m[1] as ObjectId;
    // git's deref_tag_noverify stops at the first object the tag names as no tag, without
    // reading it: a tag of a missing commit still peels to that commit's id
    if (m[2] !== "tag") return current;
  }
  return undefined;
}
