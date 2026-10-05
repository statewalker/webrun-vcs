/**
 * Reference utilities
 *
 * Utility functions for working with Git refs.
 */

import type { ObjectId } from "@statewalker/vcs-core";
import { R_HEADS, R_REMOTES, R_TAGS, type Ref } from "./ref-types.js";

/**
 * Peel a ref to find the target commit
 *
 * For annotated tags, follows the tag to find the underlying commit.
 * This is a placeholder - full implementation requires object storage access.
 *
 * @param ref The ref to peel
 * @returns The peeled object ID, or the ref's object ID if not peelable
 */
export function peelRef(ref: Ref): ObjectId | undefined {
  if (ref.peeledObjectId !== undefined) {
    return ref.peeledObjectId;
  }
  return ref.objectId;
}

/**
 * Check if a ref name is valid
 *
 * @param refName The ref name to validate
 * @returns True if valid
 */
export function isValidRefName(refName: string): boolean {
  // Basic validation
  if (refName.length === 0) return false;
  if (refName.startsWith("/") || refName.endsWith("/")) return false;
  if (refName.includes("//")) return false;
  if (refName.includes("..")) return false;
  if (refName.includes("@{")) return false;
  if (refName.endsWith(".lock")) return false;

  // Check for invalid characters (control chars, space, and special chars)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally checking for control characters in ref names
  const invalidChars = /[\x00-\x1f\x7f ~^:?*[\\]/;
  if (invalidChars.test(refName)) return false;

  return true;
}

/**
 * Get short ref name for display
 *
 * @param refName Full ref name
 * @returns Short name (e.g., "main" instead of "refs/heads/main")
 */
export function shortenRefName(refName: string): string {
  if (refName.startsWith(R_HEADS)) {
    return refName.substring(R_HEADS.length);
  }
  if (refName.startsWith(R_TAGS)) {
    return refName.substring(R_TAGS.length);
  }
  if (refName.startsWith(R_REMOTES)) {
    return refName.substring(R_REMOTES.length);
  }
  return refName;
}
