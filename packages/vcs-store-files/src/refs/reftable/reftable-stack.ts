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
  type ReftableLogRecord,
  ReftableReadBudget,
  type ReftableRefRecord,
  type ReftableTable,
} from "./reftable-table.js";

/** The merged view of a stack's tables. */
export interface ReftableView {
  /** The table names, oldest first (`tables.list`) */
  readonly tables: readonly string[];
  /** The opened tables, oldest first (what a writer compacts and numbers after) */
  readonly parts: readonly ReftableTable[];
  /** The ref's newest record, undefined when that is a deletion or there is none */
  getRef(name: string): ReftableRefRecord | undefined;
  /** The refs whose name starts with `prefix` and whose newest record is not a deletion, in name (byte) order */
  refs(prefix?: string): Generator<ReftableRefRecord>;
  /** The log records of a ref, newest first, deletions removed (git's reflog order) */
  logs(refName: string): Generator<ReftableLogRecord>;
  /** Whether git's reflog_exists holds: a log record of the ref that is not a deletion */
  hasLogs(refName: string): boolean;
  /** The names that have log records in some table (deleted ones included), in byte order */
  logNames(): string[];
}

/** Reads a stack directory into its merged view. */
export interface ReftableStackReader {
  /** The stack's directory (`<git dir>/reftable`, `<common dir>/worktrees/<id>/reftable`) */
  readonly dir: string;
  /** The merged view as `tables.list` names it now (an empty view when it does not exist) */
  read(): Promise<ReftableView>;
}

const TABLES_LIST = "tables.list";
/**
 * The most table bytes one stack may hold in memory: 512 MiB. Tables are read whole (each
 * read then decodes only what it needs); a stack of more is refused, not read.
 */
export const REFTABLE_STACK_BYTES_CEILING = 512 * 1024 * 1024;
const MAX_RELOADS = 10;
/** A table name git writes: `0x<min>-0x<max>-<random>.ref`; nothing naming another directory */
const TABLE_NAME = /^[^/\\]+\.ref$/;

/** A reader of the stack in `dir`, its opened tables cached by name. */
export function createReftableStackReader(
  files: FilesApi,
  dir: string,
  bytesCeiling = REFTABLE_STACK_BYTES_CEILING,
): ReftableStackReader {
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
      const seen = new Set<string>();
      for (const name of names) {
        if (!TABLE_NAME.test(name) || name === "." || name === "..") {
          throw new ReftableFormatError(TABLES_LIST, `bad table name '${name}'`);
        }
        if (seen.has(name))
          throw new ReftableFormatError(TABLES_LIST, `table '${name}' named twice`);
        seen.add(name);
      }
      const loaded: ReftableTable[] = [];
      let gone = false;
      let held = 0;
      for (const name of names) {
        let table = tables.get(name);
        if (!table) {
          const path = joinPath(dir, name);
          const size = (await files.stats(path))?.size ?? 0;
          if (held + size > bytesCeiling) throw tooLarge();
          const bytes = await readFile(path);
          if (!bytes) {
            gone = true;
            break;
          }
          table = openReftable(bytes, name);
          tables.set(name, table);
        }
        held += table.size;
        if (held > bytesCeiling) throw tooLarge();
        // git's stack writer gives each table update indexes past the last one's (stack.c)
        const previous = loaded.at(-1);
        if (previous && table.minUpdateIndex <= previous.maxUpdateIndex) {
          throw new ReftableFormatError(
            name,
            `update indexes from ${table.minUpdateIndex}, not past ${previous.maxUpdateIndex} of '${previous.name}' below it`,
          );
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

  const tooLarge = () =>
    new ReftableFormatError(TABLES_LIST, `its tables hold more than ${bytesCeiling} bytes`);

  return { dir, read };
}

/**
 * The records of `iterators` (each in key order) in one key order, a binary heap of their
 * heads (git's pq.c and merged.c): on equal keys the newest table's (the highest index) comes
 * first and the others with that key are passed over. `before(a, b)` tells whether `a`'s key
 * sorts before `b`'s, `same` whether the keys are equal. Each record is yielded before any
 * iterator moves on, so a lazy record can still be read.
 */
export function* mergeByHeap<T>(
  iterators: Iterator<T>[],
  before: (a: T, b: T) => boolean,
  same: (a: T, b: T) => boolean,
): Generator<T> {
  type Entry = { value: T; table: number };
  const heap: Entry[] = [];
  const less = (a: Entry, b: Entry) =>
    before(a.value, b.value) || (!before(b.value, a.value) && a.table > b.table);
  const push = (entry: Entry) => {
    heap.push(entry);
    for (let i = heap.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!less(heap[i] as Entry, heap[parent] as Entry)) break;
      [heap[i], heap[parent]] = [heap[parent] as Entry, heap[i] as Entry];
      i = parent;
    }
  };
  const pop = (): Entry => {
    const top = heap[0] as Entry;
    const last = heap.pop() as Entry;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l] as Entry, heap[m] as Entry)) m = l;
        if (r < heap.length && less(heap[r] as Entry, heap[m] as Entry)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m] as Entry, heap[i] as Entry];
        i = m;
      }
    }
    return top;
  };
  const advance = (table: number) => {
    const next = (iterators[table] as Iterator<T>).next();
    if (!next.done) push({ value: next.value, table });
  };
  for (let i = 0; i < iterators.length; i++) advance(i);
  while (heap.length > 0) {
    const best = pop();
    yield best.value;
    // the older tables' records of the same key are hidden
    while (heap.length > 0 && same((heap[0] as Entry).value, best.value)) advance(pop().table);
    advance(best.table);
  }
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
    for (const record of mergeByHeap(
      tables.map((t) => t.refs(prefix, budget)),
      (a, b) => compareKeys(a.key, b.key) < 0,
      (a, b) => compareKeys(a.key, b.key) === 0,
    )) {
      if (record.value.type !== "deletion") yield record;
    }
  }

  function* logs(refName: string): Generator<ReftableLogRecord> {
    const budget = new ReftableReadBudget();
    // newest update index first; the records a newer table hides are never decoded
    for (const head of mergeByHeap(
      tables.map((t) => t.logHeads(refName, budget)),
      (a, b) => a.updateIndex > b.updateIndex,
      (a, b) => a.updateIndex === b.updateIndex,
    )) {
      const update = head.deletion ? undefined : head.read();
      if (update)
        yield { refName: head.refName, refKey: head.refKey, updateIndex: head.updateIndex, update };
    }
  }

  return {
    tables: tables.map((t) => t.name),
    parts: tables,
    getRef,
    refs,
    logs,
    hasLogs: (refName) => !logs(refName).next().done,
    logNames: () => {
      const budget = new ReftableReadBudget();
      const names = new Map<string, Uint8Array>();
      for (const t of tables) {
        let last = "";
        for (const head of t.logHeads(undefined, budget)) {
          if (head.refName === last) continue;
          last = head.refName;
          names.set(head.refName, head.refKey);
        }
      }
      return [...names.values()].sort(compareKeys).map((k) => new TextDecoder().decode(k));
    },
  };
}
