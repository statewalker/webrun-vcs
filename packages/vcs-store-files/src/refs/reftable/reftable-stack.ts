/**
 * A reftable stack (git's `reftable/stack.c`, `merged.c`): the directory `<git dir>/reftable`
 * whose `tables.list` names the tables oldest first, and the merged view of them.
 *
 * @example
 * ```typescript
 * const stack = createReftableStackReader(files, ".git/reftable");
 * const view = await stack.read();
 * view.refs.get("refs/heads/main"); // the newest table's record, deletions hiding older ones
 * view.logsOf("HEAD"); // newest first
 * ```
 *
 * The merged view follows git's merged iterator: for one key the newest table's record wins
 * (a ref deletion hides the ref, a log deletion the entry), refs are in name order (bytes),
 * logs by name and then newest update index first. Tables are immutable, so each is parsed
 * once and kept by name; `tables.list` is read again on each `read()`, and the view rebuilt
 * when it changed (native git writing meanwhile). A table named there but gone (a concurrent
 * compaction) makes the read start over, as git's reload does.
 */

import type { FilesApi } from "@statewalker/vcs-core";
import { joinPath } from "@statewalker/vcs-utils/files";

import { ReftableFormatError } from "./reftable-errors.js";
import {
  compareKeys,
  parseReftable,
  type ReftableLogRecord,
  type ReftableRefRecord,
  type ReftableTable,
} from "./reftable-table.js";

/** The merged view of a stack's tables. */
export interface ReftableView {
  /** The table names, oldest first (`tables.list`) */
  readonly tables: readonly string[];
  /** Every ref the newest record of which is not a deletion, by name */
  readonly refs: ReadonlyMap<string, ReftableRefRecord>;
  /** Those refs in name (byte) order */
  readonly sortedRefs: readonly ReftableRefRecord[];
  /** The log records of a ref, newest first, deletions removed (git's reflog order) */
  logsOf(refName: string): readonly ReftableLogRecord[];
  /** Whether git's reflog_exists holds: a log record of the ref that is not a deletion */
  hasLogs(refName: string): boolean;
}

/** Reads a stack directory into its merged view. */
export interface ReftableStackReader {
  /** The stack's directory (`<git dir>/reftable`, `<common dir>/worktrees/<id>/reftable`) */
  readonly dir: string;
  /** The merged view as `tables.list` names it now (an empty view when it does not exist) */
  read(): Promise<ReftableView>;
}

const TABLES_LIST = "tables.list";
const MAX_RELOADS = 10;
/** A table name git writes: `0x<min>-0x<max>-<random>.ref`; nothing naming another directory */
const TABLE_NAME = /^[^/\\]+\.ref$/;

/** A reader of the stack in `dir`, its parsed tables cached by name. */
export function createReftableStackReader(files: FilesApi, dir: string): ReftableStackReader {
  const tables = new Map<string, ReftableTable>();
  let cached: { list: string; view: ReftableView } | undefined;

  const readFile = async (path: string): Promise<Uint8Array | undefined> => {
    if ((await files.stats(path))?.kind !== "file") return undefined;
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of files.read(path)) {
      chunks.push(chunk);
      length += chunk.length;
    }
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  };

  const read = async (): Promise<ReftableView> => {
    for (let attempt = 0; attempt < MAX_RELOADS; attempt++) {
      const listBytes = await readFile(joinPath(dir, TABLES_LIST));
      const list = listBytes ? new TextDecoder().decode(listBytes) : "";
      if (cached && cached.list === list) return cached.view;
      const names = list.split("\n").filter((line) => line.length > 0);
      for (const name of names) {
        if (!TABLE_NAME.test(name) || name === "." || name === "..") {
          throw new ReftableFormatError(TABLES_LIST, `bad table name '${name}'`);
        }
      }
      const loaded: ReftableTable[] = [];
      let gone = false;
      for (const name of names) {
        let table = tables.get(name);
        if (!table) {
          const bytes = await readFile(joinPath(dir, name));
          if (!bytes) {
            gone = true;
            break;
          }
          table = parseReftable(bytes, name);
          tables.set(name, table);
        }
        loaded.push(table);
      }
      if (gone) continue;
      // forget tables no longer listed (compacted away)
      for (const name of [...tables.keys()]) if (!names.includes(name)) tables.delete(name);
      const view = mergeReftables(loaded);
      cached = { list, view };
      return view;
    }
    throw new ReftableFormatError(TABLES_LIST, "a table it names is missing");
  };

  return { dir, read };
}

/**
 * The merged view of `tables`, oldest first: for each key the newest table's record.
 */
export function mergeReftables(tables: readonly ReftableTable[]): ReftableView {
  const newest = new Map<string, ReftableRefRecord>();
  const logsByRef = new Map<string, Map<number, ReftableLogRecord>>();
  for (const table of tables) {
    for (const ref of table.refs) newest.set(ref.name, ref);
    for (const log of table.logs) {
      let byIndex = logsByRef.get(log.refName);
      if (!byIndex) {
        byIndex = new Map();
        logsByRef.set(log.refName, byIndex);
      }
      byIndex.set(log.updateIndex, log);
    }
  }
  const refs = new Map<string, ReftableRefRecord>();
  for (const [name, ref] of newest) if (ref.value.type !== "deletion") refs.set(name, ref);
  const sortedRefs = [...refs.values()].sort((a, b) => compareKeys(a.key, b.key));
  const logs = new Map<string, ReftableLogRecord[]>();
  for (const [name, byIndex] of logsByRef) {
    const entries = [...byIndex.values()]
      .filter((log) => log.update !== undefined)
      .sort((a, b) => b.updateIndex - a.updateIndex);
    if (entries.length > 0) logs.set(name, entries);
  }
  return {
    tables: tables.map((t) => t.name),
    refs,
    sortedRefs,
    logsOf: (refName) => logs.get(refName) ?? [],
    hasLogs: (refName) => logs.has(refName),
  };
}
