/**
 * RefSpec parsing and matching.
 *
 * A refspec defines the mapping between remote refs and local refs.
 * Format: [+]<src>:<dst>
 * - '+' prefix forces update even if not fast-forward
 * - '*' wildcard matches any path component(s)
 * - '^' prefix (negative refspec) excludes matching refs
 *
 * Based on JGit's RefSpec.java
 */

import type { RefSpec } from "../protocol/types.js";

export type { RefSpec } from "../protocol/types.js";

/**
 * Parse a refspec string.
 *
 * Examples:
 * - "refs/heads/master:refs/heads/master" - exact mapping
 * - "+refs/heads/*:refs/remotes/origin/*" - force wildcard mapping
 * - "refs/heads/master" - source only (fetch)
 * - ":refs/heads/master" - delete ref (push)
 * - "^refs/heads/secret" - negative (exclude)
 */
export function parseRefSpec(spec: string): RefSpec {
  let s = spec;
  let force = false;
  let negative = false;

  // Check for force prefix
  if (s.startsWith("+")) {
    force = true;
    s = s.slice(1);
  }

  // Check for negative prefix
  if (s.startsWith("^")) {
    if (force) {
      throw new Error("Invalid refspec: cannot combine + and ^");
    }
    negative = true;
    s = s.slice(1);
  }

  // Check for force AFTER negative (^+ should also be rejected)
  if (s.startsWith("+") && negative) {
    throw new Error("Invalid refspec: cannot combine + and ^");
  }

  // Find the colon separator
  const colonIdx = s.lastIndexOf(":");
  let source: string | null;
  let destination: string | null;

  if (colonIdx === -1) {
    // Source only
    source = s || null;
    destination = null;
  } else {
    source = s.slice(0, colonIdx) || null;
    destination = s.slice(colonIdx + 1) || null;
  }

  // Validate
  if (source) {
    validateRefComponent(source, "source");
  }
  if (destination) {
    validateRefComponent(destination, "destination");
  }

  // Check wildcard consistency
  const srcWildcard = source?.includes("*") ?? false;
  const dstWildcard = destination?.includes("*") ?? false;
  const wildcard = srcWildcard || dstWildcard;

  if (wildcard && source && destination) {
    if (srcWildcard !== dstWildcard) {
      throw new Error(
        "Invalid refspec: both source and destination must have wildcard, or neither",
      );
    }
    // Count wildcards
    const srcCount = (source.match(/\*/g) || []).length;
    const dstCount = (destination.match(/\*/g) || []).length;
    if (srcCount > 1 || dstCount > 1) {
      throw new Error("Invalid refspec: only one wildcard allowed per side");
    }
  }

  // Wildcard without destination is only valid with WildcardMode.ALLOW_MISMATCH
  if (srcWildcard && !destination) {
    // This is typically an error, but some use cases allow it
    // We'll allow it and let the caller validate
  }

  return {
    source,
    destination,
    force,
    wildcard,
    negative,
  };
}

/**
 * Validate a ref component (source or destination).
 */
function validateRefComponent(ref: string, name: string): void {
  if (ref.endsWith("/")) {
    throw new Error(`Invalid refspec: ${name} cannot end with /`);
  }
  if (ref.startsWith("/")) {
    throw new Error(`Invalid refspec: ${name} cannot start with /`);
  }
  if (ref.includes("//")) {
    throw new Error(`Invalid refspec: ${name} cannot contain //`);
  }
}

/**
 * Check if a ref spec is a wildcard pattern.
 */
export function isWildcard(pattern: string): boolean {
  return pattern.includes("*");
}

/**
 * Check if a ref name matches the source pattern.
 */
export function matchSource(spec: RefSpec, refName: string): boolean {
  if (!spec.source) {
    return false;
  }
  return matchPattern(spec.source, refName);
}

/**
 * Check if a ref name matches the destination pattern.
 */
