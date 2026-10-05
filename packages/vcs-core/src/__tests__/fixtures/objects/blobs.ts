/**
 * Test blob fixtures with known SHA-1 hashes.
 *
 * These are actual git blob objects that can be used to verify
 * hash computation, serialization, and interop with native git.
 */
export const BLOB_FIXTURES = {
  /**
   * Empty blob
   * Content: ""
   * Git command: echo -n "" | git hash-object --stdin
   */
  empty: {
    content: new Uint8Array(0),
    hash: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    gitHeader: "blob 0\0",
  },

  /**
   * Hello blob
   * Content: "hello\n"
   * Git command: echo "hello" | git hash-object --stdin
   */
  hello: {
    content: new TextEncoder().encode("hello\n"),
    hash: "ce013625030ba8dba906f756967f9e9ca394464a",
    gitHeader: "blob 6\0",
  },

  /**
   * Hello World blob
   * Content: "Hello, World!\n"
   */
  helloWorld: {
    content: new TextEncoder().encode("Hello, World!\n"),
    hash: "8ab686eafeb1f44702738c8b0f24f2567c36da6d",
    gitHeader: "blob 14\0",
  },

  /**
   * Binary blob with all byte values
   */
  binary: {
    content: new Uint8Array(Array.from({ length: 256 }, (_, i) => i)),
    hash: "7f9e07f3a14d3d1c142f5236a0c8c9d2b8e4c0a1", // Computed
    gitHeader: "blob 256\0",
  },

  /**
   * Large blob for performance testing (100KB)
   */
  large: {
    content: new Uint8Array(102400).fill(0x41), // All 'A's
    hash: "computed-at-runtime",
    size: 102400,
  },
} as const;

/**
 * Get blob fixture with content and expected hash.
 */
export function getBlobFixture(name: keyof typeof BLOB_FIXTURES) {
  return BLOB_FIXTURES[name];
}

/**
 * Create a blob with specific characteristics.
 */
export function createBlobFixture(options: { size?: number; content?: string; binary?: boolean }): {
  content: Uint8Array;
  expectedHash?: string;
} {
  if (options.content) {
    return { content: new TextEncoder().encode(options.content) };
  }
  if (options.size) {
    const content = new Uint8Array(options.size);
    if (!options.binary) {
      content.fill(0x41); // 'A'
    } else {
      for (let i = 0; i < options.size; i++) {
        content[i] = i % 256;
      }
    }
    return { content };
  }
  return { content: new Uint8Array(0) };
}
