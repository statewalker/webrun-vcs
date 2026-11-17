/**
 * Small byte buffers carved from shared slabs, as Node's `Buffer.allocUnsafe` pool does.
 *
 * Each `new Uint8Array(n)` gets its own backing store outside the JavaScript heap, which
 * costs a microsecond or two (an allocation plus external-memory accounting for the
 * garbage collector): more than inflating a small commit. A read path that hands out one
 * small buffer per object (a rev-walk reads thousands) takes them from a slab instead.
 *
 * A buffer from a slab is a view: `bytes.buffer` is the slab, shared with other buffers,
 * and a buffer kept alive keeps its slab alive (at most `SLAB_SIZE` bytes). Only sizes up
 * to `SLAB_MAX` come from slabs; larger ones are allocated on their own. The bytes are
 * zeroed (a slab is never reused).
 */

/** Bytes per slab. */
const SLAB_SIZE = 32 * 1024;
/** Largest buffer taken from a slab. */
const SLAB_MAX = 2 * 1024;

let slab = new ArrayBuffer(SLAB_SIZE);
let used = 0;

/**
 * A zeroed buffer of `size` bytes: a view into a shared slab when small, else its own.
 *
 * @example
 * ```typescript
 * const out = allocBytes(header.size); // fill it, hand it out
 * ```
 */
export function allocBytes(size: number): Uint8Array {
  if (size > SLAB_MAX || size === 0) return new Uint8Array(size);
  if (used + size > SLAB_SIZE) {
    slab = new ArrayBuffer(SLAB_SIZE);
    used = 0;
  }
  const out = new Uint8Array(slab, used, size);
  // the next view starts 8-byte aligned (for views of wider element types over the same bytes)
  used += (size + 7) & ~7;
  return out;
}
