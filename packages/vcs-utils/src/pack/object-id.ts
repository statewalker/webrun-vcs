/**
 * Git object ID computation
 *
 * Computes SHA-1 object ID from type string and content bytes:
 * sha1("type size\0content")
 *
 * Shared between pack-entries-parser and pack-indexer.
 */

import { sha1 } from "../hash/sha1/index.js";
import { bytesToHex } from "../hash/utils/index.js";

/**
 * Compute object ID (SHA-1 of "type size\0content")
 *
 * @param typeStr Git object type string ("commit", "tree", "blob", "tag")
 * @param content Object content bytes
 * @returns Hex-encoded SHA-1 object ID
 */
export async function computeObjectId(typeStr: string, content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${typeStr} ${content.length}\0`);

  const fullData = new Uint8Array(header.length + content.length);
  fullData.set(header, 0);
  fullData.set(content, header.length);

  const hash = await sha1(fullData);
  return bytesToHex(hash);
}
