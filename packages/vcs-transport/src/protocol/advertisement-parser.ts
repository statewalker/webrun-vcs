/**
 * Advertisement parsing utilities for Git transport protocol.
 *
 * Parses ref advertisements from both upload-pack and receive-pack services.
 * Works with streaming data (FSM handlers) and buffered data (HTTP client).
 */

import type { PktLineResult } from "../api/transport-api.js";

/**
 * Result of parsing a ref advertisement.
 */
export interface ParsedAdvertisement {
  /** Map of ref name to object ID (string) */
  refs: Map<string, string>;
  /** Server capabilities */
  capabilities: Set<string>;
  /** True if repository is empty (no refs) */
  isEmpty: boolean;
  /** Symbolic ref mappings (e.g., HEAD -> refs/heads/main) */
  symrefs: Map<string, string>;
  /** Peeled tag references (tag^{} -> commit OID) */
  peeled: Map<string, string>;
}

/**
 * Parse ref advertisement from pkt-line packets.
 * Works for both upload-pack and receive-pack services.
 *
 * IMPORTANT: Accepts a read function instead of AsyncIterable to avoid closing
 * the underlying transport stream when breaking at flush. The FSM needs to
 * reuse the same transport for subsequent states.
 *
 * Caller is responsible for providing the read function:
 * - FSM: `() => transport.readPktLine()`
 * - HTTP: `() => decoder.readPacket()`
 *
 * @param readPacket - Function that reads the next packet
 * @returns Parsed advertisement result
 */
export async function parseAdvertisement(
  readPacket: () => Promise<PktLineResult>,
): Promise<ParsedAdvertisement> {
  const refs = new Map<string, string>();
  const peeled = new Map<string, string>();
  const symrefs = new Map<string, string>();
  const capabilities = new Set<string>();
  let isEmpty = false;
  let isFirst = true;

  while (true) {
    const pkt = await readPacket();

    if (pkt.type === "flush") break;
    if (pkt.type === "eof") {
      throw new Error("Unexpected end of stream during advertisement");
    }
    if (pkt.type === "delim") continue;

    // pkt.type === "data"
    const line = pkt.text;
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx === -1) continue;

    const oid = line.slice(0, spaceIdx);
    const refAndCaps = line.slice(spaceIdx + 1);

    if (isFirst) {
      isFirst = false;

      // Handle "capabilities^{}" for empty repos
      if (refAndCaps?.startsWith("capabilities^{}")) {
        const nullIdx = refAndCaps.indexOf("\0");
        if (nullIdx !== -1) {
          const caps = refAndCaps.slice(nullIdx + 1).trim();
          parseCapabilities(caps, capabilities, symrefs);
        }
        isEmpty = true;
        continue;
      }

      // Parse first line: oid ref\0capabilities
      if (refAndCaps?.includes("\0")) {
        const nullIdx = refAndCaps.indexOf("\0");
        const ref = refAndCaps.slice(0, nullIdx);
        const caps = refAndCaps.slice(nullIdx + 1).trim();
        refs.set(ref, oid);
        parseCapabilities(caps, capabilities, symrefs);
      } else if (refAndCaps) {
        refs.set(refAndCaps.trim(), oid);
      }
    } else {
      // Parse remaining lines: oid ref
      if (refAndCaps) {
        const trimmedRef = refAndCaps.trim();
        if (trimmedRef.endsWith("^{}")) {
          // Peeled tag reference
          peeled.set(trimmedRef.slice(0, -3), oid);
        } else {
          refs.set(trimmedRef, oid);
        }
      }
    }
  }

  // Empty repository if no refs found (but we got capabilities)
  if (refs.size === 0 && !isEmpty) {
    isEmpty = true;
  }

  return { refs, capabilities, isEmpty, symrefs, peeled };
}

/**
 * Parse capabilities string into sets.
 */
function parseCapabilities(
  caps: string,
  capabilities: Set<string>,
  symrefs: Map<string, string>,
): void {
  for (const c of caps.split(" ")) {
    const trimmed = c.trim();
    if (!trimmed) continue;

    capabilities.add(trimmed);

    // Extract symref from capabilities
    if (trimmed.startsWith("symref=")) {
      const symrefValue = trimmed.slice(7);
      const colonIdx = symrefValue.indexOf(":");
      if (colonIdx !== -1) {
        const src = symrefValue.slice(0, colonIdx);
        const dst = symrefValue.slice(colonIdx + 1);
        if (src && dst) symrefs.set(src, dst);
      }
    }
  }
}

/**
 * Apply parsed advertisement to ProtocolState.
 *
 * Helper function for FSM handlers that want to update ProtocolState
 * directly from a parsed advertisement.
 *
 * @param result - Parsed advertisement
 * @param state - Protocol state to update (must have refs and capabilities)
 */
export function applyAdvertisementToState(
  result: ParsedAdvertisement,
  state: { refs: Map<string, string>; capabilities: Set<string> },
): void {
  for (const [ref, oid] of result.refs) {
    state.refs.set(ref, oid);
  }
  for (const cap of result.capabilities) {
    state.capabilities.add(cap);
  }
}

/**
 * Parse ref advertisement from buffered pkt-line data (HTTP responses).
 *
 * Handles the service announcement line and double-flush format used by
 * HTTP smart protocol responses from /info/refs endpoints.
 *
 * @param data - Raw HTTP response body containing pkt-line encoded advertisement
 * @returns Parsed advertisement result
 */
export async function parseBufferedAdvertisement(data: Uint8Array): Promise<ParsedAdvertisement> {
  const decoder = new TextDecoder();
  let offset = 0;
  let pastServiceLine = false;

  const readPacket = async (): Promise<PktLineResult> => {
    while (offset + 4 <= data.length) {
      const lengthHex = decoder.decode(data.slice(offset, offset + 4));

      if (lengthHex === "0000") {
        offset += 4;
        if (pastServiceLine) return { type: "flush" };
        pastServiceLine = true;
        continue;
      }

      const length = parseInt(lengthHex, 16);
      if (Number.isNaN(length) || length < 4) return { type: "eof" };
      if (offset + length > data.length) return { type: "eof" };

      const payload = data.slice(offset + 4, offset + length);
      let text = decoder.decode(payload);
      if (text.endsWith("\n")) text = text.slice(0, -1);
      offset += length;

      // Skip service announcement line
      if (text.includes("# service=")) continue;

      return { type: "data", payload, text };
    }
    return { type: "eof" };
  };

  return parseAdvertisement(readPacket);
}
