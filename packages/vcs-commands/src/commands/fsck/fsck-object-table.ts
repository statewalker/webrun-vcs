/**
 * The objects one fsck run knows, laid out as git's object hash (`object.c`): an open-addressing
 * table indexed by the first four bytes of the id (read as a little-endian `unsigned int`)
 * modulo a power-of-two size, at least 32, doubled whenever it would be half full, with linear
 * probing, and a found object moved to the slot its lookup started from.
 *
 * git prints `missing`, `dangling` and `unreachable` objects by walking this table slot by
 * slot, so the same layout gives the same order. Objects are created in the order git creates
 * them (as fsck scans and walks), so the layout matches git's as long as both see the same
 * lookups; where they differ (an object git looks up and this run does not), only objects that
 * collide on a slot can come out in another order.
 *
 * Per object only its type, flags and the few parsed fields fsck walks (a commit's tree and
 * parents, a tag's target and name) are kept, never its content.
 */

/** Object types as git numbers them (`OBJ_NONE` = 0). */
export const OBJ_NONE = 0;
export const OBJ_COMMIT = 1;
export const OBJ_TREE = 2;
export const OBJ_BLOB = 3;
export const OBJ_TAG = 4;
export type ObjType = 0 | 1 | 2 | 3 | 4;

export const TYPE_NAME = ["", "commit", "tree", "blob", "tag"] as const;

export function typeOf(name: string): ObjType {
  const i = TYPE_NAME.indexOf(name as (typeof TYPE_NAME)[number]);
  return (i < 1 ? OBJ_NONE : i) as ObjType;
}

/** builtin/fsck.c's flags */
export const REACHABLE = 0x1;
export const SEEN = 0x2;
export const HAS_OBJ = 0x4;
export const USED = 0x8;
/** `object.parsed` */
export const PARSED = 0x10;

/** What fsck keeps of a parsed commit or tag. */
export interface ObjectLinks {
  /** A commit's tree. */
  tree?: number;
  /** A commit's parents. */
  parents?: number[];
  /** A tag's target. */
  tagged?: number;
  /** A tag's name. */
  tag?: string;
}

const HEX = "0123456789abcdef";
/** Hex digit values by char code, -1 for a non-digit. */
const HEX_VALUE = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < 16; i++) t[HEX.charCodeAt(i)] = i;
  return t;
})();

/**
 * The table. Ids are kept as their 20 bytes, in one growing buffer by object number (not as
 * strings, nor in a second map): a lookup probes the slots and compares bytes, so a tree's
 * entries are looked up straight from the tree's bytes.
 */
export class ObjectTable {
  private n = 0;
  /** The ids' bytes, 20 per object number. */
  private raw = new Uint8Array(20 * 1024);
  /** Each id's first four bytes as git's `hash_obj` reads them. */
  private keys = new Int32Array(1024);
  private types = new Uint8Array(1024);
  private flagsOf = new Uint8Array(1024);
  /** Object numbers by slot, -1 for an empty slot. */
  private slots = new Int32Array(0);
  private readonly scratch = new Uint8Array(20);
  readonly links = new Map<number, ObjectLinks>();

  get size(): number {
    return this.n;
  }

  /** The id of object `n`, as hex. */
  id(n: number): string {
    const raw = this.raw;
    let out = "";
    for (let i = n * 20, end = i + 20; i < end; i++) {
      const b = raw[i] as number;
      out += HEX[b >> 4] + HEX[b & 15];
    }
    return out;
  }

  type(n: number): ObjType {
    return this.types[n] as ObjType;
  }

  setType(n: number, type: ObjType): void {
    this.types[n] = type;
  }

  flags(n: number): number {
    return this.flagsOf[n] as number;
  }

  addFlags(n: number, flags: number): void {
    this.flagsOf[n] = (this.flagsOf[n] as number) | flags;
  }

  clearFlags(n: number, flags: number): void {
    this.flagsOf[n] = (this.flagsOf[n] as number) & ~flags;
  }

  /** git's `lookup_object`: the object or -1, moved to the slot its probe started from. */
  lookup(id: string): number {
    const raw = this.parse(id);
    return raw ? this.lookupRaw(raw, 0) : -1;
  }

