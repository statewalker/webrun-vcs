/**
 * KV-based Refs implementation.
 *
 * A KV store offers compare-and-swap on one key only, so every ref lives in one
 * root value (JSON `{ name: id | "ref: target" }`, sorted in git's order) and
 * every write, a whole batch included, is one compare-and-swap of that value:
 * read the snapshot, plan against it, write it back only if the root still holds
 * the bytes read. On a lost race the write re-reads and re-plans, since other
 * refs may have moved without touching this batch's.
 */

import type {
  BatchOptions,
  BatchResult,
  ObjectId,
  PlannedRefUpdate,
  Ref,
  RefCommand,
  RefEntry,
  RefLogOptions,
  ReflogDeleteOptions,
  ReflogLine,
  ReflogReader,
  ReflogWrite,
  Refs,
  RefUpdateResult,
  SymbolicRef,
  SymbolicRefLogOptions,
} from "@statewalker/vcs-core";
import {
  compareRefNames,
  createReflogReaderOf,
  deleteReflogLine,
  isUpdatableRefName,
  planRefBatch,
  planReflog,
  ReflogEntryNotFoundError,
  RefStorage,
  symrefReflogWrites,
} from "@statewalker/vcs-core";
import type { KVStore } from "./kv-store.js";

/** The key holding all refs. */
const ROOT_KEY = "ref:root";
/** Reflogs, one key per ref, outside the `ref:` keys the root layout owns. */
const REFLOG_PREFIX = "reflog:";
/** A reflog value: its lines in batch order, and the last batch that dropped it. */
interface StoredLog {
  dropped: number;
  lines: (ReflogLine & { seq: number })[];
}

function decodeLog(bytes: Uint8Array | undefined): StoredLog {
  if (!bytes) return { dropped: 0, lines: [] };
  const log = JSON.parse(decoder.decode(bytes)) as StoredLog;
  if (typeof log?.dropped !== "number" || !Array.isArray(log.lines)) {
    throw new Error("corrupt reflog value");
  }
  return log;
}

/** The shallow commits (git's `shallow` file): a sorted JSON array of ids, `[]` when complete. */
const SHALLOW_KEY = "shallow:root";

function decodeShallow(bytes: Uint8Array | undefined): ObjectId[] {
  if (!bytes) return [];
  const ids = JSON.parse(decoder.decode(bytes)) as unknown;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new Error(`corrupt shallow value (${SHALLOW_KEY})`);
  }
  return ids as ObjectId[];
}

/** Symbolic refs are stored as "ref: <target>", as in git's loose ref files. */
const SYMREF_PREFIX = "ref: ";
/** Follow at most this many refs along a symbolic chain (git's read limit). */
const MAX_SYMREF_READS = 5;
/** Give up after this many lost races and report the batch as locked. */
const MAX_ATTEMPTS = 100;

type Snapshot = Map<string, string>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Thrown when the root value is not a JSON object of strings; it is never overwritten. */
export class CorruptRefRootError extends Error {
  constructor(detail: string) {
    super(`corrupt ref root (${ROOT_KEY}): ${detail}`);
    this.name = "CorruptRefRootError";
  }
}

/**
 * Root entry counting the root's writes (not a ref: git ref names cannot
 * contain ":"). Reflog lines carry it, so they keep the order of the batches.
 */
const SEQ_KEY = ":seq";

function decode(bytes: Uint8Array | undefined): { refs: Snapshot; seq: number } {
  if (!bytes) return { refs: new Map(), seq: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch (e) {
    throw new CorruptRefRootError(e instanceof Error ? e.message : String(e));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CorruptRefRootError("not a JSON object");
  }
  const refs: Snapshot = new Map();
  let seq = 0;
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string")
      throw new CorruptRefRootError(`value of ${name} is not a string`);
    if (name === SEQ_KEY) {
      if (!/^\d+$/.test(value)) throw new CorruptRefRootError(`${SEQ_KEY} is not a number`);
      seq = Number(value);
    } else refs.set(name, value);
  }
  return { refs, seq };
}

function encode(refs: Snapshot, seq: number): Uint8Array {
  // fromEntries defines own properties, so even a name like "__proto__" survives.
  const sorted = [...refs.keys()].sort(compareRefNames);
  const entries = sorted.map((n) => [n, refs.get(n)]);
  return encoder.encode(JSON.stringify(Object.fromEntries([...entries, [SEQ_KEY, String(seq)]])));
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toRef(name: string, value: string | undefined): Ref | SymbolicRef | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith(SYMREF_PREFIX)) {
    return { name, target: value.slice(SYMREF_PREFIX.length), storage: RefStorage.LOOSE };
  }
  return { name, objectId: value, storage: RefStorage.LOOSE, peeled: false };
}

