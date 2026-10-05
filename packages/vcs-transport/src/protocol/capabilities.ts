/**
 * Protocol capability negotiation.
 *
 * Both client and server advertise capabilities during connection
 * establishment. The client then requests a subset of capabilities
 * that both sides support.
 *
 * Based on JGit's capability handling in various transport classes.
 */

import {
  CAPABILITY_AGENT,
  CAPABILITY_INCLUDE_TAG,
  CAPABILITY_MULTI_ACK,
  CAPABILITY_MULTI_ACK_DETAILED,
  CAPABILITY_NO_PROGRESS,
  CAPABILITY_OFS_DELTA,
  CAPABILITY_SHALLOW,
  CAPABILITY_SIDE_BAND,
  CAPABILITY_SIDE_BAND_64K,
  CAPABILITY_SYMREF,
  CAPABILITY_THIN_PACK,
} from "./constants.js";

/**
 * Parse capability string from ref advertisement.
 *
 * Format: "cap1 cap2 symref=HEAD:refs/heads/main agent=git/2.30.0"
 */
export function parseCapabilities(capsString: string): {
  capabilities: Set<string>;
  symrefs: Map<string, string>;
  agent?: string;
} {
  const capabilities = new Set<string>();
  const symrefs = new Map<string, string>();
  let agent: string | undefined;

  for (const cap of capsString.split(" ")) {
    if (!cap) continue;

    if (cap.startsWith(CAPABILITY_SYMREF)) {
      const value = cap.slice(CAPABILITY_SYMREF.length);
      const colonIdx = value.indexOf(":");
      if (colonIdx > 0) {
        const from = value.slice(0, colonIdx);
        const to = value.slice(colonIdx + 1);
        symrefs.set(from, to);
      }
    } else if (cap.startsWith(CAPABILITY_AGENT)) {
      agent = cap.slice(CAPABILITY_AGENT.length);
    }

    capabilities.add(cap);
  }

  return { capabilities, symrefs, agent };
}

/**
 * Format capabilities for sending to server.
 *
 * @param caps - Capabilities to include
 * @param agent - Optional agent string
 */
export function formatCapabilities(caps: string[], agent?: string): string {
  const parts = [...caps];
  if (agent) {
    parts.push(`${CAPABILITY_AGENT}${agent}`);
  }
  return parts.join(" ");
}

/**
 * Default capabilities to request for fetch operations.
 */
export const DEFAULT_FETCH_CAPABILITIES = [
  CAPABILITY_MULTI_ACK_DETAILED,
  CAPABILITY_THIN_PACK,
  CAPABILITY_SIDE_BAND_64K,
  CAPABILITY_OFS_DELTA,
  CAPABILITY_NO_PROGRESS,
  CAPABILITY_INCLUDE_TAG,
  CAPABILITY_SHALLOW,
];

/**
 * Fallback capabilities if server doesn't support preferred ones.
 */
export const FALLBACK_FETCH_CAPABILITIES = [
  CAPABILITY_MULTI_ACK,
  CAPABILITY_THIN_PACK,
  CAPABILITY_SIDE_BAND,
  CAPABILITY_OFS_DELTA,
];

/**
 * Negotiate capabilities between client and server.
 *
 * Returns the capabilities that should be requested from the server.
 */
export function negotiateCapabilities(
  serverCaps: Set<string>,
  preferredCaps: string[] = DEFAULT_FETCH_CAPABILITIES,
): string[] {
  const result: string[] = [];

  for (const cap of preferredCaps) {
    if (serverCaps.has(cap)) {
      result.push(cap);
    }
  }

  // Ensure we have at least basic sideband support
  if (!result.includes(CAPABILITY_SIDE_BAND_64K) && !result.includes(CAPABILITY_SIDE_BAND)) {
    if (serverCaps.has(CAPABILITY_SIDE_BAND)) {
      result.push(CAPABILITY_SIDE_BAND);
    }
  }

  return result;
}

/**
 * Check if capabilities include multi-ack support.
 */
export function hasMultiAck(caps: Set<string> | string[]): boolean {
  const capSet = Array.isArray(caps) ? new Set(caps) : caps;
  return capSet.has(CAPABILITY_MULTI_ACK_DETAILED) || capSet.has(CAPABILITY_MULTI_ACK);
}

/**
 * Check if capabilities include sideband support.
 */
export function hasSideband(caps: Set<string> | string[]): boolean {
  const capSet = Array.isArray(caps) ? new Set(caps) : caps;
  return capSet.has(CAPABILITY_SIDE_BAND_64K) || capSet.has(CAPABILITY_SIDE_BAND);
}

/**
 * Get the sideband buffer size based on capabilities.
 */
export function getSidebandSize(caps: Set<string> | string[]): number {
  const capSet = Array.isArray(caps) ? new Set(caps) : caps;
  if (capSet.has(CAPABILITY_SIDE_BAND_64K)) {
    return 65520;
  }
  if (capSet.has(CAPABILITY_SIDE_BAND)) {
    return 1000;
  }
  return 0;
}

/**
 * Check if capabilities support thin packs.
 */
export function hasThinPack(caps: Set<string> | string[]): boolean {
  const capSet = Array.isArray(caps) ? new Set(caps) : caps;
  return capSet.has(CAPABILITY_THIN_PACK);
}

/**
 * Check if capabilities support ofs-delta encoding.
 */
export function hasOfsDelta(caps: Set<string> | string[]): boolean {
  const capSet = Array.isArray(caps) ? new Set(caps) : caps;
  return capSet.has(CAPABILITY_OFS_DELTA);
}
