/**
 * Writes a reftable stack as git's `reftable/stack.c` does: each addition takes
 * `tables.list.lock`, reads the stack under it, writes one new table (named
 * `0x<min>-0x<max>-<random>.ref`, through a temporary renamed into place) and commits the
 * lock over `tables.list` with the new name appended; then the stack is compacted
 * geometrically when its table sizes ask for it (`reftable.geometricFactor`, unless
 * `reftable.autoCompaction` is off). `compactAll` merges every table into one (pack-refs,
 * gc) and removes the tables no longer listed.
 *
 * @example
 * ```typescript
 * const writer = createReftableStackWriter(files, ".git/reftable", reader, { lockTimeoutMs: 100 });
 * const addition = await writer.begin(); // tables.list.lock held, the stack read under it
 * await addition.add({
 *   minUpdateIndex: addition.nextUpdateIndex,
 *   maxUpdateIndex: addition.nextUpdateIndex,
 *   refs: [{ name: "refs/heads/main", updateIndex: addition.nextUpdateIndex, value: { type: "id", id } }],
 * });
 * await addition.commit(); // tables.list names the new table; the lock is gone
 * ```
 *
 * Compaction follows `stack_compact_range`: under the list lock, the tables of the range are
 * locked newest first (`<table>.lock`; a table another writer holds ends an automatic
 * compaction at the tables locked so far, "best effort"), the list lock is released while
 * the merged table is written, then taken again; the new list replaces the range (found
 * again by name when other writers appended meanwhile), and the old tables are removed. A
 * compaction that loses a race ("locked", "outdated") changes nothing, as in git, where such
 * failures of an automatic compaction are benign.
 */

import type { FilesApi } from "@statewalker/vcs-core";
import { type AtomicFiles, atomicFilesOver } from "@statewalker/vcs-utils/files";

import { mergeByHeap, type ReftableStackReader, type ReftableView } from "./reftable-stack.js";
import {
  compareKeys,
  type ReftableLogRecord,
  ReftableReadBudget,
  type ReftableRefRecord,
  type ReftableTable,
} from "./reftable-table.js";
import {
  type ReftableContent,
  type ReftableLogWrite,
  type ReftableRefWrite,
  type ReftableWriteOptions,
  writeReftable,
} from "./reftable-writer.js";

/** git's write options of a stack (`reftable.*`, read by the ref store from the config). */
export interface ReftableStackWriteOptions extends ReftableWriteOptions {
  /** `reftable.lockTimeout`: how long to retry a held `tables.list.lock`; 100 ms; -1 forever */
  lockTimeoutMs?: number;
  /** `reftable.geometricFactor`: 2 by default */
  geometricFactor?: number;
  /** Compact after each addition (git's default; `GIT_TEST_REFTABLE_AUTOCOMPACTION=false` off) */
  autoCompaction?: boolean;
}

/** `tables.list.lock` (or a table's lock) stays held by another writer. */
export class ReftableLockError extends Error {
  readonly code = "ELOCKED";
  constructor(readonly path: string) {
    super(`cannot lock references: '${path}.lock' is held by another writer`);
    this.name = "ReftableLockError";
  }
}

/** An addition in progress: the list lock is held until `commit` or `rollback`. */
export interface ReftableAddition {
  /** The stack as read under the lock */
  readonly view: ReftableView;
  /** git's reftable_stack_next_update_index: one past the newest table's maximum */
  readonly nextUpdateIndex: number;
  /** Writes `content` as a new table (none when it holds no record); the name, if written */
  add(content: ReftableContent): Promise<string | undefined>;
  /** Appends the new tables to `tables.list`, releases the lock, then compacts (when enabled) */
  commit(): Promise<void>;
  /** Removes the new tables and the lock */
  rollback(): Promise<void>;
}

