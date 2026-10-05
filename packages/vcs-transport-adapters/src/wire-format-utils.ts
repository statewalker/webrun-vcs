/**
 * Git wire format utilities
 *
 * Functions for creating and parsing Git objects in wire format.
 * Wire format is: "type size\0content"
 */

import { ObjectType, type ObjectTypeCode, type ObjectTypeString } from "@statewalker/vcs-core";
import { concat } from "@statewalker/vcs-utils/streams";

const NULL_BYTE = 0x00;
const MAX_HEADER_SCAN = 32;

/**
 * Create Git wire format for an object
 *
 * Format: "type size\0content"
 *
 * @param type - Object type string (commit, tree, blob, tag)
 * @param content - Object content bytes
 * @returns Wire format bytes
 */
export function createGitWireFormat(type: ObjectTypeString, content: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(`${type} ${content.length}\0`);
  return concat(header, content);
}

/**
 * Parse Git wire format to extract type and body
 *
 * @param data - Wire format data
 * @returns Object type code and body content
 * @throws Error if format is invalid
 */
export function parseGitWireFormat(data: Uint8Array): { type: ObjectTypeCode; body: Uint8Array } {
  // Find null byte within first MAX_HEADER_SCAN bytes
  let nullIdx = -1;
  for (let i = 0; i < Math.min(data.length, MAX_HEADER_SCAN); i++) {
    if (data[i] === NULL_BYTE) {
      nullIdx = i;
      break;
    }
  }

  if (nullIdx < 0) {
    throw new Error("Invalid Git object: no header null byte found");
  }

  // Parse header: "type size"
  const header = new TextDecoder().decode(data.subarray(0, nullIdx));
  const spaceIdx = header.indexOf(" ");
  if (spaceIdx < 0) {
    throw new Error("Invalid Git object header: no space separator");
  }

  const typeStr = header.substring(0, spaceIdx);
  const type = stringToObjectType(typeStr);
  if (type === null) {
    throw new Error(`Unknown object type: ${typeStr}`);
  }

  return {
    type,
    body: data.subarray(nullIdx + 1),
  };
}

/**
 * Convert type string to ObjectTypeCode
 *
 * @param str - Type string (commit, tree, blob, tag)
 * @returns ObjectTypeCode or null if unknown
 */
export function stringToObjectType(str: string): ObjectTypeCode | null {
  switch (str) {
    case "commit":
      return ObjectType.COMMIT;
    case "tree":
      return ObjectType.TREE;
    case "blob":
      return ObjectType.BLOB;
    case "tag":
      return ObjectType.TAG;
    default:
      return null;
  }
}

/**
 * Convert ObjectTypeCode to type string
 *
 * @param type - ObjectTypeCode
 * @returns Type string
 * @throws Error if type code is unknown
 */
export function objectTypeToString(type: ObjectTypeCode): ObjectTypeString {
  switch (type) {
    case ObjectType.COMMIT:
      return "commit";
    case ObjectType.TREE:
      return "tree";
    case ObjectType.BLOB:
      return "blob";
    case ObjectType.TAG:
      return "tag";
    default:
      throw new Error(`Unknown type code: ${type}`);
  }
}
