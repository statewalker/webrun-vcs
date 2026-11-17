/**
 * A map that keeps its keys in insertion order with a constant-time oldest entry, for FIFO
 * and LRU caches.
 *
 * ```typescript
 * const cache = new OrderedMap<string, Uint8Array>();
 * cache.set(id, bytes);
 * cache.touch(id); // most recent again (LRU)
 * while (cache.size > 512) cache.deleteOldest();
 * ```
 *
 * A plain `Map` keeps insertion order too, but finding its oldest key
 * (`map.keys().next()`) walks over the slots of every key deleted since the table was last
 * rebuilt: a cache that evicts one entry per insert pays for up to its whole capacity on each
 * eviction (thousands of slots, microseconds per insert). Here the entries are also linked in
 * order, so the oldest is at hand. The order is the one a `Map` would have: `set` of a key
 * already present keeps its place, `touch` moves it to the end (as `delete` then `set`).
 * Iterating while the map changes behaves as a `Map` does: deleting the current entry (or any
 * other) does not end the walk, an entry deleted before it is reached is not visited, and an
 * entry set or touched meanwhile is visited (again) at the end.
 */
export class OrderedMap<K, V> {
  private readonly map = new Map<K, OrderedNode<K, V>>();
  /** oldest first */
  private head: OrderedNode<K, V> | undefined;
  private tail: OrderedNode<K, V> | undefined;
  /** Stamps the appends and removals: the list is in increasing `seq` order */
  private clock = 0;
  /** Bumped by `clear`: a walk in progress resumes after its last entry */
  private generation = 0;

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** The value of `key`, without changing its place. */
  get(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  /** The value of `key`, which becomes the most recent entry. */
  touch(key: K): V | undefined {
    const node = this.map.get(key);
    if (!node) return undefined;
    if (node !== this.tail) {
      this.unlink(node);
      this.append(node);
    } else {
      // last already: newer still, so a walk standing on it visits it again (as a Map)
      node.seq = ++this.clock;
    }
    return node.value;
  }

  /** Sets `key`: a new key is the most recent entry, a key already present keeps its place. */
  set(key: K, value: V): this {
    const node = this.map.get(key);
    if (node) {
      node.value = value;
      return this;
    }
    const added: OrderedNode<K, V> = {
      key,
      value,
      prev: undefined,
      next: undefined,
      seq: 0,
      removedAt: 0,
    };
    this.map.set(key, added);
    this.append(added);
    return this;
  }

  delete(key: K): boolean {
    const node = this.map.get(key);
    if (!node) return false;
    this.map.delete(key);
    this.remove(node);
    return true;
  }

  /** The oldest key (the least recently set or touched), undefined when empty. */
  oldestKey(): K | undefined {
    return this.head?.key;
  }

  /** The oldest value, undefined when empty. */
  oldestValue(): V | undefined {
    return this.head?.value;
  }

  /** Removes the oldest entry: its key, undefined when empty. */
  deleteOldest(): K | undefined {
    const node = this.head;
    if (!node) return undefined;
    this.map.delete(node.key);
    this.remove(node);
    return node.key;
  }

  clear(): void {
    this.generation++;
    this.map.clear();
    this.head = undefined;
    this.tail = undefined;
  }

  /** The keys, oldest first. */
  *keys(): IterableIterator<K> {
    for (const n of this.walk()) yield n.key;
  }

  /** The values, oldest first. */
  *values(): IterableIterator<V> {
    for (const n of this.walk()) yield n.value;
  }

  private *walk(): Generator<OrderedNode<K, V>> {
    let n = this.head;
    while (n) {
      const seq = n.seq;
      const generation = this.generation;
      yield n;
      n = this.after(n, seq, generation);
    }
  }

  /**
   * The entry a walk visits after `n` (stamped `seq` when it was visited): its successor when
   * `n` is still in place; after a removal, the first live entry along the links the removed
   * entries kept; otherwise the oldest live entry newer than `seq`.
   */
  private after(
    n: OrderedNode<K, V>,
    seq: number,
    generation: number,
  ): OrderedNode<K, V> | undefined {
    if (generation === this.generation && n.seq === seq) {
      if (!n.removedAt) return n.next;
      // an entry in place since `limit` (removed then, or still live) follows on
      let m = n.next;
      let limit = n.removedAt;
      while (m && m.seq <= limit) {
        if (!m.removedAt) return m;
        limit = m.removedAt;
        m = m.next;
      }
    }
    let t = this.tail;
    if (!t || t.seq <= seq) return undefined;
    while (t.prev && t.prev.seq > seq) t = t.prev;
    return t;
  }

  /** Unlinks a deleted entry; it keeps its successor for a walk standing on it. */
  private remove(node: OrderedNode<K, V>): void {
    const next = node.next;
    this.unlink(node);
    node.next = next;
    node.removedAt = ++this.clock;
  }

  private append(node: OrderedNode<K, V>): void {
    node.seq = ++this.clock;
    node.prev = this.tail;
    node.next = undefined;
    if (this.tail) this.tail.next = node;
    else this.head = node;
    this.tail = node;
  }

  private unlink(node: OrderedNode<K, V>): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = undefined;
    node.next = undefined;
  }
}

interface OrderedNode<K, V> {
  readonly key: K;
  value: V;
  prev: OrderedNode<K, V> | undefined;
  next: OrderedNode<K, V> | undefined;
  /** When it was appended (set, or moved last by touch) */
  seq: number;
  /** When it was deleted (0: live) */
  removedAt: number;
}
