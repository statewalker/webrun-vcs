/**
 * High-level push operation.
 *
 * Provides a simplified interface for pushing to a remote repository
 * over HTTP/HTTPS.
 */

import { compressBlock } from "@statewalker/vcs-utils";
import { sha1 } from "@statewalker/vcs-utils/hash";

import type { BaseHttpOptions, BasePushOptions } from "../api/options.js";
import { ZERO_OID } from "../protocol/constants.js";
import { createEmptyPack } from "../protocol/pack-utils.js";

/**
 * An object to push to the remote.
 */
export interface PushObject {
  /** Object ID (hex string) */
  id: string;
  /** Object type code (1=commit, 2=tree, 3=blob, 4=tag) */
  type: number;
  /** Object content */
  content: Uint8Array;
}

/**
 * Options for the push operation.
 */
export interface PushOptions extends BaseHttpOptions, BasePushOptions {
  /** Refspecs to push (e.g., "refs/heads/main:refs/heads/main") — required for HTTP push */
  refspecs: string[];
  /** Progress message callback */
  onProgressMessage?: (message: string) => void;
  /** Get the object ID for a local ref */
  getLocalRef?: (refName: string) => Promise<string | undefined>;
  /** Get objects to push for given new/old object IDs */
  getObjectsToPush?: (newIds: string[], oldIds: string[]) => AsyncIterable<PushObject>;
  /** Export a valid pack stream for the given wants/exclude sets (preferred over getObjectsToPush) */
  exportPack?: (wants: Set<string>, exclude: Set<string>) => AsyncIterable<Uint8Array>;
}

/**
 * Result of updating a single ref.
 */
export interface RefUpdateResult {
  /** Whether the update succeeded */
  ok: boolean;
  /** Status message from server */
  message?: string;
  /**
   * The remote's value for this ref before the push, as read from the
   * receive-pack advertisement — ZERO_OID when the remote did not have it.
   *
   * This is the value the client sent as the command's old id, so it is also
   * the compare-and-swap expectation the server checked against.
   */
  oldOid?: string;
}

/**
 * Result of a push operation over HTTP.
 */
export interface HttpPushResult {
  /** Whether the overall push succeeded */
  ok: boolean;
  /** Status of pack unpack on server (if failed) */
  unpackStatus?: string;
  /** Update results for each ref */
  updates: Map<string, RefUpdateResult>;
  /** Total bytes sent */
  bytesSent: number;
  /** Number of objects sent */
  objectCount: number;
}

/**
 * Push objects and refs to a remote repository.
 *
 * @param options - Push options
 * @returns Push result with update status
 *
 * @example
 * ```ts
 * const result = await push({
 *   url: "https://github.com/user/repo.git",
 *   refspecs: ["refs/heads/main:refs/heads/main"],
 *   auth: { token: "ghp_xxx" },
 *   getLocalRef: async (ref) => store.refs.get(ref)?.objectId,
 *   getObjectsToPush: async function* (newIds, oldIds) {
 *     // yield objects reachable from newIds but not oldIds
 *   },
 * });
 *
 * for (const [ref, status] of result.updates) {
 *   console.log(`${ref}: ${status.ok ? "OK" : status.message}`);
 * }
 * ```
 */
