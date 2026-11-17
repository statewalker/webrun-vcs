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
 */
export class OrderedMap<K, V> {
  private readonly map = new Map<K, OrderedNode<K, V>>();
  /** oldest first */
  private head: OrderedNode<K, V> | undefined;
  private tail: OrderedNode<K, V> | undefined;

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
    const added: OrderedNode<K, V> = { key, value, prev: undefined, next: undefined };
    this.map.set(key, added);
    this.append(added);
    return this;
  }

  delete(key: K): boolean {
    const node = this.map.get(key);
    if (!node) return false;
    this.map.delete(key);
    this.unlink(node);
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
    this.unlink(node);
    return node.key;
  }

  clear(): void {
    this.map.clear();
    this.head = undefined;
    this.tail = undefined;
  }

  /** The keys, oldest first. */
  *keys(): IterableIterator<K> {
    for (let n = this.head; n; n = n.next) yield n.key;
  }

  /** The values, oldest first. */
  *values(): IterableIterator<V> {
    for (let n = this.head; n; n = n.next) yield n.value;
  }

  private append(node: OrderedNode<K, V>): void {
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
}
