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

export class ObjectTable {
  /** Ids by object number, in creation order. */
  readonly ids: string[] = [];
  private types = new Uint8Array(1024);
  private flagsOf = new Uint8Array(1024);
  /** Object numbers by slot, -1 for an empty slot. */
  private slots = new Int32Array(0);
  private readonly byId = new Map<string, number>();
  readonly links = new Map<number, ObjectLinks>();

  get size(): number {
    return this.ids.length;
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
    const n = this.byId.get(id);
    if (n === undefined) return -1;
    const size = this.slots.length;
    const first = slotOf(id, size);
    let i = first;
    while (this.slots[i] !== n) {
      i++;
      if (i === size) i = 0;
    }
    if (i !== first) {
      this.slots[i] = this.slots[first] as number;
      this.slots[first] = n;
    }
    return n;
  }

  /** git's `create_object`. */
  create(id: string, type: ObjType): number {
    const n = this.ids.length;
    if (this.slots.length - 1 <= n * 2) this.grow();
    if (n >= this.types.length) {
      const types = new Uint8Array(this.types.length * 2);
      types.set(this.types);
      this.types = types;
      const flags = new Uint8Array(this.flagsOf.length * 2);
      flags.set(this.flagsOf);
      this.flagsOf = flags;
    }
    this.ids.push(id);
    this.byId.set(id, n);
    this.types[n] = type;
    this.insert(n, this.slots);
    return n;
  }

  /**
   * git's `lookup_<type>`: the object, created with that type if new, or `{ error }` when it
   * exists with another type (`object_as_type`'s message).
   */
  lookupTyped(id: string, type: ObjType): number | { error: string } {
    const n = this.lookup(id);
    if (n < 0) return this.create(id, type);
    const have = this.types[n] as ObjType;
    if (have === type) return n;
    if (have === OBJ_NONE) {
      this.types[n] = type;
      return n;
    }
    return { error: `object ${id} is a ${TYPE_NAME[have]}, not a ${TYPE_NAME[type]}` };
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

  private grow(): void {
    const old = this.slots;
    const size = old.length < 32 ? 32 : old.length * 2;
    const slots = new Int32Array(size).fill(-1);
    for (const n of old) if (n >= 0) this.insert(n, slots);
    this.slots = slots;
  }

  private insert(n: number, slots: Int32Array): void {
    const size = slots.length;
    let j = slotOf(this.ids[n] as string, size);
    while ((slots[j] as number) >= 0) {
      j++;
      if (j >= size) j = 0;
    }
    slots[j] = n;
  }
}

/** git's `hash_obj`: the id's first four bytes as a little-endian unsigned int, masked. */
function slotOf(id: string, size: number): number {
  const b0 = parseInt(id.slice(0, 2), 16);
  const b1 = parseInt(id.slice(2, 4), 16);
  const b2 = parseInt(id.slice(4, 6), 16);
  const b3 = parseInt(id.slice(6, 8), 16);
  return ((b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0) & (size - 1);
}
