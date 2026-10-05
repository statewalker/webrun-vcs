/**
 * KV-based Refs implementation
 *
 * Stores Git references using a key-value backend with JSON serialization.
 */

import type { ObjectId, Ref, Refs, RefUpdateResult, SymbolicRef } from "@statewalker/vcs-core";
import { RefStorage } from "@statewalker/vcs-core";
import type { KVStore } from "./kv-store.js";

/**
 * Key prefix for ref data
 */
const REF_PREFIX = "ref:";

/**
 * Maximum depth for following symbolic refs to prevent infinite loops.
 */
const MAX_SYMBOLIC_REF_DEPTH = 100;

/**
 * Serialized ref format
 */
interface SerializedRef {
  // Direct ref
  oid?: string; // objectId
  p?: string; // peeled
  // Symbolic ref
  t?: string; // target
}

/**
 * Text encoder/decoder for JSON serialization
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * KV-based Refs implementation.
 */
export class KVRefStore implements Refs {
  constructor(private kv: KVStore) {}

  /**
   * Read a ref by exact name.
   */
  async get(refName: string): Promise<Ref | SymbolicRef | undefined> {
    const data = await this.kv.get(`${REF_PREFIX}${refName}`);
    if (!data) {
      return undefined;
    }

    const s: SerializedRef = JSON.parse(decoder.decode(data));

    if (s.t != null) {
      return {
        name: refName,
        target: s.t,
        storage: RefStorage.LOOSE,
      } as SymbolicRef;
    }

    return {
      name: refName,
      objectId: s.oid,
      storage: RefStorage.LOOSE,
      peeled: s.p != null,
      peeledObjectId: s.p,
    } as Ref;
  }

  /**
   * Resolve a ref to its final object ID (follows symbolic refs).
   */
  async resolve(refName: string): Promise<Ref | undefined> {
    let current = refName;
    let depth = 0;

    while (depth < MAX_SYMBOLIC_REF_DEPTH) {
      const data = await this.kv.get(`${REF_PREFIX}${current}`);
      if (!data) {
        return undefined;
      }

      const s: SerializedRef = JSON.parse(decoder.decode(data));

      if (s.t == null) {
        // Direct ref
        return {
          name: current,
          objectId: s.oid,
          storage: RefStorage.LOOSE,
          peeled: s.p != null,
          peeledObjectId: s.p,
        } as Ref;
      }

      // Follow symbolic ref
      current = s.t;
      depth++;
    }

    throw new Error(`Symbolic ref chain too deep (> ${MAX_SYMBOLIC_REF_DEPTH})`);
  }

  /**
   * Check if a ref exists.
   */
  async has(refName: string): Promise<boolean> {
    return this.kv.has(`${REF_PREFIX}${refName}`);
  }

  /**
   * List all refs matching a prefix.
   */
  async *list(prefix?: string): AsyncIterable<Ref | SymbolicRef> {
    const fullPrefix = `${REF_PREFIX}${prefix || ""}`;

    for await (const key of this.kv.list(REF_PREFIX)) {
      if (prefix && !key.startsWith(fullPrefix)) {
        continue;
      }

      const refName = key.slice(REF_PREFIX.length);
      const ref = await this.get(refName);
      if (ref) {
        yield ref;
      }
    }
  }

  /**
   * Set a ref to point to an object ID.
   */
  async set(refName: string, objectId: ObjectId): Promise<void> {
    const serialized: SerializedRef = { oid: objectId };
    await this.kv.set(`${REF_PREFIX}${refName}`, encoder.encode(JSON.stringify(serialized)));
  }

  /**
   * Set a symbolic ref.
   */
  async setSymbolic(refName: string, target: string): Promise<void> {
    const serialized: SerializedRef = { t: target };
    await this.kv.set(`${REF_PREFIX}${refName}`, encoder.encode(JSON.stringify(serialized)));
  }

  /**
   * Remove a ref.
   */
  async remove(refName: string): Promise<boolean> {
    return this.kv.delete(`${REF_PREFIX}${refName}`);
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

    // Use KV compare-and-swap for atomicity
    const expected = expectedOld ? encoder.encode(JSON.stringify({ oid: expectedOld })) : undefined;
    const newData = encoder.encode(JSON.stringify({ oid: newValue }));

    const success = await this.kv.compareAndSwap(`${REF_PREFIX}${refName}`, expected, newData);

    if (success) {
      return {
        success: true,
        previousValue: expectedOld,
      };
    }

    // CAS failed, get current value for error message
    const current = await this.resolve(refName);
    return {
      success: false,
      previousValue: current?.objectId,
      errorMessage: "Concurrent modification detected",
    };
  }

  /**
   * Initialize storage structure (no-op for KV).
   */
  async initialize(): Promise<void> {
    // No initialization needed
  }

  /**
   * Perform implementation-specific optimizations (no-op for KV).
   */
  async optimize(): Promise<void> {
    // No optimization needed
  }
}
