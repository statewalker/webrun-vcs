/**
 * In-memory RefStore implementation
 *
 * Provides a pure in-memory reference storage for testing and ephemeral operations.
 * No persistence - data is lost when the instance is garbage collected.
 */

import type { ObjectId } from "../../common/id/index.js";
import type { Ref, SymbolicRef } from "./ref-types.js";
import { RefStorage } from "./ref-types.js";
import type { Refs, RefUpdateResult } from "./refs.js";

/**
 * Maximum depth for following symbolic refs to prevent infinite loops.
 */
const MAX_SYMBOLIC_REF_DEPTH = 100;

/**
 * Internal storage entry - either a direct ref or symbolic ref
 */
type RefEntry =
  | { type: "direct"; objectId: ObjectId; peeledObjectId?: ObjectId }
  | { type: "symbolic"; target: string };

/**
 * In-memory RefStore implementation.
 */
export class MemoryRefStore implements Refs {
  private refs = new Map<string, RefEntry>();

  /**
   * Read a ref by exact name.
   */
  async get(refName: string): Promise<Ref | SymbolicRef | undefined> {
    const entry = this.refs.get(refName);
    if (!entry) {
      return undefined;
    }

    if (entry.type === "symbolic") {
      return {
        name: refName,
        target: entry.target,
        storage: RefStorage.LOOSE,
      } as SymbolicRef;
    }

    return {
      name: refName,
      objectId: entry.objectId,
      storage: RefStorage.LOOSE,
      peeled: entry.peeledObjectId !== undefined,
      peeledObjectId: entry.peeledObjectId,
    } as Ref;
  }

  /**
   * Resolve a ref to its final object ID (follows symbolic refs).
   */
  async resolve(refName: string): Promise<Ref | undefined> {
    let current = refName;
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
   * Check if a ref exists.
   */
  async has(refName: string): Promise<boolean> {
    return this.refs.has(refName);
  }

  /**
   * List all refs matching a prefix.
   */
  async *list(prefix?: string): AsyncIterable<Ref | SymbolicRef> {
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
   * Set a ref to point to an object ID.
   */
  async set(refName: string, objectId: ObjectId): Promise<void> {
    this.refs.set(refName, { type: "direct", objectId });
  }

  /**
   * Set a symbolic ref.
   */
  async setSymbolic(refName: string, target: string): Promise<void> {
    this.refs.set(refName, { type: "symbolic", target });
  }

  /**
   * Remove a ref.
   */
  async remove(refName: string): Promise<boolean> {
    return this.refs.delete(refName);
  }

  /**
   * Compare-and-swap update (for concurrent safety).
   */
  async compareAndSwap(
    refName: string,
    expectedOld: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<RefUpdateResult> {
    const resolved = await this.resolve(refName);
    const currentValue = resolved?.objectId;

    if (currentValue !== expectedOld) {
      return {
        success: false,
        previousValue: currentValue,
        errorMessage: expectedOld
          ? `Expected ${expectedOld}, found ${currentValue ?? "nothing"}`
          : `Ref already exists with value ${currentValue}`,
      };
    }

    await this.set(refName, newValue);
    return {
      success: true,
      previousValue: expectedOld,
    };
  }

  /**
   * Initialize storage structure (no-op for in-memory).
   */
  async initialize(): Promise<void> {
    // No initialization needed for in-memory store
  }

  /**
   * Perform implementation-specific optimizations (no-op for in-memory).
   */
  async optimize(): Promise<void> {
    // No optimization needed for in-memory store
  }
}