/** The id `name` resolves to in a snapshot (through symbolic refs), if any. */
function resolveIn(refs: Snapshot, name: string): ObjectId | undefined {
  let at = name;
  for (let i = 0; i < MAX_SYMREF_READS; i++) {
    const value = refs.get(at);
    if (value === undefined) return undefined;
    if (!value.startsWith(SYMREF_PREFIX)) return value;
    at = value.slice(SYMREF_PREFIX.length);
  }
  return undefined;
}

/**
 * KV-based Refs: all refs in one root value, every write one compare-and-swap.
 *
 * @example
 * ```typescript
 * const refs = new KVRefStore(new MemoryKVAdapter());
 * await refs.batch([
 *   { name: "refs/heads/main", old: null, new: commitId },
 *   { name: "refs/tags/v1", old: null, new: tagId },
 * ]);
 * ```
 */
export class KVRefStore implements Refs {
  /** The last root read and its decoded refs: reused while the bytes are unchanged. */
  private cache: { bytes: Uint8Array; refs: Snapshot; seq: number } | undefined;

  constructor(private kv: KVStore) {}

  /** Read the root. The returned map is a private copy the caller may change. */
  private async read(): Promise<{ bytes: Uint8Array | undefined; refs: Snapshot; seq: number }> {
    const bytes = await this.kv.get(ROOT_KEY);
    if (!bytes) {
      await this.checkNoOldLayout();
      return { bytes, refs: new Map(), seq: 0 };
    }
    if (!this.cache || !sameBytes(this.cache.bytes, bytes)) {
      this.cache = { bytes: new Uint8Array(bytes), ...decode(bytes) };
    }
    return { bytes, refs: new Map(this.cache.refs), seq: this.cache.seq };
  }

  /**
   * Stores written before the root layout kept one `ref:<name>` key per ref.
   * Refuse them rather than show an empty store that writes would fork.
   */
  private async checkNoOldLayout(): Promise<void> {
    for await (const key of this.kv.list("ref:")) {
      if (key !== ROOT_KEY) {
        throw new Error(
          `KVRefStore: found ${key} in the old one-key-per-ref layout; this store keeps all refs in ${ROOT_KEY}`,
        );
      }
    }
  }