export async function push(options: PushOptions): Promise<HttpPushResult> {
  // Normalize URL
  const baseUrl = options.url.endsWith("/") ? options.url.slice(0, -1) : options.url;

  // Build request headers
  const headers: Record<string, string> = {
    ...options.headers,
  };

  // Add authentication if provided
  if (options.auth) {
    const { username, password } = options.auth;
    const credentials = btoa(`${username}:${password}`);
    headers.Authorization = `Basic ${credentials}`;
  }

  // Setup timeout handling
  const controller = options.timeout ? new AbortController() : undefined;
  const timeoutId = options.timeout
    ? setTimeout(() => controller?.abort(), options.timeout)
    : undefined;

  const textEncoder = new TextEncoder();

  // Helper to encode pkt-line
  const encodePacketLine = (line: string): Uint8Array => {
    const withNewline = line.endsWith("\n") ? line : `${line}\n`;
    const payload = textEncoder.encode(withNewline);
    const length = payload.length + 4;
    const header = length.toString(16).padStart(4, "0");
    const result = new Uint8Array(length);
    result.set(textEncoder.encode(header), 0);
    result.set(payload, 4);
    return result;
  };

  const encodeFlush = (): Uint8Array => textEncoder.encode("0000");

  // Normalize to a single (Request) => Promise<Response> shape; default to
  // native fetch, preserving exact behavior when fetchImpl is omitted.
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  try {
    // Phase 1: GET /info/refs to get remote refs
    const infoRefsUrl = `${baseUrl}/info/refs?service=git-receive-pack`;
    const infoRefsResponse = await doFetch(
      new Request(infoRefsUrl, {
        method: "GET",
        headers: {
          ...headers,
          Accept: "application/x-git-receive-pack-advertisement",
        },
        signal: controller?.signal,
      }),
    );

    if (!infoRefsResponse.ok) {
      throw new Error(
        `Failed to get refs: ${infoRefsResponse.status} ${infoRefsResponse.statusText}`,
      );
    }

    if (!infoRefsResponse.body) {
      throw new Error("Empty response from /info/refs");
    }

    // Parse remote refs
    const infoRefsData = new Uint8Array(await infoRefsResponse.arrayBuffer());
    const remoteRefs = parseReceivePackAdvertisement(infoRefsData);

    // Phase 2: Parse refspecs and determine what to push
    const refUpdates: Array<{
      refName: string;
      oldOid: string;
      newOid: string;
    }> = [];

    for (const refspec of options.refspecs) {
      // Strip force prefix before parsing
      const normalized = refspec.startsWith("+") ? refspec.slice(1) : refspec;
      const [source, dest] = normalized.split(":");
      const destRef = dest || source;

      // Get local ref value
      const localOid = options.getLocalRef ? await options.getLocalRef(source) : undefined;

      if (!localOid) {
        throw new Error(`Local ref not found: ${source}`);
      }

      // Get remote ref value (if exists)
      const remoteOid = remoteRefs.get(destRef) || ZERO_OID;

      refUpdates.push({
        refName: destRef,
        oldOid: remoteOid,
        newOid: localOid,
      });
    }

    if (refUpdates.length === 0) {
      if (timeoutId) clearTimeout(timeoutId);
      return {
        ok: true,
        updates: new Map(),
        bytesSent: 0,
        objectCount: 0,
      };
    }

    // Phase 3: Build push request
    const requestChunks: Uint8Array[] = [];

    // Send ref update commands
    let firstUpdate = true;
    const newOids: string[] = [];
    const oldOids: string[] = [];

    for (const update of refUpdates) {
      if (update.newOid !== ZERO_OID) {
        newOids.push(update.newOid);
      }
      if (update.oldOid !== ZERO_OID) {
        oldOids.push(update.oldOid);
      }

      // Build capability string for first line (NUL-separated per Git protocol)
      const caps = firstUpdate
        ? `\0report-status side-band-64k${options.atomic ? " atomic" : ""}`
        : "";

      const line = `${update.oldOid} ${update.newOid} ${update.refName}${caps}`;
      requestChunks.push(encodePacketLine(line));
      firstUpdate = false;
    }

    requestChunks.push(encodeFlush());

    // Generate pack data
    let objectCount = 0;
    if (newOids.length > 0 && options.exportPack) {
      // Preferred: use RepositoryFacade.exportPack for proper pack encoding
      const wantsSet = new Set(newOids);
      const excludeSet = new Set(oldOids);
      for await (const chunk of options.exportPack(wantsSet, excludeSet)) {
        requestChunks.push(chunk);
      }
      objectCount = newOids.length; // Approximate
    } else if (newOids.length > 0 && options.getObjectsToPush) {
      const packWriter = new PackWriter();

      for await (const obj of options.getObjectsToPush(newOids, oldOids)) {
        packWriter.addObject(obj);
        objectCount++;
      }

      const packData = await packWriter.finish();
      requestChunks.push(packData);
    } else {
      // Empty pack for delete-only operations
      requestChunks.push(createEmptyPack());
    }

    // Concatenate request body
    const requestBodyLength = requestChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const requestBody = new Uint8Array(requestBodyLength);
    let offset = 0;
    for (const chunk of requestChunks) {
      requestBody.set(chunk, offset);
      offset += chunk.length;
    }

    // Phase 4: POST /git-receive-pack
    const receivePackUrl = `${baseUrl}/git-receive-pack`;
    const receivePackResponse = await doFetch(
      new Request(receivePackUrl, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/x-git-receive-pack-request",
          Accept: "application/x-git-receive-pack-result",
        },
        body: requestBody,
        signal: controller?.signal,
      }),
    );

    if (!receivePackResponse.ok) {
      throw new Error(
        `Failed to receive-pack: ${receivePackResponse.status} ${receivePackResponse.statusText}`,
      );
    }

    if (!receivePackResponse.body) {
      throw new Error("Empty response from /git-receive-pack");
    }

    // Parse response
    const responseData = new Uint8Array(await receivePackResponse.arrayBuffer());
    const { updates, unpackStatus } = parseReportStatus(
      responseData,
      refUpdates,
      options.onProgressMessage,
    );

    if (timeoutId) clearTimeout(timeoutId);

    const allOk = Array.from(updates.values()).every((status) => status.ok);

    return {
      ok: allOk,
      unpackStatus,
      updates,
      bytesSent: requestBodyLength,
      objectCount,
    };
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);

    if (error instanceof Error) {
      if (error.name === "AbortError") {
        throw new Error("Request timeout");
      }
      throw error;
    }
    throw new Error(String(error));
  }
}

