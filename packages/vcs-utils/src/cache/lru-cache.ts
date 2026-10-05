/**
 * LRU (Least Recently Used) cache implementation with doubly-linked list
 *
 * Manages cached content with size and entry count limits,
 * evicting least recently used items when limits are exceeded.
 *
 * Uses a doubly-linked list for O(1) access order updates.
 */

/**
 * Cache entry node in the doubly-linked list
 */
interface CacheEntry<V> {
  /** Cached value */
  value: V;
  /** Size of the value in bytes */
  size: number;
  /** Timestamp of when entry was added/accessed */
  timestamp: number;
  /** Previous entry in the list (more recently used) */
  prev: CacheEntry<V> | null;
  /** Next entry in the list (less recently used) */
  next: CacheEntry<V> | null;
}

/**
 * LRU cache with generic key and value types
 *
 * Maintains both size and entry count limits, evicting oldest entries
 * when either limit is exceeded. Uses a doubly-linked list for efficient
 * access order tracking.
 *
 * @template K Key type
 * @template V Value type
 */
export class LRUCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>();
  private head: CacheEntry<V> | null = null; // Most recently used
  private tail: CacheEntry<V> | null = null; // Least recently used
  private totalSize = 0;
  private keyMap = new Map<CacheEntry<V>, K>(); // Reverse map for eviction

  /**
   * Create LRU cache with specified limits
   *
   * @param maxSize Maximum total size in bytes (default: 50MB)
   * @param maxEntries Maximum number of entries (default: 500)
   * @param sizeOf Optional function to calculate size of a value
   */
  constructor(
    private readonly maxSize = 50 * 1024 * 1024,
    private readonly maxEntries = 500,
    private readonly sizeOf?: (value: V) => number,
  ) {}

  /**
   * Check if key is in cache
   *
   * @param key Cache key
   * @returns True if cached
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Get cached value and mark as recently used
   *
   * @param key Cache key
   * @returns Cached value or undefined
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    // Move to front (most recently used)
    this.moveToFront(entry);

    return entry.value;
  }

  /**
   * Add value to cache
   *
   * @param key Cache key
   * @param value Value to cache
   */
  set(key: K, value: V): void {
    // Remove if already exists
    if (this.cache.has(key)) {
      this.delete(key);
    }

    // Calculate size
    const size = this.sizeOf ? this.sizeOf(value) : this.getDefaultSize(value);

    // Create new entry
    const entry: CacheEntry<V> = {
      value,
      size,
      timestamp: Date.now(),
      prev: null,
      next: null,
    };

    // Add to cache and maps
    this.cache.set(key, entry);
    this.keyMap.set(entry, key);
    this.totalSize += size;

    // Add to front of list
    this.addToFront(entry);

    // Evict if over limits
    this.enforceLimit();
  }

  /**
   * Remove entry from cache
   *
   * @param key Cache key
   * @returns True if entry was removed
   */
  delete(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    this.removeEntry(key, entry);
    return true;
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
    this.keyMap.clear();
    this.head = null;
    this.tail = null;
    this.totalSize = 0;
  }

  /**
   * Get current number of cached entries
   *
   * @returns Number of entries
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Get total size of cached content
   *
   * @returns Total size in bytes
   */
  getTotalSize(): number {
    return this.totalSize;
  }

  /**
   * Add entry to front of list (most recently used)
   */
  private addToFront(entry: CacheEntry<V>): void {
    entry.prev = null;
    entry.next = this.head;

    if (this.head) {
      this.head.prev = entry;
    }

    this.head = entry;

    if (!this.tail) {
      this.tail = entry;
    }
  }

  /**
   * Remove entry from its current position in the list
   */
  private unlinkEntry(entry: CacheEntry<V>): void {
    if (entry.prev) {
      entry.prev.next = entry.next;
    } else {
      // This was the head
      this.head = entry.next;
    }

    if (entry.next) {
      entry.next.prev = entry.prev;
    } else {
      // This was the tail
      this.tail = entry.prev;
    }

    entry.prev = null;
    entry.next = null;
  }

  /**
   * Move entry to front of list (mark as most recently used)
   */
  private moveToFront(entry: CacheEntry<V>): void {
    // If already at front, nothing to do
    if (this.head === entry) {
      return;
    }

    // Unlink from current position
    this.unlinkEntry(entry);

    // Add to front
    this.addToFront(entry);
  }

  /**
   * Remove entry from cache and list
   */
  private removeEntry(key: K, entry: CacheEntry<V>): void {
    this.totalSize -= entry.size;
    this.cache.delete(key);
    this.keyMap.delete(entry);
    this.unlinkEntry(entry);
  }

  /**
   * Enforce size and entry count limits by evicting least recently used entries
   */
  private enforceLimit(): void {
    while (
      (this.totalSize > this.maxSize || this.cache.size > this.maxEntries) &&
      this.tail &&
      this.cache.size > 1 // Keep at least one entry
    ) {
      // Evict from tail (least recently used)
      const evictEntry = this.tail;
      const evictKey = this.keyMap.get(evictEntry);

      if (evictKey !== undefined) {
        this.removeEntry(evictKey, evictEntry);
      }
    }
  }

  /**
   * Get default size for a value
   */
  private getDefaultSize(value: V): number {
    if (value instanceof Uint8Array) {
      return value.length;
    }
    if (typeof value === "string") {
      return value.length * 2; // Rough estimate for UTF-16
    }
    // For other types, use a default size
    return 64;
  }
}
