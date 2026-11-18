/**
 * Abbreviated object ids as git prints them (`repo_find_unique_abbrev`): long enough for the
 * repository's size, and longer where a shorter prefix would name another object too.
 *
 * @example
 * ```typescript
 * const lengths = await findAbbrevLengths(history.objects, [id1, id2]);
 * id1.slice(0, lengths.get(id1)); // "1a2b3c4", or longer in a big repository
 * ```
 *
 * The length starts at `minLength`, or, for "auto" (git's default, `core.abbrev=auto`), at
 * half the bits of the approximate object count in hex digits, at least 7 (git's
 * `odb_find_abbrev_len`: 7 up to 16383 objects, 8 from 16384, 9 from 65536, 10 from
 * 262144, ...). Each id is then lengthened until no other stored object shares its prefix
 * (it need not be stored itself: a worktree file's id, the null id). Stores with a prefix
 * lookup (`GitObjects.listPrefix`) are asked for the ids sharing the start length only; the
 * others are listed whole.
 *
 * `listObjectsWithPrefix` finds the stored ids an abbreviation names (git's
 * `repo_for_each_abbrev`), as the revision resolver does for `git rev-parse 1a2b`.
 *
 * @module
 */

import type { ObjectId } from "../../common/id/index.js";
import type { GitObjects, ListPrefixOptions } from "./git-objects.js";

/** git's `FALLBACK_DEFAULT_ABBREV` */
export const DEFAULT_ABBREV_LENGTH = 7;
const HEX_LENGTH = 40;

/** `msb(count) + 1` halved and rounded up, at least 7: the "auto" length for `count` objects */
export function autoAbbrevLength(count: number): number {
  let msb = 0;
  for (let v = Math.max(0, Math.floor(count)); v > 1; v = Math.floor(v / 2)) msb++;
  const len = Math.ceil((msb + 1) / 2);
  return Math.max(DEFAULT_ABBREV_LENGTH, len);
}

/**
 * `core.abbrev` as git reads it: unset and "auto" give -1 (the automatic length), a false
 * boolean ("false", "no", "off") the full length, a number from 4 up that number; anything
 * else (git refuses it) undefined.
 */
export function parseCoreAbbrev(value: string | undefined): number | undefined {
  if (value === undefined) return -1;
  const v = value.trim().toLowerCase();
  if (v === "auto") return -1;
  if (v === "false" || v === "no" || v === "off" || v === "") return HEX_LENGTH;
  if (!/^-?\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n >= 4 ? Math.min(n, HEX_LENGTH) : undefined;
}

/** git's `MINIMUM_ABBREV`: an abbreviated id has at least 4 hex digits. */
export const MINIMUM_ABBREV_LENGTH = 4;

/**
 * The stored ids that start with `prefix` (lowercase hex), each once: through
 * `objects.listPrefix` where the store has it, else by filtering `objects.list()`.
 *
 * @example
 * ```typescript
 * for await (const id of listObjectsWithPrefix(history.objects, "1a2b")) console.log(id);
 * ```
 */
export async function* listObjectsWithPrefix(
  objects: Pick<GitObjects, "list" | "listPrefix">,
  prefix: string,
  options?: ListPrefixOptions,
): AsyncIterable<ObjectId> {
  const seen = new Set<ObjectId>();
  const source = objects.listPrefix ? objects.listPrefix(prefix, options) : objects.list();
  for await (const id of source) {
    if (!id.startsWith(prefix) || seen.has(id)) continue;
    seen.add(id);
    yield id;
  }
}

function commonHexPrefix(a: string, b: string): number {
  let i = 0;
  while (i < HEX_LENGTH && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * The abbreviated length of each id (`repo_find_unique_abbrev`), from `minLength` (-1, the
 * default, for git's automatic length; 0 or 40 and more for full ids). `options.cache` is
 * handed to the store's prefix lookups (see `GitObjects.listPrefix`).
 */
export async function findAbbrevLengths(
  objects: GitObjects,
  ids: Iterable<ObjectId>,
  minLength = -1,
  options?: ListPrefixOptions,
): Promise<Map<ObjectId, number>> {
  const wanted = [...new Set(ids)];
  const out = new Map<ObjectId, number>();
  if (wanted.length === 0) return out;
  let start = minLength;
  if (start < 0) {
    let count = 0;
    if (objects.approximateCount) count = await objects.approximateCount();
    else for await (const _ of objects.list()) count++;
    start = autoAbbrevLength(count);
  }
  if (start === 0 || start >= HEX_LENGTH) {
    for (const id of wanted) out.set(id, HEX_LENGTH);
    return out;
  }
  if (objects.listPrefix) {
    // every stored id sharing `start` digits with an id is under that prefix
    const byPrefix = new Map<string, ObjectId[]>();
    for (const id of wanted) {
      const prefix = id.slice(0, start);
      let near = byPrefix.get(prefix);
      if (!near) {
        near = [];
        for await (const other of listObjectsWithPrefix(objects, prefix, options)) {
          near.push(other);
        }
        byPrefix.set(prefix, near);
      }
      let len = start;
      for (const other of near) {
        if (other === id) continue;
        const common = commonHexPrefix(id, other);
        if (common !== HEX_LENGTH && common >= len) len = common + 1;
      }
      out.set(id, Math.min(len, HEX_LENGTH));
    }
    return out;
  }
  const all: string[] = [];
  for await (const id of objects.list()) all.push(id);
  all.sort();
  for (const id of wanted) {
    // the stored neighbours in sorted order share the longest prefixes with id
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (all[mid] < id) lo = mid + 1;
      else hi = mid;
    }
    let len = start;
    const extend = (other: string | undefined) => {
      if (other === undefined || other === id) return;
      const common = commonHexPrefix(id, other);
      if (common !== HEX_LENGTH && common >= len) len = common + 1;
    };
    extend(all[lo - 1]);
    let after = lo;
    while (all[after] === id) after++;
    extend(all[after]);
    out.set(id, Math.min(len, HEX_LENGTH));
  }
  return out;
}