/**
 * Parse receive-pack advertisement.
 *
 * Walks the pkt-line framing rather than splitting on newlines: the flush
 * packet that separates the service line from the refs carries no newline, so
 * a line-oriented reader hands back the first ref with its own pkt-length
 * still glued to the object id.
 */
function parseReceivePackAdvertisement(data: Uint8Array): Map<string, string> {
  const refs = new Map<string, string>();
  const textDecoder = new TextDecoder();
  let pos = 0;

  while (pos + 4 <= data.length) {
    const lengthHex = textDecoder.decode(data.slice(pos, pos + 4));
    // Flush ("0000") and delimiter ("0001") packets carry no payload.
    if (lengthHex === "0000" || lengthHex === "0001") {
      pos += 4;
      continue;
    }

    const length = parseInt(lengthHex, 16);
    if (Number.isNaN(length) || length < 4) break;
    if (pos + length > data.length) break;

    const content = textDecoder.decode(data.slice(pos + 4, pos + length));
    pos += length;

    if (content.includes("# service=")) continue;

    // Capabilities follow the ref name after a NUL on the first ref line.
    const nullIndex = content.indexOf("\0");
    const refPart = nullIndex >= 0 ? content.slice(0, nullIndex) : content;

    const spaceIndex = refPart.indexOf(" ");
    if (spaceIndex > 0) {
      const oid = refPart.slice(0, spaceIndex);
      const refName = refPart.slice(spaceIndex + 1).trim();

      if (!refName.endsWith("^{}") && !refName.startsWith("capabilities") && refName.length > 0) {
        refs.set(refName, oid);
      }
    }
  }

  return refs;
}

/**
 * Parse a single status line from report-status (e.g. "unpack ok", "ok refname", "ng refname msg").
 */
function parseStatusLine(
  content: string,
  updates: Map<string, RefUpdateResult>,
  setUnpack: (status: string) => void,
): void {
  if (content.startsWith("unpack ")) {
    setUnpack(content);
  } else if (content.startsWith("ok ")) {
    const refName = content.slice(3);
    updates.set(refName, { ok: true });
  } else if (content.startsWith("ng ")) {
    const rest = content.slice(3);
    const spaceIdx = rest.indexOf(" ");
    const refName = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
    const message = spaceIdx >= 0 ? rest.slice(spaceIdx + 1) : "unknown error";
    updates.set(refName, { ok: false, message });
  }
}

/**
 * Parse inner pkt-line encoded status lines from sideband channel 1 data.
 *
 * When side-band-64k is negotiated, the server wraps each status line in a
 * pkt-line before sending it on channel 1. This function strips the inner
 * pkt-line framing and feeds each status line to parseStatusLine.
 */
function parsePktLineStatusStream(
  data: Uint8Array,
  textDecoder: TextDecoder,
  updates: Map<string, RefUpdateResult>,
  setUnpack: (status: string) => void,
): void {
  let pos = 0;
  while (pos < data.length) {
    if (pos + 4 > data.length) break;

    const innerLenHex = textDecoder.decode(data.slice(pos, pos + 4));
    if (innerLenHex === "0000") {
      // Inner flush — end of status stream
      pos += 4;
      continue;
    }

    const innerLen = parseInt(innerLenHex, 16);
    if (Number.isNaN(innerLen) || innerLen < 4) break;
    if (pos + innerLen > data.length) break;

    const innerPayload = textDecoder.decode(data.slice(pos + 4, pos + innerLen)).trim();
    parseStatusLine(innerPayload, updates, setUnpack);
    pos += innerLen;
  }
}

/**
 * Parse report-status response.
 */
