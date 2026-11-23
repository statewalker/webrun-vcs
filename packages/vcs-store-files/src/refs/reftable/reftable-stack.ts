/**
 * A reftable stack (git's `reftable/stack.c`, `merged.c`): the directory `<git dir>/reftable`
 * whose `tables.list` names the tables oldest first, and the merged view of them.
 *
 * @example
 * ```typescript
 * const stack = createReftableStackReader(files, ".git/reftable");
 * const view = await stack.read();
 * view.getRef("refs/heads/main"); // the newest table's record, deletions hiding older ones
 * for (const ref of view.refs("refs/heads/")) console.log(ref.name);
 * for (const log of view.logs("HEAD")) console.log(log.update?.message); // newest first
 * ```
 *
 * The merged view follows git's merged iterator, lazily: a lookup asks the tables newest
 * first and stops at the first record (a deletion hides the ref); a listing is a k-way merge
 * of the tables' sorted iterators, the newest table winning on equal keys and deletions
 * dropped, refs in name (byte) order; a ref's reflog merges the tables' log records of that
 * ref, newest update index first, a log deletion hiding the entry. Each call decodes only
 * what it needs, under one {@link ReftableReadBudget}. Tables are immutable, so each is
 * opened once and kept by name (opening checks only its header and footer); `tables.list` is
 * read again on each `read()`. A table named there but gone (a concurrent compaction) makes
 * the read start over, as git's reload does.
 */

import type { FilesApi } from "@statewalker/vcs-core";
import { joinPath } from "@statewalker/vcs-utils/files";

import { ReftableFormatError } from "./reftable-errors.js";
import {
  compareKeys,
  openReftable,
  type ReftableLogHead,
  type ReftableLogRecord,
  ReftableReadBudget,
  type ReftableRefRecord,
  type ReftableTable,
} from "./reftable-table.js";

/** The merged view of a stack's tables. */
export interface ReftableView {
  /** The table names, oldest first (`tables.list`) */
  readonly tables: readonly string[];
  /** The ref's newest record, undefined when that is a deletion or there is none */
  getRef(name: string): ReftableRefRecord | undefined;
  /** The refs whose name starts with `prefix` and whose newest record is not a deletion, in name (byte) order */
  refs(prefix?: string): Generator<ReftableRefRecord>;
  /** The log records of a ref, newest first, deletions removed (git's reflog order) */
  logs(refName: string): Generator<ReftableLogRecord>;
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

/** A reader of the stack in `dir`, its opened tables cached by name. */
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
          table = openReftable(bytes, name);
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
 * The merged view of `tables`, oldest first: for each key the newest table's record. Each
 * call reads the tables lazily, under a budget of its own.
 */
export function mergeReftables(tables: readonly ReftableTable[]): ReftableView {
  const getRef = (name: string): ReftableRefRecord | undefined => {
    const budget = new ReftableReadBudget();
    for (let i = tables.length - 1; i >= 0; i--) {
      const record = (tables[i] as ReftableTable).getRef(name, budget);
      if (record) return record.value.type === "deletion" ? undefined : record;
    }
    return undefined;
  };

  function* refs(prefix = ""): Generator<ReftableRefRecord> {
    const budget = new ReftableReadBudget();
    const iterators = tables.map((t) => t.refs(prefix, budget));
    const heads = iterators.map((it) => it.next());
    for (;;) {
      // the smallest key; on equal keys the newest table's (scanned newest first)
      let best: ReftableRefRecord | undefined;
      for (let i = heads.length - 1; i >= 0; i--) {
        const head = heads[i] as IteratorResult<ReftableRefRecord>;
        if (head.done) continue;
        if (!best || compareKeys(head.value.key, best.key) < 0) best = head.value;
      }
      if (!best) return;
      for (let i = 0; i < heads.length; i++) {
        const head = heads[i] as IteratorResult<ReftableRefRecord>;
        if (!head.done && compareKeys(head.value.key, best.key) === 0) {
          heads[i] = (iterators[i] as Generator<ReftableRefRecord>).next();
        }
      }
      if (best.value.type !== "deletion") yield best;
    }
  }

  function* logs(refName: string): Generator<ReftableLogRecord> {
    const budget = new ReftableReadBudget();
    const iterators = tables.map((t) => t.logHeads(refName, budget));
    const heads = iterators.map((it) => it.next());
    for (;;) {
      // the newest update index; on equal ones the newest table's
      let best: ReftableLogHead | undefined;
      for (let i = heads.length - 1; i >= 0; i--) {
        const head = heads[i] as IteratorResult<ReftableLogHead>;
        if (head.done) continue;
        if (!best || head.value.updateIndex > best.updateIndex) best = head.value;
      }
      if (!best) return;
      // decoded before any iterator moves on; the records it hides never are
      const update = best.deletion ? undefined : best.read();
      const { refKey, updateIndex } = best;
      for (let i = 0; i < heads.length; i++) {
        const head = heads[i] as IteratorResult<ReftableLogHead>;
        if (!head.done && head.value.updateIndex === updateIndex) {
          heads[i] = (iterators[i] as Generator<ReftableLogHead>).next();
        }
      }
      if (update) yield { refName: best.refName, refKey, updateIndex, update };
    }
  }

  return {
    tables: tables.map((t) => t.name),
    getRef,
    refs,
    logs,
    hasLogs: (refName) => !logs(refName).next().done,
  };
}
