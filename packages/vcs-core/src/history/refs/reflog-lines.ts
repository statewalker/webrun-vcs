/**
 * A `ReflogReader` over reflog lines kept in memory (or loaded from a store).
 */
import { parsePersonIdent } from "../format/person-ident.js";
import type { ReflogLine } from "./ref-batch.js";
import type { ReflogEntry, ReflogReader } from "./reflog-types.js";

const ZERO_ID = "0".repeat(40);

/** Options of `Refs.deleteReflogEntry`, as the flags of `git reflog delete`. */
export interface ReflogDeleteOptions {
  /**
   * `--rewrite`: each kept entry's old id becomes the new id of the kept entry before
   * it (the oldest kept one gets the zero id), so the log stays a chain.
   */
  rewrite?: boolean;
  /**
   * `--updateref`: set the ref to the new id of the newest kept entry (left alone when
   * no entry is kept or the ref is symbolic).
   */
  updateRef?: boolean;
}

/** Thrown when `name@{index}` names no reflog entry. */
export class ReflogEntryNotFoundError extends Error {
  readonly code = "ENOENT";
  constructor(
    readonly refName: string,
    readonly index: number,
  ) {
    super(`reflog entry ${refName}@{${index}} does not exist`);
    this.name = "ReflogEntryNotFoundError";
  }
}

/**
 * The lines left once entry `index` (0 = newest, as `name@{0}`) is deleted from
 * `lines` (oldest first), as `git reflog delete` writes them; undefined when there is
 * no such entry. `rewrite` relinks the old ids (see `ReflogDeleteOptions.rewrite`).
 *
 * @example
 * ```typescript
 * const kept = deleteReflogLine(lines, 1, true); // drop stash@{1}, keep the chain
 * ```
 */
export function deleteReflogLine<L extends { oldId: string; newId: string }>(
  lines: readonly L[],
  index: number,
  rewrite = false,
): L[] | undefined {
  const at = lines.length - 1 - index;
  if (!Number.isInteger(index) || index < 0 || at < 0) return undefined;
  const kept = lines.filter((_, i) => i !== at);
  if (!rewrite) return kept;
  let previous = ZERO_ID;
  return kept.map((line) => {
    const out = { ...line, oldId: previous };
    previous = line.newId;
    return out;
  });
}

/** The reflog entry for a line. */
export function reflogEntryOf(line: ReflogLine): ReflogEntry {
  return {
    oldId: line.oldId,
    newId: line.newId,
    who: parsePersonIdent(line.ident),
    comment: line.message,
  };
}

/**
 * A reader over `lines`, oldest first (newest entries are read first, as git's
 * `reflog show` lists them).
 */
export function createReflogReaderOf(lines: ReflogLine[]): ReflogReader {
  const newestFirst = () => [...lines].reverse().map(reflogEntryOf);
  return {
    async getLastEntry() {
      return newestFirst()[0];
    },
    async getReverseEntries(max = Number.MAX_SAFE_INTEGER) {
      return newestFirst().slice(0, max);
    },
    async getReverseEntry(index) {
      return newestFirst()[index];
    },
  };
}