  /** `lookup` for the 20 id bytes at `at` in `buf`. */
  lookupRaw(buf: Uint8Array, at: number): number {
    const size = this.slots.length;
    if (size === 0) return -1;
    const key = keyOf(buf, at);
    const first = (key >>> 0) & (size - 1);
    const raw = this.raw;
    const keys = this.keys;
    const slots = this.slots;
    let i = first;
    let n: number;
    for (;;) {
      n = slots[i] as number;
      if (n < 0) return -1;
      if (keys[n] === key) {
        let k = 4;
        const o = n * 20;
        while (k < 20 && raw[o + k] === buf[at + k]) k++;
        if (k === 20) break;
      }
      i++;
      if (i === size) i = 0;
    }
    if (i !== first) {
      slots[i] = slots[first] as number;
      slots[first] = n;
    }
    return n;
  }

  /** git's `create_object`. */
  create(id: string, type: ObjType): number {
    return this.createRaw(this.parseOrThrow(id), 0, type);
  }

  /** `create` for the 20 id bytes at `at` in `buf`. */
  createRaw(buf: Uint8Array, at: number, type: ObjType): number {
    const n = this.n;
    if (this.slots.length - 1 <= n * 2) this.grow();
    if (n >= this.types.length) {
      const cap = this.types.length * 2;
      const raw = new Uint8Array(cap * 20);
      raw.set(this.raw);
      this.raw = raw;
      const keys = new Int32Array(cap);
      keys.set(this.keys);
      this.keys = keys;
      const types = new Uint8Array(cap);
      types.set(this.types);
      this.types = types;
      const flags = new Uint8Array(cap);
      flags.set(this.flagsOf);
      this.flagsOf = flags;
    }
    this.raw.set(buf.subarray(at, at + 20), n * 20);
    this.keys[n] = keyOf(buf, at);
    this.types[n] = type;
    this.n = n + 1;
    this.insert(n, this.slots);
    return n;
  }

  /**
   * git's `lookup_<type>`: the object, created with that type if new, or `{ error }` when it
   * exists with another type (`object_as_type`'s message).
   */
  lookupTyped(id: string, type: ObjType): number | { error: string } {
    return this.lookupTypedRaw(this.parseOrThrow(id), 0, type);
  }

  /** `lookupTyped` for the 20 id bytes at `at` in `buf`. */
  lookupTypedRaw(buf: Uint8Array, at: number, type: ObjType): number | { error: string } {
    const n = this.lookupRaw(buf, at);
    if (n < 0) return this.createRaw(buf, at, type);
    const have = this.types[n] as ObjType;
    if (have === type) return n;
    if (have === OBJ_NONE) {
      this.types[n] = type;
      return n;
    }
    return {
      error: `object ${this.id(n)} is a ${TYPE_NAME[have]}, not a ${TYPE_NAME[type]}`,
    };
  }

  /** git's `lookup_unknown_object`. */
  lookupUnknown(id: string): number {
    const n = this.lookup(id);
    return n >= 0 ? n : this.create(id, OBJ_NONE);
  }

  /** Object numbers in slot order (git's `get_indexed_object` loop). */
  *inSlotOrder(): Iterable<number> {
    for (const n of this.slots) if (n >= 0) yield n;
  }

  /** The bytes of a 40-digit lowercase hex id, in a scratch buffer; undefined if not one. */
  private parse(id: string): Uint8Array | undefined {
    if (id.length !== 40) return undefined;
    const out = this.scratch;
    for (let i = 0; i < 20; i++) {
      const hi = HEX_VALUE[id.charCodeAt(2 * i)] ?? -1;
      const lo = HEX_VALUE[id.charCodeAt(2 * i + 1)] ?? -1;
      if (hi < 0 || lo < 0) return undefined;
      out[i] = (hi << 4) | lo;
    }
    return out;
  }

  private parseOrThrow(id: string): Uint8Array {
    const raw = this.parse(id);
    if (!raw) throw new Error(`not an object id: ${id}`);
    return raw;
  }

  private grow(): void {
    const old = this.slots;
    const size = old.length < 32 ? 32 : old.length * 2;
    const slots = new Int32Array(size).fill(-1);
    for (const n of old) if (n >= 0) this.insert(n, slots);
    this.slots = slots;
  }

  private insert(n: number, slots: Int32Array): void {
    const size = slots.length;
    let j = ((this.keys[n] as number) >>> 0) & (size - 1);
    while ((slots[j] as number) >= 0) {
      j++;
      if (j >= size) j = 0;
    }
    slots[j] = n;
  }
}

/** git's `hash_obj` before the mask: the id's first four bytes as a little-endian int. */
function keyOf(buf: Uint8Array, at: number): number {
  return (
    (buf[at] as number) |
    ((buf[at + 1] as number) << 8) |
    ((buf[at + 2] as number) << 16) |
    ((buf[at + 3] as number) << 24)
  );
}
