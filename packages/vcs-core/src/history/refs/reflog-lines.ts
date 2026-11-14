/**
 * A `ReflogReader` over reflog lines kept in memory (or loaded from a store).
 */
import { parsePersonIdent } from "../format/person-ident.js";
import type { ReflogLine } from "./ref-batch.js";
import type { ReflogEntry, ReflogReader } from "./reflog-types.js";

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
