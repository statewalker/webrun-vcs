/**
 * Pack file fixtures.
 *
 * These are helper utilities for creating test pack files.
 * Actual binary pack files can be generated at runtime to avoid
 * storing large binary files in the repository.
 */

export interface PackObjectInfo {
  type: "blob" | "tree" | "commit" | "tag";
  hash: string;
  size: number;
  deltaBase?: string;
}

export interface PackFixture {
  packData: Uint8Array;
  idxData?: Uint8Array;
  objectCount: number;
  objects: PackObjectInfo[];
  maxDeltaDepth?: number;
}

/**
 * Pack file fixtures.
 */
export const PACK_FIXTURES = {
  /**
   * Small pack with 5 objects (no deltas)
   * This is a placeholder - actual pack generation happens at runtime
   */
  small: {
    objectCount: 5,
    objects: [] as PackObjectInfo[],
    generate: async (): Promise<PackFixture> => {
      // Generate a small pack file at runtime
      return generateTestPack({ objectCount: 5, includeDelta: false });
    },
  },

  /**
   * Pack with delta chain
   */
  deltaChain: {
    objectCount: 10,
    maxDeltaDepth: 3,
    objects: [] as PackObjectInfo[],
    generate: async (): Promise<PackFixture> => {
      return generateTestPack({
        objectCount: 10,
        includeDelta: true,
        maxDeltaDepth: 3,
      });
    },
  },

  /**
   * Large pack for performance testing
   */
  large: {
    generate: (objectCount: number): Promise<PackFixture> =>
      generateTestPack({ objectCount, includeDelta: true }),
  },
} as const;

/**
 * Generate a test pack with specified characteristics.
 */
export async function generateTestPack(options: {
  objectCount: number;
  includeDelta?: boolean;
  maxDeltaDepth?: number;
}): Promise<PackFixture> {
  // Pack file format:
  // Header: "PACK" + version (4 bytes) + object count (4 bytes)
  // Objects: type + size + data (possibly deltified)
  // Checksum: SHA-1 (20 bytes)

  const header = new Uint8Array(12);
  const encoder = new TextEncoder();
  header.set(encoder.encode("PACK"), 0);

  // Version 2
  const view = new DataView(header.buffer);
  view.setUint32(4, 2, false);
  view.setUint32(8, options.objectCount, false);

  // For now, create a minimal valid pack header
  // Actual object data would be added here
  const packData = header;

  return {
    packData,
    objectCount: options.objectCount,
    objects: [],
    maxDeltaDepth: options.maxDeltaDepth,
  };
}

/**
 * Create a minimal pack index (version 2).
 */
export function generatePackIndex(
  _packHash: string,
  _objects: Array<{ hash: string; offset: number }>,
): Uint8Array {
  // Pack index format (version 2):
  // Header: 0xff, 't', 'O', 'c', version (4 bytes = 2)
  // Fanout table: 256 entries of 4 bytes each
  // Object names: sorted SHA-1 hashes
  // CRC32: for each object
  // Offsets: for each object
  // Checksums: pack checksum + index checksum

  const header = new Uint8Array(8);
  header[0] = 0xff;
  header[1] = "t".charCodeAt(0);
  header[2] = "O".charCodeAt(0);
  header[3] = "c".charCodeAt(0);

  const view = new DataView(header.buffer);
  view.setUint32(4, 2, false); // Version 2

  // For now, return just the header
  // Full implementation would add fanout table, object data, etc.
  return header;
}