/** The writer of one stack directory. */
export interface ReftableStackWriter {
  readonly dir: string;
  /** Takes `tables.list.lock` (retrying up to the lock timeout) and reads the stack under it */
  begin(): Promise<ReftableAddition>;
  /** git's reftable_stack_auto_compact: whether a compaction ran */
  autoCompact(): Promise<boolean>;
  /** git's reftable_stack_compact_all, then reftable_stack_clean */
  compactAll(): Promise<void>;
  /** Whether `autoCompact` (geometric) or `compactAll` (any two tables) would compact */
  compactionRequired(geometric: boolean): Promise<boolean>;
}

const TABLES_LIST = "tables.list";
const DEFAULT_LOCK_TIMEOUT = 100;
const DEFAULT_GEOMETRIC_FACTOR = 2;
/** git's table header size of version 1, less one (stack_segments_for_compaction) */
const SIZE_OVERHEAD = 24 - 1;
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STALE_TABLE = /^0x([0-9a-f]{12})-0x([0-9a-f]{12})-[0-9a-f]{8}\.ref$/;

function hex12(n: number): string {
  return n.toString(16).padStart(12, "0");
}

function random32(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** git's format_name: `0x<min>-0x<max>-<random>`. */
function formatName(min: number, max: number): string {
  return `0x${hex12(min)}-0x${hex12(max)}-${random32()}`;
}

/** The segment of tables to compact so that their sizes form a geometric sequence. */
export function suggestCompactionSegment(
  sizes: readonly number[],
  factor = DEFAULT_GEOMETRIC_FACTOR,
): { start: number; end: number } {
  const f = factor || DEFAULT_GEOMETRIC_FACTOR;
  const seg = { start: 0, end: 0 };
  const n = sizes.length;
  if (n <= 1) return seg;
  let i: number;
  let bytes = 0;
  for (i = n - 1; i > 0; i--) {
    if ((sizes[i - 1] as number) < (sizes[i] as number) * f) {
      seg.end = i + 1;
      bytes = sizes[i] as number;
      break;
    }
  }
  for (; i > 0; i--) {
    const curr = bytes;
    bytes += sizes[i - 1] as number;
    if ((sizes[i - 1] as number) < curr * f) seg.start = i - 1;
  }
  return seg;
}

/**
 * The records of `tables` (oldest first) merged as git's merged table iterates them: each
 * key once, from the newest table holding it; deletions kept (the caller drops them when the
 * range starts at the bottom of the stack).
 */
function mergedContent(tables: readonly ReftableTable[]): {
  refs: ReftableRefRecord[];
  logs: ReftableLogRecord[];
} {
  const budget = new ReftableReadBudget();
  const refs = [
    ...mergeByHeap(
      tables.map((t) => t.refs("", budget)),
      (a, b) => compareKeys(a.key, b.key) < 0,
      (a, b) => compareKeys(a.key, b.key) === 0,
    ),
  ];
  const logs: ReftableLogRecord[] = [];
  for (const log of mergeByHeap(
    tables.map((t) => t.logs(undefined, budget)),
    (a, b) => {
      const c = compareKeys(a.refKey, b.refKey);
      return c < 0 || (c === 0 && a.updateIndex > b.updateIndex);
    },
    (a, b) => compareKeys(a.refKey, b.refKey) === 0 && a.updateIndex === b.updateIndex,
  )) {
    logs.push(log);
  }
  return { refs, logs };
}

/** The writer of the stack in `dir`, reading it through `reader`. */
export function createReftableStackWriter(
  files: FilesApi,
  dir: string,
  reader: ReftableStackReader,
  options: ReftableStackWriteOptions = {},
): ReftableStackWriter {
  const atomic: AtomicFiles = atomicFilesOver(files, dir);
  const lockTimeout = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT;

  /** git's flock_acquire: `<path>.lock` created exclusively, retried until the timeout. */
  async function lock(path: string, timeoutMs: number): Promise<boolean> {
    const until = timeoutMs < 0 ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
    for (let wait = 1; ; wait = Math.min(wait * 2, 20)) {
      if (await atomic.createExclusive(`${path}.lock`, new Uint8Array(0))) return true;
      if (Date.now() >= until) return false;
      await sleep(wait);
    }
  }
  const unlock = (path: string) => atomic.remove(`${path}.lock`).catch(() => false);

  /** Commits the list lock with `names` as the new `tables.list`. */
  async function commitList(names: readonly string[]): Promise<void> {
    const lockPath = `${TABLES_LIST}.lock`;
    await atomic.write(lockPath, enc.encode(names.map((n) => `${n}\n`).join("")));
    await atomic.replace(lockPath, TABLES_LIST);
  }

  /** Writes `bytes` to a temporary and renames it to `<name>.ref`; the final name. */
  async function placeTable(
    bytes: Uint8Array,
    min: number,
    max: number,
    temporaryOf: string,
  ): Promise<string> {
    const temp = `${temporaryOf}.temp.${random32()}`;
    try {
      await atomic.write(temp, bytes);
      const name = `${formatName(min, max)}.ref`;
      await atomic.replace(temp, name);
      return name;
    } catch (error) {
      await atomic.remove(temp).catch(() => false);
      throw error;
    }
  }

  const nextIndexOf = (view: ReftableView) =>
    view.parts.length > 0 ? (view.parts.at(-1) as ReftableTable).maxUpdateIndex + 1 : 1;

  async function begin(): Promise<ReftableAddition> {
    if (!(await lock(TABLES_LIST, lockTimeout)))
      throw new ReftableLockError(`${dir}/${TABLES_LIST}`);
    let view: ReftableView;
    try {
      view = await reader.read();
    } catch (error) {
      await unlock(TABLES_LIST);
      throw error;
    }
    const nextUpdateIndex = nextIndexOf(view);
    const added: string[] = [];
    let open = true;
    const close = async () => {
      open = false;
      await unlock(TABLES_LIST);
    };
    return {
      view,
      nextUpdateIndex,
      async add(content) {
        if (!open) throw new Error("reftable: the addition is closed");
        if (content.minUpdateIndex < nextUpdateIndex) {
          throw new Error(
            `reftable: a table from update index ${content.minUpdateIndex}, below ${nextUpdateIndex}`,
          );
        }
        const bytes = writeReftable(content, options);
        if (!bytes) return undefined;
        const name = await placeTable(
          bytes,
          content.minUpdateIndex,
          content.maxUpdateIndex,
          formatName(nextUpdateIndex, nextUpdateIndex),
        );
        added.push(name);
        return name;
      },
      async commit() {
        if (!open) throw new Error("reftable: the addition is closed");
        if (added.length === 0) {
          await close();
          return;
        }
        try {
          await commitList([...view.tables, ...added]);
        } catch (error) {
          for (const name of added) await atomic.remove(name).catch(() => false);
          await close();
          throw error;
        }
        open = false;
        if (options.autoCompaction !== false) {
          // a concurrent writer holding part of the stack, or having rewritten it, makes the
          // compaction give up: benign, as in git
          await autoCompact().catch(() => false);
        }
      },
      async rollback() {
        if (!open) return;
        for (const name of added) await atomic.remove(name).catch(() => false);
        await close();
      },
    };
  }

  /**
   * git's stack_compact_range over tables `first..last` of `view` (the view the caller
   * decided on): "done", or why nothing changed.
   */
  async function compactRange(
    view: ReftableView,
    firstIn: number,
    last: number,
    bestEffort: boolean,
  ): Promise<"done" | "locked" | "outdated"> {
    let first = firstIn;
    if (first >= last) return "done";
    if (!(await lock(TABLES_LIST, lockTimeout))) return "locked";
    const tableLocks: string[] = [];
    let listLocked = true;
    try {
      const now = await reader.read();
      if (now.tables.join("\n") !== view.tables.join("\n")) return "outdated";
      for (let i = last + 1; i > first; i--) {
        const name = view.tables[i - 1] as string;
        if (!(await lock(name, 0))) {
          if (bestEffort && last - (i - 1) >= 2) {
            first = i;
            break;
          }
          return "locked";
        }
        tableLocks.push(name);
      }
      await unlock(TABLES_LIST);
      listLocked = false;

      const tables = view.parts.slice(first, last + 1);
      const { refs, logs } = mergedContent(tables);
      const bottom = first === 0;
      const min = (tables[0] as ReftableTable).minUpdateIndex;
      const max = (tables.at(-1) as ReftableTable).maxUpdateIndex;
      const content: ReftableContent = {
        minUpdateIndex: min,
        maxUpdateIndex: max,
        refs: refs
          .filter((r) => !(bottom && r.value.type === "deletion"))
          .map(
            (r): ReftableRefWrite => ({ name: r.name, updateIndex: r.updateIndex, value: r.value }),
          ),
        logs: logs
          .filter((l) => !(bottom && !l.update))
          .map(
            (l): ReftableLogWrite => ({
              refName: l.refName,
              updateIndex: l.updateIndex,
              ...(l.update ? { update: l.update } : {}),
            }),
          ),
      };
      const bytes = writeReftable(content, options);
      const name = bytes ? await placeTable(bytes, min, max, formatName(min, max)) : undefined;

      if (!(await lock(TABLES_LIST, lockTimeout))) {
        if (name) await atomic.remove(name).catch(() => false);
        return "locked";
      }
      listLocked = true;
      const current = (await reader.read()).tables;
      const at = current.indexOf(view.tables[first] as string);
      const span = last - first + 1;
      const same =
        at >= 0 && view.tables.slice(first, last + 1).every((n, j) => current[at + j] === n);
      if (!same) {
        if (name) await atomic.remove(name).catch(() => false);
        return "outdated";
      }
      const next = [...current.slice(0, at), ...(name ? [name] : []), ...current.slice(at + span)];
      try {
        await commitList(next);
      } catch (error) {
        if (name) await atomic.remove(name).catch(() => false);
        throw error;
      }
      listLocked = false;
      // the old tables may still be read by others: removing them may fail
      for (const old of tableLocks) await atomic.remove(old).catch(() => false);
      return "done";
    } finally {
      if (listLocked) await unlock(TABLES_LIST);
      for (const name of tableLocks) await unlock(name);
    }
  }

  const sizesOf = (view: ReftableView) => view.parts.map((t) => t.size - SIZE_OVERHEAD);

  async function compactionRequired(geometric: boolean): Promise<boolean> {
    const view = await reader.read();
    if (view.parts.length < 2) return false;
    if (!geometric) return true;
    const seg = suggestCompactionSegment(sizesOf(view), options.geometricFactor);
    return seg.end - seg.start > 0;
  }

  async function autoCompact(): Promise<boolean> {
    const view = await reader.read();
    if (view.parts.length < 2) return false;
    const seg = suggestCompactionSegment(sizesOf(view), options.geometricFactor);
    if (seg.end - seg.start <= 0) return false;
    return (await compactRange(view, seg.start, seg.end - 1, true)) === "done";
  }

  /** git's reftable_stack_clean: unlisted tables at or below the stack's update index */
  async function clean(): Promise<void> {
    if (!(await lock(TABLES_LIST, lockTimeout))) return;
    try {
      const view = await reader.read();
      const listed = new Set(view.tables);
      const max = view.parts.length > 0 ? (view.parts.at(-1) as ReftableTable).maxUpdateIndex : 0;
      for await (const info of files.list(dir)) {
        const base = info.path.slice(info.path.lastIndexOf("/") + 1);
        const m = STALE_TABLE.exec(base);
        if (!m || listed.has(base)) continue;
        if (Number.parseInt(m[2] as string, 16) > max) continue;
        if (await atomic.exists(`${base}.lock`)) continue;
        await atomic.remove(base).catch(() => false);
      }
    } finally {
      await unlock(TABLES_LIST);
    }
  }

  async function compactAll(): Promise<void> {
    const view = await reader.read();
    if (view.parts.length >= 2) {
      const r = await compactRange(view, 0, view.parts.length - 1, false);
      if (r === "locked") throw new ReftableLockError(`${dir}/${TABLES_LIST}`);
      if (r === "outdated") {
        throw new Error("unable to compact stack: data is outdated");
      }
    }
    await clean();
  }

  return { dir, begin, autoCompact, compactAll, compactionRequired };
}
