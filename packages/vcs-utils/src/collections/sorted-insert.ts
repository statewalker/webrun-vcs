/**
 * Sorted array insertion utilities
 *
 * Binary search-based insertion for maintaining sorted arrays.
 */

/**
 * Insert an element into a sorted array at the correct position.
 *
 * Uses binary search for O(log n) position finding.
 *
 * @param array Array to insert into (mutated in place)
 * @param element Element to insert
 * @param compare Comparison function returning negative if a < b, positive if a > b, zero if equal
 */
export function insertSorted<T>(array: T[], element: T, compare: (a: T, b: T) => number): void {
  let low = 0;
  let high = array.length;

  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compare(array[mid], element) > 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  array.splice(low, 0, element);
}

/**
 * Entry with a timestamp field
 */
export interface TimestampEntry {
  timestamp: number;
}

/**
 * Insert an entry into a timestamp-sorted array (newest first).
 *
 * Maintains descending timestamp order - newer entries come first.
 *
 * @param array Array to insert into (mutated in place)
 * @param entry Entry to insert with timestamp field
 */
export function insertByTimestamp<T extends TimestampEntry>(array: T[], entry: T): void {
  insertSorted(array, entry, (a, b) => b.timestamp - a.timestamp);
}
