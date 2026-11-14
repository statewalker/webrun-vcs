/**
 * In-memory Refs implementation (`MemoryRefs`).
 */

import type { ObjectId } from "../../common/id/index.js";
import {
  type BatchOptions,
  type BatchResult,
  batchBySingleRef,
  planRefBatch,
  planReflog,
  type RefCommand,
  type ReflogLine,
} from "./ref-batch.js";
import type { Ref, SymbolicRef } from "./ref-types.js";
import { RefStorage } from "./ref-types.js";
import { createReflogReaderOf } from "./reflog-lines.js";
import type { ReflogReader } from "./reflog-types.js";
import type { RefEntry, Refs, RefUpdateResult, RefValue } from "./refs.js";

/**
 * Maximum depth for following symbolic refs to prevent infinite loops.
 */
const MAX_SYMBOLIC_REF_DEPTH = 100;

type InternalRefEntry =
  | { type: "direct"; objectId: ObjectId; peeledObjectId?: ObjectId }
  | { type: "symbolic"; target: string };

/**
 * Native in-memory Refs implementation
 *
 * Provides a pure in-memory reference storage for testing and ephemeral operations.
 * No persistence - data is lost when the instance is garbage collected.
 */
export class MemoryRefs implements Refs {
  private refs = new Map<string, InternalRefEntry>();
  /** Reflogs by ref name, oldest line first. */
  private logs = new Map<string, ReflogLine[]>();
  /** Serializes writes, so a batch applies exactly the plan it checked. */
  private tail: Promise<unknown> = Promise.resolve();

  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private entryToRef(name: string): Ref | SymbolicRef | undefined {
    const entry = this.refs.get(name);
    if (!entry) return undefined;
    if (entry.type === "symbolic") {
      return { name, target: entry.target, storage: RefStorage.LOOSE } as SymbolicRef;
    }
    return {
      name,
      objectId: entry.objectId,
      storage: RefStorage.LOOSE,
      peeled: entry.peeledObjectId !== undefined,
      peeledObjectId: entry.peeledObjectId,
    } as Ref;
  }

  /**
   * Get a reference value
   */
  async get(name: string): Promise<RefValue | undefined> {
    return this.entryToRef(name);
  }

  /**
   * Resolve a reference to its final object ID (follows symbolic refs)
   */
  async resolve(name: string): Promise<Ref | undefined> {
    let current = name;
    let depth = 0;

    while (depth < MAX_SYMBOLIC_REF_DEPTH) {
      const entry = this.refs.get(current);
      if (!entry) {
        return undefined;
      }

      if (entry.type === "direct") {
        return {
          name: current,
          objectId: entry.objectId,
          storage: RefStorage.LOOSE,
          peeled: entry.peeledObjectId !== undefined,
          peeledObjectId: entry.peeledObjectId,
        } as Ref;
      }

      // Follow symbolic ref
      current = entry.target;
      depth++;
    }

    throw new Error(`Symbolic ref chain too deep (> ${MAX_SYMBOLIC_REF_DEPTH})`);
  }

  /**
   * Check if a reference exists
   */
  async has(name: string): Promise<boolean> {
    return this.refs.has(name);
  }

  /**
   * List references
   */
  async *list(prefix?: string): AsyncIterable<RefEntry> {
    // Snapshot first, so a batch landing between yields is never half seen.
    const names = [...this.refs.keys()].filter((name) => !prefix || name.startsWith(prefix));
    const snapshot = names.map((name) => this.entryToRef(name));
    for (const ref of snapshot) if (ref) yield ref;
  }

  /**
   * Set a direct reference
   */
  set(name: string, objectId: ObjectId): Promise<void> {
    return this.exclusive(() => {
      this.refs.set(name, { type: "direct", objectId });
    });
  }

  /**
   * Set a symbolic reference
   */
  setSymbolic(name: string, target: string): Promise<void> {
    return this.exclusive(() => {
      this.refs.set(name, { type: "symbolic", target });
    });
  }

  /**
   * Remove a reference
   */
  remove(name: string): Promise<boolean> {
    return this.exclusive(() => this.refs.delete(name));
  }

  /**
   * Apply all commands atomically, or none (see {@link Refs.batch}). The memory
   * store keeps no reflog, so `options` is ignored.
   */
  /**
   * Apply all commands atomically, or none (see {@link Refs.batch}), writing
   * reflog lines as git does (`options.ident`, `options.message`).
   */
  batch(commands: RefCommand[], options?: BatchOptions): Promise<BatchResult> {
    return this.exclusive(() => this.applyBatch(commands, options));
  }

  /** Plan and apply a batch; call only while holding the write lock. */
  private async applyBatch(commands: RefCommand[], options?: BatchOptions): Promise<BatchResult> {
    const plan = await planRefBatch(commands, {
      read: (name) => this.entryToRef(name),
      hasChildren: (name) => {
        const prefix = `${name}/`;
        for (const key of this.refs.keys()) if (key.startsWith(prefix)) return true;
        return false;
      },
    });
    if (!plan.ok) return { ok: false, rejected: plan.rejected };
    for (const u of plan.updates) {
      if (u.newValue === null) this.refs.delete(u.name);
      else this.refs.set(u.name, { type: "direct", objectId: u.newValue });
    }
    const logs = planReflog(plan.updates, options);
    for (const name of logs.drop) this.logs.delete(name);
    for (const { name, line, create } of logs.append) {
      const log = this.logs.get(name);
      if (log) log.push(line);
      else if (create) this.logs.set(name, [line]);
    }
    return { ok: true, rejected: [] };
  }

  /**
   * Atomic compare-and-swap update
   */
  compareAndSwap(
    name: string,
    expected: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<RefUpdateResult> {
    return this.exclusive(async () => {
      const r = await this.applyBatch([{ name, old: expected ?? null, new: newValue }]);
      if (r.ok) return { success: true, previousValue: expected };
      return {
        success: false,
        previousValue: (await this.resolve(name))?.objectId,
        errorMessage: r.rejected.map((x) => `${x.name}: ${x.reason}`).join(", "),
      };
    });
  }

  /**
   * Initialize storage structure (no-op for in-memory)
   */
  /** The reflog of `name` (written by `batch`), or undefined if it has none. */
  async getReflog(name: string): Promise<ReflogReader | undefined> {
    const log = this.logs.get(name);
    return log ? createReflogReaderOf(log) : undefined;
  }

  async initialize(): Promise<void> {
    // No initialization needed for in-memory store
  }

  /**
   * Perform implementation-specific optimizations (no-op for in-memory)
   */
  async optimize(): Promise<void> {
    // No optimization needed for in-memory store
  }

  /**
   * Clear all refs (for testing)
   */
  clear(): void {
    this.refs.clear();
  }
}

/**
 * Create a new in-memory Refs instance
 *
 * @returns MemoryRefs instance
 */
export function createMemoryRefs(): Refs {
  return new MemoryRefs();
}
