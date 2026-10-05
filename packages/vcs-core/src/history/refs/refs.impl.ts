/**
 * Refs implementation adapters
 *
 * This module provides:
 * 1. RefsAdapter - wraps existing RefStore implementations to implement new Refs interface
 * 2. MemoryRefs - native in-memory implementation of Refs
 *
 * The adapter pattern allows gradual migration from old RefStore to new Refs.
 */

import type { ObjectId } from "../../common/id/index.js";
import type { RefStore } from "./ref-store.js";
import type { Ref, SymbolicRef } from "./ref-types.js";
import { RefStorage } from "./ref-types.js";
import type { ReflogReader } from "./reflog-types.js";
import type { RefEntry, Refs, RefUpdateResult, RefValue } from "./refs.js";

/**
 * Maximum depth for following symbolic refs to prevent infinite loops.
 */
const MAX_SYMBOLIC_REF_DEPTH = 100;

/**
 * Adapter that wraps existing RefStore to implement new Refs interface
 *
 * This is a temporary adapter during migration. Eventually, RefStore
 * implementations can be updated to implement Refs directly.
 */
export class RefsAdapter implements Refs {
  constructor(private readonly refStore: RefStore) {}

  get(name: string): Promise<RefValue | undefined> {
    return this.refStore.get(name);
  }

  resolve(name: string): Promise<Ref | undefined> {
    return this.refStore.resolve(name);
  }

  has(name: string): Promise<boolean> {
    return this.refStore.has(name);
  }

  list(prefix?: string): AsyncIterable<RefEntry> {
    return this.refStore.list(prefix);
  }

  set(name: string, objectId: ObjectId): Promise<void> {
    return this.refStore.set(name, objectId);
  }

  setSymbolic(name: string, target: string): Promise<void> {
    return this.refStore.setSymbolic(name, target);
  }

  // Adapt delete() to remove()
  remove(name: string): Promise<boolean> {
    return this.refStore.delete(name);
  }

  compareAndSwap(
    name: string,
    expected: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<RefUpdateResult> {
    return this.refStore.compareAndSwap(name, expected, newValue);
  }

  initialize(): Promise<void> {
    if (this.refStore.initialize) {
      return this.refStore.initialize();
    }
    return Promise.resolve();
  }

  optimize(): Promise<void> {
    if (this.refStore.optimize) {
      return this.refStore.optimize();
    }
    return Promise.resolve();
  }

  getReflog(name: string): Promise<ReflogReader | undefined> {
    if (this.refStore.getReflog) {
      return this.refStore.getReflog(name);
    }
    return Promise.resolve(undefined);
  }

  packRefs(refNames: string[], options?: { all?: boolean; deleteLoose?: boolean }): Promise<void> {
    if (this.refStore.packRefs) {
      return this.refStore.packRefs(refNames, options);
    }
    return Promise.resolve();
  }
}

/**
 * Internal storage entry - either a direct ref or symbolic ref
 */
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

  /**
   * Get a reference value
   */
  async get(name: string): Promise<RefValue | undefined> {
    const entry = this.refs.get(name);
    if (!entry) {
      return undefined;
    }

    if (entry.type === "symbolic") {
      return {
        name,
        target: entry.target,
        storage: RefStorage.LOOSE,
      } as SymbolicRef;
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
    for (const [name, entry] of this.refs) {
      if (prefix && !name.startsWith(prefix)) {
        continue;
      }

      if (entry.type === "symbolic") {
        yield {
          name,
          target: entry.target,
          storage: RefStorage.LOOSE,
        } as SymbolicRef;
      } else {
        yield {
          name,
          objectId: entry.objectId,
          storage: RefStorage.LOOSE,
          peeled: entry.peeledObjectId !== undefined,
          peeledObjectId: entry.peeledObjectId,
        } as Ref;
      }
    }
  }

  /**
   * Set a direct reference
   */
  async set(name: string, objectId: ObjectId): Promise<void> {
    this.refs.set(name, { type: "direct", objectId });
  }

  /**
   * Set a symbolic reference
   */
  async setSymbolic(name: string, target: string): Promise<void> {
    this.refs.set(name, { type: "symbolic", target });
  }

  /**
   * Remove a reference
   */
  async remove(name: string): Promise<boolean> {
    return this.refs.delete(name);
  }

  /**
   * Atomic compare-and-swap update
   */
  async compareAndSwap(
    name: string,
    expected: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<RefUpdateResult> {
    const resolved = await this.resolve(name);
    const currentValue = resolved?.objectId;

    if (currentValue !== expected) {
      return {
        success: false,
        previousValue: currentValue,
        errorMessage: expected
          ? `Expected ${expected}, found ${currentValue ?? "nothing"}`
          : `Ref already exists with value ${currentValue}`,
      };
    }

    await this.set(name, newValue);
    return {
      success: true,
      previousValue: expected,
    };
  }

  /**
   * Initialize storage structure (no-op for in-memory)
   */
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
 * Create a Refs instance from a RefStore (adapter pattern)
 *
 * @param refStore Existing RefStore implementation
 * @returns Refs instance that wraps the RefStore
 */
export function createRefsAdapter(refStore: RefStore): Refs {
  return new RefsAdapter(refStore);
}

/**
 * Create a new in-memory Refs instance
 *
 * @returns MemoryRefs instance
 */
export function createMemoryRefs(): Refs {
  return new MemoryRefs();
}
