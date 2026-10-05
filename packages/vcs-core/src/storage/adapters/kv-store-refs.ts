/**
 * Adapter: `@statewalker/webrun-storage` {@link KvStore} → vcs-core {@link Refs}.
 *
 * Stores each ref as `name → utf8(objectId)` — the SAME encoding the storage
 * `refStore` facade uses — so a ref written through the external `RefStore`
 * surface is read back here, and `compareAndSwap` maps straight onto the KV's
 * atomic {@link KvStore.cas}. This is the refs seam that lets ancestry/gc
 * reachability read the refs a caller sets.
 *
 * Direct refs only. Symbolic refs and reflogs are deferred (see below).
 */

import type { KvStore } from "@statewalker/webrun-storage";
import type { ObjectId } from "../../common/id/index.js";
import type { Ref } from "../../history/refs/ref-types.js";
import { RefStorage } from "../../history/refs/ref-types.js";
import type { ReflogReader } from "../../history/refs/reflog-types.js";
import type { RefEntry, Refs, RefUpdateResult, RefValue } from "../../history/refs/refs.js";

/** Build a {@link Refs} over a {@link KvStore}, storing object ids as UTF-8 bytes. */
export function kvStoreRefs(kv: KvStore): Refs {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const encode = (id: ObjectId): Uint8Array => encoder.encode(id);
  const encodeMaybe = (id: ObjectId | undefined): Uint8Array | undefined =>
    id === undefined ? undefined : encode(id);

  const directRef = (name: string, objectId: ObjectId): Ref => ({
    name,
    objectId,
    storage: RefStorage.LOOSE,
    peeled: false,
  });

  const readId = async (name: string): Promise<ObjectId | undefined> => {
    const value = await kv.get(name);
    return value === undefined ? undefined : decoder.decode(value);
  };

  return {
    async get(name: string): Promise<RefValue | undefined> {
      const id = await readId(name);
      return id === undefined ? undefined : directRef(name, id);
    },

    async resolve(name: string): Promise<Ref | undefined> {
      const id = await readId(name);
      return id === undefined ? undefined : directRef(name, id);
    },

    async has(name: string): Promise<boolean> {
      return (await kv.get(name)) !== undefined;
    },

    async *list(prefix?: string): AsyncIterable<RefEntry> {
      for await (const { key, value } of kv.list(prefix)) {
        yield directRef(key, decoder.decode(value));
      }
    },

    async set(name: string, objectId: ObjectId): Promise<void> {
      await kv.put(name, encode(objectId));
    },

    setSymbolic(): Promise<void> {
      // Symbolic refs are deferred: the KV holds direct object ids only.
      return Promise.reject(new Error("kvStoreRefs: symbolic refs are not supported"));
    },

    async remove(name: string): Promise<boolean> {
      return kv.remove(name);
    },

    async compareAndSwap(
      name: string,
      expected: ObjectId | undefined,
      newValue: ObjectId,
    ): Promise<RefUpdateResult> {
      const ok = await kv.cas(name, encodeMaybe(expected), encode(newValue));
      if (ok) return { success: true, previousValue: expected };
      const current = await readId(name);
      return {
        success: false,
        previousValue: current,
        errorMessage: expected
          ? `Expected ${expected}, found ${current ?? "nothing"}`
          : `Ref already exists with value ${current}`,
      };
    },

    // Reflog is deferred — the KV seam keeps no ref history.
    getReflog(): Promise<ReflogReader | undefined> {
      return Promise.resolve(undefined);
    },
  };
}
