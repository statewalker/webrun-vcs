/**
 * Utility functions for hash operations
 */

/**
 * Convert hex string to Uint8Array
 *
 * @param hex Hexadecimal string (e.g., "deadbeef")
 * @returns Uint8Array of bytes
 */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 *
 * @param bytes Uint8Array of bytes
 * @returns Hexadecimal string (lowercase)
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
