/**
 * Pack object cache interface
 *
 * Temporary object store for streaming pack import. Stores resolved
 * objects and provides random-access reads for delta base resolution.
 */

/**
 * Temporary object cache for streaming pack import.
 *
 * During pack parsing, resolved objects must be cached so that
 * delta objects can reference them as bases. The cache provides:
 * - save/read for content (supports streaming and random-access via offset)
 * - type and size metadata
 * - disposal for cleanup
 */
export interface PackObjectCache {
  /** Store resolved object content */
  save(key: string, type: string, content: AsyncIterable<Uint8Array>): Promise<void>;

  /** Get object type */
  getType(key: string): string | undefined;

  /** Get stored object size in bytes */
  getSize(key: string): number | undefined;

  /** Read object content from a given byte offset (RandomAccessStream) */
  read(key: string, start?: number): AsyncIterable<Uint8Array>;

  /** Release all stored objects */
  dispose(): Promise<void>;
}