function parseReportStatus(
  data: Uint8Array,
  refUpdates: Array<{ refName: string; oldOid: string; newOid: string }>,
  onProgress?: (message: string) => void,
): {
  updates: Map<string, RefUpdateResult>;
  unpackStatus?: string;
} {
  const updates = new Map<string, RefUpdateResult>();
  const textDecoder = new TextDecoder();
  let offset = 0;
  let unpackStatus: string | undefined;

  while (offset < data.length) {
    if (offset + 4 > data.length) break;

    const lengthHex = textDecoder.decode(data.slice(offset, offset + 4));
    if (lengthHex === "0000") {
      offset += 4;
      continue;
    }

    const length = parseInt(lengthHex, 16);
    if (Number.isNaN(length) || length < 4) break;

    if (offset + length > data.length) break;

    const payload = data.slice(offset + 4, offset + length);
    if (payload.length > 0) {
      const firstByte = payload[0];

      // Detect sideband vs plain text: sideband packets have channel byte 1-3
      if (firstByte >= 1 && firstByte <= 3) {
        if (firstByte === 1) {
          // Status data on sideband channel 1 is itself pkt-line encoded.
          // Parse inner pkt-lines from the sideband payload.
          const innerData = payload.slice(1);
          parsePktLineStatusStream(innerData, textDecoder, updates, (s) => {
            unpackStatus = s;
          });
        } else if (firstByte === 2) {
          // Progress message
          const content = textDecoder.decode(payload.slice(1)).trim();
          if (onProgress) onProgress(content);
        } else {
          // Error message
          const content = textDecoder.decode(payload.slice(1)).trim();
          throw new Error(`Server error: ${content}`);
        }
      } else {
        // Plain text (no sideband) — parse status directly
        const content = textDecoder.decode(payload).trim();
        parseStatusLine(content, updates, (s) => {
          unpackStatus = s;
        });
      }
    }

    offset += length;
  }

  // Fill in any missing updates
  for (const update of refUpdates) {
    if (!updates.has(update.refName)) {
      updates.set(update.refName, { ok: false, message: "No status received" });
    }
  }

  // Attach the remote's pre-push value to every entry — accepted, rejected or
  // unreported alike. The status lines carry only a ref name, so this is the
  // one place that still knows what the client sent as the old id.
  for (const update of refUpdates) {
    const result = updates.get(update.refName);
    if (result) result.oldOid = update.oldOid;
  }

  return { updates, unpackStatus };
}

/**
 * Simple pack writer for sending objects.
 */
class PackWriter {
  private objects: PushObject[] = [];

  addObject(obj: PushObject): void {
    this.objects.push(obj);
  }

  async finish(): Promise<Uint8Array> {
    if (this.objects.length === 0) {
      return createEmptyPack();
    }

    const textEncoder = new TextEncoder();
    const chunks: Uint8Array[] = [];

    // Pack header: "PACK" + version (2) + object count
    const header = new Uint8Array(12);
    header.set(textEncoder.encode("PACK"), 0);
    header[4] = 0;
    header[5] = 0;
    header[6] = 0;
    header[7] = 2;
    const count = this.objects.length;
    header[8] = (count >> 24) & 0xff;
    header[9] = (count >> 16) & 0xff;
    header[10] = (count >> 8) & 0xff;
    header[11] = count & 0xff;
    chunks.push(header);

    // Pack objects (with zlib compression)
    for (const obj of this.objects) {
      chunks.push(await encodePackObject(obj));
    }

    // Concatenate all chunks
    const dataLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const packContent = new Uint8Array(dataLength);
    let offset = 0;
    for (const chunk of chunks) {
      packContent.set(chunk, offset);
      offset += chunk.length;
    }

    // Compute SHA-1 checksum of pack content
    const checksum = await sha1(packContent);

    // Append checksum
    const packData = new Uint8Array(dataLength + 20);
    packData.set(packContent, 0);
    packData.set(checksum, dataLength);

    return packData;
  }
}

/**
 * Encode a single pack object with zlib compression.
 */
async function encodePackObject(obj: PushObject): Promise<Uint8Array> {
  const header: number[] = [];
  let size = obj.content.length;
  const typeBits = obj.type & 0x7;

  // First byte: type and size bits
  let byte = (typeBits << 4) | (size & 0x0f);
  size >>= 4;

  while (size > 0) {
    byte |= 0x80; // MSB continuation bit
    header.push(byte);
    byte = size & 0x7f;
    size >>= 7;
  }
  header.push(byte);

  // Zlib-compress the content (Git pack format requires this)
  const compressed = await compressBlock(obj.content);

  // Concatenate header and compressed content
  const result = new Uint8Array(header.length + compressed.length);
  result.set(new Uint8Array(header), 0);
  result.set(compressed, header.length);

  return result;
}
