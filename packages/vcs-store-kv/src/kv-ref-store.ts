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
  ReflogLine,
  ReflogReader,
  Refs,
  RefUpdateResult,
  SymbolicRef,
} from "@statewalker/vcs-core";
import {
  compareRefNames,
  createReflogReaderOf,
  planRefBatch,
  planReflog,
  RefStorage,
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

  async set(refName: string, objectId: ObjectId): Promise<void> {
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

  async setSymbolic(refName: string, target: string): Promise<void> {
    await this.update(
      async (refs) => {
        refs.set(refName, `${SYMREF_PREFIX}${target}`);
        return { result: undefined, write: true };
      },
      () => {
        throw new Error(`Could not update ${refName}: too many concurrent writers`);
      },
    );
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
    for (const w of planReflog(updates, options)) {
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

  /** Initialize storage structure (no-op for KV). */
  async initialize(): Promise<void> {}

  /** Perform implementation-specific optimizations (no-op for KV). */
  async optimize(): Promise<void> {}
}
