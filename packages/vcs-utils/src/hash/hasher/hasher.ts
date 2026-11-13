/**
 * Incremental SHA-1 on @noble/hashes. No `node:` imports, so the same module
 * runs in browsers, workers, Node and Durable Objects. SHA-256 (Git LFS) and
 * BLAKE3 (Xet) join this module, behind the same `Hasher`, with the packages
 * that use them.
 */
import { sha1 } from "@noble/hashes/legacy.js";

/**
 * An incremental hash. Feed bytes with `update`, read the result once with
 * `digest`. `clone` copies the current state, so a common prefix is hashed once.
 * A hasher is spent after `digest`: every later call throws.
 */
export interface Hasher {
  update(data: Uint8Array): Hasher;
  digest(): Uint8Array;
  clone(): Hasher;
}

/** The part of a noble hash this module relies on. */
interface NobleHash {
  update(data: Uint8Array): unknown;
  digest(): Uint8Array;
  clone(): NobleHash;
}

function wrap(h: NobleHash): Hasher {
  let spent = false;
  const live = () => {
    if (spent)
      throw new Error("Hasher already digested; clone() before digest() to keep the state");
  };
  const self: Hasher = {
    update(data) {
      live();
      h.update(data);
      return self;
    },
    digest() {
      live();
      spent = true;
      return h.digest();
    },
    clone() {
      live();
      return wrap(h.clone());
    },
  };
  return self;
}

/** SHA-1, 20-byte digest. */
export function createSha1(): Hasher {
  const h: NobleHash = sha1.create();
  return wrap(h);
}
