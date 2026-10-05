/**
 * FNV-1a hash implementation
 *
 * A simple, fast non-cryptographic hash function.
 * Uses the FNV-1a algorithm with 32-bit output.
 */

/** FNV-1a offset basis (32-bit) */
const FNV_OFFSET_BASIS = 2166136261;

/** FNV-1a prime (32-bit) */
const FNV_PRIME = 16777619;

/**
 * Compute FNV-1a hash of a string
 *
 * @param content String to hash
 * @returns 8-character hexadecimal hash string
 */
export function fnv1aHash(content: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
