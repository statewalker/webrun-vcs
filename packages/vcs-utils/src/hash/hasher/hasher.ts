/**
 * Incremental hashers on @noble/hashes: SHA-1 for git object ids, SHA-256 for
 * Git LFS, BLAKE3 for Hugging Face Xet. No `node:` imports, so the same module
 * runs in browsers, workers, Node and Durable Objects.
 */
import { blake3 } from "@noble/hashes/blake3.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * An incremental hash. Feed bytes with `update`, read the result once with
 * `digest`. `clone` copies the current state, so a common prefix is hashed once.
 */
export interface Hasher {
  update(data: Uint8Array): Hasher;
  digest(): Uint8Array;
  clone(): Hasher;
}

export interface Blake3Options {
  /** 32-byte key: keyed-hash mode (what Xet uses for chunk and Merkle hashes). */
  key?: Uint8Array;
  /** Context bytes: derive-key mode. */
  context?: Uint8Array;
  /** Output length in bytes (extendable output); 32 by default. */
  dkLen?: number;
}

interface NobleHash {
  update(data: Uint8Array): unknown;
  digest(): Uint8Array;
  clone(): NobleHash;
}

function wrap(h: NobleHash): Hasher {
  const self: Hasher = {
    update(data) {
      h.update(data);
      return self;
    },
    digest: () => h.digest(),
    clone: () => wrap(h.clone()),
  };
  return self;
}

/** SHA-1, 20-byte digest. */
export function createSha1(): Hasher {
  return wrap(sha1.create() as unknown as NobleHash);
}

/** SHA-256, 32-byte digest. */
export function createSha256(): Hasher {
  return wrap(sha256.create() as unknown as NobleHash);
}

/** BLAKE3: plain, keyed (`key`) or derive-key (`context`). */
export function createBlake3(options: Blake3Options = {}): Hasher {
  return wrap(blake3.create(options) as unknown as NobleHash);
}
