/**
 * Flag bits per object id, in an open-addressing table over the raw 20-byte ids: a walk that
 * looks up every entry of every tree asks it about ids read from tree bytes, which it can test
 * without building their hex strings (git's object hash table, `lookup_object`, keyed the same
 * way by the leading bytes of the id).
 *
 * @example
 * ```typescript
 * const flags = new ObjectIdFlags();
 * flags.add("4b825dc642cb6eb9a060e54bf8d69288fbee4904", 1);
 * flags.getAt(treeBytes, idOffset); // the bits of the id stored there, 0 if none
 * ```
 */
export class ObjectIdFlags {
  private ids: Uint8Array;
  private bits: Uint8Array;
  private used: Uint8Array;
  private mask: number;
  private count = 0;
  private readonly scratch = new Uint8Array(20);
  /** strings that are not lowercase ids, kept as they are */
  private readonly others = new Map<string, number>();

  constructor(capacity = 1024) {
    let n = 1024;
    while (n < capacity * 2) n *= 2;
    this.ids = new Uint8Array(n * 20);
    this.bits = new Uint8Array(n);
    this.used = new Uint8Array(n);
    this.mask = n - 1;
  }

  /** Ids with a slot (any bits, zero included once added). */
  get size(): number {
    return this.count + this.others.size;
  }

  /** The bits of `id` (40 hex digits), 0 when it has none. */
  get(id: string): number {
    const bytes = this.parse(id);
    if (!bytes) return this.others.get(id) ?? 0;
    const slot = this.find(bytes, 0);
    return slot < 0 ? 0 : (this.bits[slot] as number);
  }

  /** The bits of the 20-byte id at `buf[at..at + 20)`. */
  getAt(buf: Uint8Array, at: number): number {
    const slot = this.find(buf, at);
    return slot < 0 ? 0 : (this.bits[slot] as number);
  }

  /** Sets `bits` on `id` (40 hex digits), keeping the ones it has. */
  add(id: string, bits: number): void {
    const bytes = this.parse(id);
    if (bytes) this.addAt(bytes, 0, bits);
    else this.others.set(id, (this.others.get(id) ?? 0) | bits);
  }

  /** Sets `bits` on the 20-byte id at `buf[at..at + 20)`. */
  addAt(buf: Uint8Array, at: number, bits: number): void {
    const found = this.find(buf, at);
    if (found >= 0) {
      this.bits[found] = (this.bits[found] as number) | bits;
      return;
    }
    if ((this.count + 1) * 2 > this.mask + 1) {
      this.grow();
    }
    const slot = this.free(buf, at);
    this.ids.set(buf.subarray(at, at + 20), slot * 20);
    this.used[slot] = 1;
    this.bits[slot] = bits;
    this.count++;
  }

  private hash(buf: Uint8Array, at: number): number {
    return (
      ((buf[at] as number) |
        ((buf[at + 1] as number) << 8) |
        ((buf[at + 2] as number) << 16) |
        ((buf[at + 3] as number) << 24)) &
      this.mask
    );
  }

  private find(buf: Uint8Array, at: number): number {
    const ids = this.ids;
    for (let slot = this.hash(buf, at); this.used[slot]; slot = (slot + 1) & this.mask) {
      const o = slot * 20;
      let k = 0;
      while (k < 20 && ids[o + k] === buf[at + k]) k++;
      if (k === 20) return slot;
    }
    return -1;
  }

  private free(buf: Uint8Array, at: number): number {
    let slot = this.hash(buf, at);
    while (this.used[slot]) slot = (slot + 1) & this.mask;
    return slot;
  }

  private grow() {
    const { ids, bits, used } = this;
    const n = (this.mask + 1) * 2;
    this.ids = new Uint8Array(n * 20);
    this.bits = new Uint8Array(n);
    this.used = new Uint8Array(n);
    this.mask = n - 1;
    for (let s = 0; s < used.length; s++) {
      if (!used[s]) continue;
      const slot = this.free(ids, s * 20);
      this.ids.set(ids.subarray(s * 20, s * 20 + 20), slot * 20);
      this.used[slot] = 1;
      this.bits[slot] = bits[s] as number;
    }
  }

  /** `id`'s bytes in the scratch buffer, or null when it is not 40 lowercase hex digits. */
  private parse(id: string): Uint8Array | null {
    const out = this.scratch;
    if (id.length !== 40) return null;
    for (let i = 0; i < 20; i++) {
      const hi = hexValue(id.charCodeAt(2 * i));
      const lo = hexValue(id.charCodeAt(2 * i + 1));
      if (hi < 0 || lo < 0) return null;
      out[i] = (hi << 4) | lo;
    }
    return out;
  }
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}
