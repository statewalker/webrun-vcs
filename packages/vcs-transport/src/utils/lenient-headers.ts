/**
 * The links of a commit or tag read as git's object parser reads them (`parse_commit_buffer`,
 * `parse_tag_buffer`): only the lines the history walk needs. git walks (and fetches, and
 * checks the connectivity of) commits whose author or committer line fsck would refuse; the
 * typed stores refuse to parse such a commit, so the walks fall back to these.
 *
 * @example
 * ```ts
 * const info = lenientCommitHeader(content); // { tree, parents, time } or undefined
 * ```
 */

import type {
  CommitGraphInfo,
  GitObjectTypeName,
  TagTargetInfo,
} from "../api/repository-facade.js";

const decoder = new TextDecoder();
const HEX40 = /^[0-9a-f]{40}$/;

/** The header lines of an object, up to the first empty line. */
function headerLines(content: Uint8Array): string[] {
  let end = content.length;
  for (let i = 0; i + 1 < content.length; i++) {
    if (content[i] === 0x0a && content[i + 1] === 0x0a) {
      end = i;
      break;
    }
  }
  return decoder.decode(content.subarray(0, end)).split("\n");
}

/**
 * A commit's tree, parents and committer time, as git's `parse_commit_buffer` reads them: a
 * `tree` line first, then `parent` lines; the time is the number after the committer line's
 * last `>` (0 when there is none, as `parse_commit_date`). Undefined without a valid tree line.
 */
export function lenientCommitHeader(content: Uint8Array): CommitGraphInfo | undefined {
  const lines = headerLines(content);
  const first = lines[0] ?? "";
  if (!first.startsWith("tree ") || !HEX40.test(first.slice(5))) return undefined;
  const parents: string[] = [];
  let i = 1;
  for (; i < lines.length && (lines[i] as string).startsWith("parent "); i++) {
    const id = (lines[i] as string).slice(7);
    if (!HEX40.test(id)) return undefined;
    parents.push(id);
  }
  let time = 0;
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.startsWith("committer ")) continue;
    const gt = line.lastIndexOf(">");
    const m = gt >= 0 ? /^\s*(\d+)/.exec(line.slice(gt + 1)) : null;
    time = m ? Number(m[1]) : 0;
    break;
  }
  return { tree: first.slice(5), parents, time };
}

/** What a tag points at, as git's `parse_tag_buffer` reads it (`object` then `type` lines). */
export function lenientTagTarget(content: Uint8Array): TagTargetInfo | undefined {
  const lines = headerLines(content);
  const object = lines[0] ?? "";
  const type = lines[1] ?? "";
  if (!object.startsWith("object ") || !HEX40.test(object.slice(7))) return undefined;
  if (!type.startsWith("type ")) return undefined;
  const name = type.slice(5);
  if (name !== "commit" && name !== "tree" && name !== "blob" && name !== "tag") return undefined;
  return { object: object.slice(7), type: name as GitObjectTypeName };
}

/** The part of an object store {@link storedObjectType} reads. */
export interface ObjectHeaderSource {
  get(
    oid: string,
  ): Promise<{ type: string; content: AsyncIterable<Uint8Array> } | undefined | null>;
}

/**
 * An object's type from its header, the content released unread; undefined when the object is
 * absent or cannot be read. The lenient readers ask it first, so an object that simply is not a
 * commit (or a tag) is never read whole.
 */
export async function storedObjectType(
  objects: ObjectHeaderSource | undefined,
  oid: string,
): Promise<string | undefined> {
  if (!objects) return undefined;
  try {
    const object = await objects.get(oid);
    if (!object) return undefined;
    await object.content[Symbol.asyncIterator]().return?.();
    return object.type;
  } catch {
    return undefined;
  }
}
