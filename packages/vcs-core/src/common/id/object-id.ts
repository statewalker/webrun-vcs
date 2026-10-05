/**
 * Object identifier (content hash in hex format)
 *
 * SHA-256: 64 hex characters (256 bits / 4 bits per char)
 * SHA-1: 40 hex characters (160 bits / 4 bits per char)
 */
export type ObjectId = string;

/**
 * Object metadata returned by storage operations
 */
export type ObjectInfo = {
  /** Object ID (content hash in hex) */
  id: ObjectId;
  /** Uncompressed content size in bytes */
  size: number;
};

/**
 * Git format constants
 */
export const GitFormat = {
  /** SHA-1 hash length in bytes */
  OBJECT_ID_LENGTH: 20,
  /** SHA-1 hash string length (hex) */
  OBJECT_ID_STRING_LENGTH: 40,
  /** SHA-256 hash length in bytes */
  OBJECT_ID_256_LENGTH: 32,
  /** SHA-256 hash string length (hex) */
  OBJECT_ID_256_STRING_LENGTH: 64,
} as const;