  /**
   * Apply `change` to the snapshot and write it with one compare-and-swap,
   * retrying on a lost race. `change` gets the sequence number the write will
   * commit with and returns the result and whether to write.
   */
  private async update<T>(
    change: (refs: Snapshot, seq: number) => Promise<{ result: T; write: boolean }>,
    locked: () => T,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const { bytes, refs, seq } = await this.read();
      const { result, write } = await change(refs, seq + 1);
      if (!write) return result;
      if (await this.kv.compareAndSwap(ROOT_KEY, bytes, encode(refs, seq + 1))) return result;
      // Lost the race: back off briefly, re-read and re-check.
      await new Promise((r) => setTimeout(r, Math.random() * Math.min(2 ** attempt, 20)));
    }
    return locked();
  }

  async get(refName: string): Promise<Ref | SymbolicRef | undefined> {
    return toRef(refName, (await this.read()).refs.get(refName));
  }

  async resolve(refName: string): Promise<Ref | undefined> {
    const { refs } = await this.read();
    let name = refName;
    for (let i = 0; i < MAX_SYMREF_READS; i++) {
      const ref = toRef(name, refs.get(name));
      if (!ref) return undefined;
      if (!("target" in ref)) return ref;
      name = ref.target;
    }
    throw new Error(`Symbolic ref chain too deep (more than ${MAX_SYMREF_READS} refs)`);
  }

  async has(refName: string): Promise<boolean> {
    return (await this.read()).refs.has(refName);
  }

  async *list(prefix?: string): AsyncIterable<RefEntry> {
    const { refs } = await this.read();
    for (const name of [...refs.keys()].sort(compareRefNames)) {
      if (prefix && !name.startsWith(prefix)) continue;
      const ref = toRef(name, refs.get(name));
      if (ref) yield ref;
    }
  }

  /**
   * Point `refName` at `objectId`; with a reflog line (`log`), as a one-ref batch that logs
   * it as git does (see {@link Refs.set}).
   */
  async set(refName: string, objectId: ObjectId, log?: RefLogOptions): Promise<void> {
    if (log && isUpdatableRefName(refName)) {
      const r = await this.batch([{ name: refName, new: objectId, noDeref: true }], log);
      if (!r.ok) {
        throw new Error(
          `cannot update ${refName}: ${r.rejected.map((x) => `${x.name}: ${x.reason}`).join(", ")}`,
        );
      }
      return;
    }
    await this.update(
      async (refs) => {
        refs.set(refName, objectId);
        return { result: undefined, write: true };
      },
      () => {
        throw new Error(`Could not update ${refName}: too many concurrent writers`);
      },
    );
  }

  /**
   * Point `refName` at `target`; with a `log` message, `refName`'s reflog records it as
   * git's create_symref does (see {@link Refs.setSymbolic}).
   */
  async setSymbolic(refName: string, target: string, log?: SymbolicRefLogOptions): Promise<void> {
    let writes: ReflogWrite[] = [];
    let committed = 0;
    await this.update(
      async (refs, seq) => {
        const old = log ? resolveIn(refs, refName) : undefined;
        refs.set(refName, `${SYMREF_PREFIX}${target}`);
        writes = symrefReflogWrites(refName, old, log ? resolveIn(refs, target) : undefined, log);
        committed = seq;
        return { result: undefined, write: true };
      },
      () => {
        throw new Error(`Could not update ${refName}: too many concurrent writers`);
      },
    );
    if (writes.length > 0) await this.applyReflogWrites(writes, committed);
  }

  async remove(refName: string): Promise<boolean> {
    return this.update(
      async (refs) => {
        const existed = refs.delete(refName);
        return { result: existed, write: existed };
      },
      () => {
        throw new Error(`Could not remove ${refName}: too many concurrent writers`);
      },
    );
  }

  /**
   * Apply all commands atomically, or none (see {@link Refs.batch}): one
   * compare-and-swap of the root value, then the reflog lines.
   */
  async batch(commands: RefCommand[], options?: BatchOptions): Promise<BatchResult> {
    let applied: PlannedRefUpdate[] = [];
    let committed = 0;
    const result = await this.update<BatchResult>(
      async (refs, seq) => {
        const plan = await planRefBatch(commands, {
          read: (name) => toRef(name, refs.get(name)),
          hasChildren: (name) => {
            const prefix = `${name}/`;
            for (const key of refs.keys()) if (key.startsWith(prefix)) return true;
            return false;
          },
        });
        if (!plan.ok) return { result: { ok: false, rejected: plan.rejected }, write: false };
        for (const u of plan.updates) {
          if (u.newValue === null) refs.delete(u.name);
          else refs.set(u.name, u.newValue);
        }
        applied = plan.updates;
        committed = seq;
        return { result: { ok: true, rejected: [] }, write: plan.updates.length > 0 };
      },
      () => ({
        ok: false,
        rejected: commands.map((c) => ({ name: c.name, reason: "locked" as const })),
      }),
    );
    if (result.ok && applied.length > 0) await this.writeReflogs(applied, committed, options);
    return result;
  }

  /**
   * Reflog lines, after the batch committed as root write `seq`. Each ref's log
   * is one key (`reflog:<name>`) holding its lines with the `seq` of the batch
   * that wrote them, kept in that order whatever order concurrent batches write
   * in. A drop leaves a mark: lines of earlier batches are removed and late ones
   * ignored, while later batches log anew. A log write that fails or keeps
   * losing its compare-and-swap is skipped; the committed batch stands.
   */
  private async writeReflogs(
    updates: PlannedRefUpdate[],
    seq: number,
    options?: BatchOptions,
  ): Promise<void> {
    await this.applyReflogWrites(planReflog(updates, options), seq);
  }

  /** Reflog writes of root write `seq` (see {@link writeReflogs}). */
  private async applyReflogWrites(writes: ReflogWrite[], seq: number): Promise<void> {
    for (const w of writes) {
      const key = `${REFLOG_PREFIX}${w.name}`;
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          const bytes = await this.kv.get(key);
          const log = decodeLog(bytes);
          if (w.op === "drop") {
            log.dropped = Math.max(log.dropped, seq);
            log.lines = log.lines.filter((l) => l.seq > seq);
          } else {
            if (seq < log.dropped || (log.lines.length === 0 && !w.create)) break;
            let at = log.lines.length;
            while (at > 0 && log.lines[at - 1].seq > seq) at--;
            log.lines.splice(at, 0, { seq, ...w.line });
          }
          if (await this.kv.compareAndSwap(key, bytes, encoder.encode(JSON.stringify(log)))) break;
        }
      } catch {
        // a broken log value or a failing store: the ref update stands without this line
      }
    }
  }

  /** The reflog of `name` (written by `batch`), or undefined if it has none. */
  async getReflog(refName: string): Promise<ReflogReader | undefined> {
    const { lines } = decodeLog(await this.kv.get(`${REFLOG_PREFIX}${refName}`));
    if (lines.length === 0) return undefined;
    return createReflogReaderOf(
      lines.map(({ oldId, newId, ident, message }) => ({ oldId, newId, ident, message })),
    );
  }

  /**
   * Delete reflog entry `name@{index}` (see {@link Refs.deleteReflogEntry}). The ref
   * moves first (one compare-and-swap of the root, to the newest kept entry), then the log key is replaced only if it still holds the
   * bytes the plan was made from; a lost race re-reads and re-plans. A failure between
   * the two leaves the log whole and the ref at the entry the retried drop moves it to,
   * so retrying converges and no entry is lost.
   */
  async deleteReflogEntry(
    refName: string,
    index: number,
    options: ReflogDeleteOptions = {},
  ): Promise<number> {
    const key = `${REFLOG_PREFIX}${refName}`;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const bytes = await this.kv.get(key);
      const log = decodeLog(bytes);
      const removed = log.lines[log.lines.length - 1 - index];
      const kept = deleteReflogLine(log.lines, index, options.rewrite);
      if (!kept || !removed) throw new ReflogEntryNotFoundError(refName, index);
      const top = kept.at(-1);
      if (options.updateRef && top) {
        await this.update(
          async (refs) => {
            // git's rule (the newest kept entry, never through a symbolic ref), applied
            // only while the ref holds the deleted entry's value or nothing: a ref a
            // concurrent writer moved keeps its value, as git's ref lock would have
            // ordered that write after the drop.
            const current = refs.get(refName);
            const write = current === undefined || current === removed.newId;
            if (write) refs.set(refName, top.newId);
            return { result: undefined, write };
          },
          () => {
            throw new Error(`Could not update ${refName}: too many concurrent writers`);
          },
        );
      }
      const next = encoder.encode(JSON.stringify({ ...log, lines: kept }));
      if (await this.kv.compareAndSwap(key, bytes, next)) return kept.length;
      // Lost the race to another log write: back off, re-read and re-plan.
      await new Promise((r) => setTimeout(r, Math.random() * Math.min(2 ** attempt, 20)));
    }
    throw new Error(`Could not update the reflog of ${refName}: too many concurrent writers`);
  }

  async compareAndSwap(
    refName: string,
    expectedOld: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<RefUpdateResult> {
    const r = await this.batch([{ name: refName, old: expectedOld ?? null, new: newValue }]);
    if (r.ok) return { success: true, previousValue: expectedOld };
    return {
      success: false,
      previousValue: (await this.resolve(refName))?.objectId,
      errorMessage: r.rejected.map((x) => `${x.name}: ${x.reason}`).join(", "),
    };
  }

  /** The shallow commits (git's `shallow` file), sorted; empty for a complete repository. */
  async getShallow(): Promise<ObjectId[]> {
    return decodeShallow(await this.kv.get(SHALLOW_KEY));
  }

  /**
   * Replace the shallow commits with one compare-and-swap of their key. With `expected`
   * (the list the caller read), a list that changed meanwhile is not overwritten: the
   * write fails with "shallow file has changed since we read it", as git's
   * check_shallow_file_for_update.
   */
  async setShallow(commits: Iterable<ObjectId>, expected?: Iterable<ObjectId>): Promise<void> {
    const ids = [...new Set(commits)].sort();
    const want = expected ? [...new Set(expected)].sort() : undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const bytes = await this.kv.get(SHALLOW_KEY);
      const current = decodeShallow(bytes);
      if (want && (current.length !== want.length || current.some((id, i) => id !== want[i]))) {
        throw new Error("shallow file has changed since we read it");
      }
      if (await this.kv.compareAndSwap(SHALLOW_KEY, bytes, encoder.encode(JSON.stringify(ids)))) {
        return;
      }
    }
    throw new Error("Could not update the shallow commits: too many concurrent writers");
  }

  /** Initialize storage structure (no-op for KV). */
  async initialize(): Promise<void> {}

  /** Perform implementation-specific optimizations (no-op for KV). */
  async optimize(): Promise<void> {}
}
