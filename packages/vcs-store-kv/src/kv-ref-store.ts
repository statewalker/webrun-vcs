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
  Ref,
  RefCommand,
  RefEntry,
  Refs,
  RefUpdateResult,
  SymbolicRef,
} from "@statewalker/vcs-core";
import { compareRefNames, planRefBatch, RefStorage } from "@statewalker/vcs-core";
import type { KVStore } from "./kv-store.js";

/** The key holding all refs. */
const ROOT_KEY = "ref:root";
/** Symbolic refs are stored as "ref: <target>", as in git's loose ref files. */
const SYMREF_PREFIX = "ref: ";
/** Follow at most this many refs along a symbolic chain (git's read limit). */
const MAX_SYMREF_READS = 5;
/** Give up after this many lost races and report the batch as locked. */
const MAX_ATTEMPTS = 100;

type Snapshot = Map<string, string>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decode(bytes: Uint8Array | undefined): Snapshot {
  if (!bytes) return new Map();
  return new Map(Object.entries(JSON.parse(decoder.decode(bytes)) as Record<string, string>));
}

function encode(refs: Snapshot): Uint8Array {
  const out: Record<string, string> = {};
  for (const name of [...refs.keys()].sort(compareRefNames)) out[name] = refs.get(name) as string;
  return encoder.encode(JSON.stringify(out));
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
  constructor(private kv: KVStore) {}

  private async read(): Promise<{ bytes: Uint8Array | undefined; refs: Snapshot }> {
    const bytes = await this.kv.get(ROOT_KEY);
    return { bytes, refs: decode(bytes) };
  }

  /**
   * Apply `change` to the snapshot and write it with one compare-and-swap,
   * retrying on a lost race. `change` returns the result, or `undefined` to
   * write nothing.
   */
  private async update<T>(
    change: (refs: Snapshot) => Promise<{ result: T; write: boolean }>,
    locked: () => T,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const { bytes, refs } = await this.read();
      const { result, write } = await change(refs);
      if (!write) return result;
      if (await this.kv.compareAndSwap(ROOT_KEY, bytes, encode(refs))) return result;
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
   * compare-and-swap of the root value. Reflogs are not kept yet, so `options`
   * is ignored.
   */
  batch(commands: RefCommand[], _options?: BatchOptions): Promise<BatchResult> {
    return this.update<BatchResult>(
      async (refs) => {
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
        return { result: { ok: true, rejected: [] }, write: plan.updates.length > 0 };
      },
      () => ({
        ok: false,
        rejected: commands.map((c) => ({ name: c.name, reason: "locked" as const })),
      }),
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