export function matchDestination(spec: RefSpec, refName: string): boolean {
  if (!spec.destination) {
    return false;
  }
  return matchPattern(spec.destination, refName);
}

/**
 * Match a ref name against a pattern.
 */
function matchPattern(pattern: string, refName: string): boolean {
  if (!pattern.includes("*")) {
    return pattern === refName;
  }

  const starIdx = pattern.indexOf("*");
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);

  if (!refName.startsWith(prefix)) {
    return false;
  }
  if (!refName.endsWith(suffix)) {
    return false;
  }

  // Ensure there's something between prefix and suffix
  const middle = refName.slice(prefix.length, refName.length - suffix.length);
  if (middle.length === 0 && pattern !== "*") {
    return false;
  }

  return true;
}

/**
 * Expand a wildcard refspec from a source ref.
 *
 * Example:
 *   spec: "+refs/heads/*:refs/remotes/origin/*"
 *   source: "refs/heads/main"
 *   result: { source: "refs/heads/main", destination: "refs/remotes/origin/main", ... }
 */
export function expandFromSource(spec: RefSpec, refName: string): RefSpec {
  if (!spec.wildcard || !spec.source || !spec.destination) {
    return spec;
  }

  if (!matchPattern(spec.source, refName)) {
    throw new Error(`Ref '${refName}' does not match pattern '${spec.source}'`);
  }

  const starIdx = spec.source.indexOf("*");
  const prefix = spec.source.slice(0, starIdx);
  const suffix = spec.source.slice(starIdx + 1);

  // Extract the wildcard match
  const match = refName.slice(prefix.length, refName.length - suffix.length);

  // Apply to destination
  const dstStarIdx = spec.destination.indexOf("*");
  const dstPrefix = spec.destination.slice(0, dstStarIdx);
  const dstSuffix = spec.destination.slice(dstStarIdx + 1);
  const expandedDst = dstPrefix + match + dstSuffix;

  return {
    source: refName,
    destination: expandedDst,
    force: spec.force,
    wildcard: false,
    negative: spec.negative,
  };
}

/**
 * Expand a wildcard refspec from a destination ref.
 */
export function expandFromDestination(spec: RefSpec, refName: string): RefSpec {
  if (!spec.wildcard || !spec.source || !spec.destination) {
    return spec;
  }

  if (!matchPattern(spec.destination, refName)) {
    throw new Error(`Ref '${refName}' does not match pattern '${spec.destination}'`);
  }

  const starIdx = spec.destination.indexOf("*");
  const prefix = spec.destination.slice(0, starIdx);
  const suffix = spec.destination.slice(starIdx + 1);

  // Extract the wildcard match
  const match = refName.slice(prefix.length, refName.length - suffix.length);

  // Apply to source
  const srcStarIdx = spec.source.indexOf("*");
  const srcPrefix = spec.source.slice(0, srcStarIdx);
  const srcSuffix = spec.source.slice(srcStarIdx + 1);
  const expandedSrc = srcPrefix + match + srcSuffix;

  return {
    source: expandedSrc,
    destination: refName,
    force: spec.force,
    wildcard: false,
    negative: spec.negative,
  };
}

/**
 * Format a refspec back to string.
 */
export function formatRefSpec(spec: RefSpec): string {
  let result = "";

  if (spec.force) {
    result += "+";
  }
  if (spec.negative) {
    result += "^";
  }

  if (spec.source) {
    result += spec.source;
  }

  if (spec.destination !== null) {
    result += ":";
    if (spec.destination) {
      result += spec.destination;
    }
  }

  return result;
}

/**
 * Default fetch refspec for a remote.
 */
export function defaultFetchRefSpec(remoteName: string): RefSpec {
  return parseRefSpec(`+refs/heads/*:refs/remotes/${remoteName}/*`);
}

/**
 * Default push refspec (matching refs).
 */
export function defaultPushRefSpec(): RefSpec {
  return parseRefSpec(":");
}
