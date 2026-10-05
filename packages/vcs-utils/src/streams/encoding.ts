/**
 * Encode string to UTF-8 bytes.
 */
export function encodeString(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Decode UTF-8 bytes to string.
 */
export function decodeString(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}
