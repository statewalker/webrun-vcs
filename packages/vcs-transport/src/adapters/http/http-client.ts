/**
 * HTTP Smart Protocol client.
 *
 * Performs Git fetch over HTTP smart protocol:
 * 1. GET /info/refs?service=git-upload-pack - Get refs
 * 2. POST /git-upload-pack - Negotiate and receive pack
 */

import type { FetchResult } from "../../api/fetch-result.js";
import type { RepositoryFacade } from "../../api/repository-facade.js";
import type { RefStore } from "../../context/process-context.js";
import { ProtocolState } from "../../context/protocol-state.js";
import type { PushResult, RefPushStatus } from "../../operations/push-over-duplex.js";
import { parseBufferedAdvertisement } from "../../protocol/advertisement-parser.js";
import { ZERO_OID } from "../../protocol/constants.js";
import { createEmptyPack } from "../../protocol/pack-utils.js";
import { encodeFlush, encodePacketLine } from "../../protocol/pkt-line-codec.js";
import { parseReportStatusLines } from "../../protocol/report-status.js";
import {
  collectChunks,
  decodeSidebandResponse,
  readableStreamToAsyncIterable,
} from "./http-duplex.js";

/**
 * Options for HTTP fetch operation.
 */
export interface HttpFetchOptions {
  /** Local HEAD ref for negotiation */
  localHead?: string;
  /** Maximum haves to send during negotiation */
  maxHaves?: number;
  /** Shallow clone depth */
  depth?: number;
  /** Filter spec for partial clone */
  filter?: string;
  /** Refs to fetch (if not all) */
  refSpecs?: string[];
  /** Skip updating refStore (for dry run). Defaults to false. */
  skipRefUpdate?: boolean;
  /** Custom fetch function (for testing or different environments) */
  fetchFn?: typeof fetch;
}

const textDecoder = new TextDecoder();

/**
 * Performs a Git fetch over HTTP smart protocol.
 *
 * @param url - Repository URL (e.g., "https://github.com/user/repo.git")
 * @param repository - Repository facade for pack import
 * @param refStore - Ref store for reading/writing refs
 * @param options - Fetch options
 * @returns Fetch result
 *
 * @example
 * ```ts
 * const result = await httpFetch(
 *   "https://github.com/user/repo.git",
 *   repository,
 *   refStore,
 *   { localHead: "refs/heads/main" }
 * );
 *
 * if (result.success) {
 *   console.log("Updated refs:", result.updatedRefs);
 * }
 * ```
 */
export async function httpFetch(
  url: string,
  repository: RepositoryFacade,
  refStore: RefStore,
  options: HttpFetchOptions = {},
): Promise<FetchResult> {
  const fetchFn = options.fetchFn ?? fetch;

  // Normalize URL
  const baseUrl = url.endsWith("/") ? url.slice(0, -1) : url;

  try {
    // Phase 1: GET /info/refs to get ref advertisement
    const infoRefsUrl = `${baseUrl}/info/refs?service=git-upload-pack`;
    const infoRefsResponse = await fetchFn(infoRefsUrl, {
      method: "GET",
      headers: {
        Accept: "application/x-git-upload-pack-advertisement",
      },
    });

    if (!infoRefsResponse.ok) {
      return {
        success: false,
        error: `Failed to get refs: ${infoRefsResponse.status} ${infoRefsResponse.statusText}`,
      };
    }

    if (!infoRefsResponse.body) {
      return {
        success: false,
        error: "Empty response from /info/refs",
      };
    }

    // Parse ref advertisement
    const state = new ProtocolState();
    const infoRefsData = await collectChunks(readableStreamToAsyncIterable(infoRefsResponse.body));
    const advert = await parseBufferedAdvertisement(infoRefsData);
    for (const [ref, oid] of advert.refs) state.refs.set(ref, oid);
    for (const cap of advert.capabilities) state.capabilities.add(cap);

    // Check if there's anything to fetch
    if (state.refs.size === 0) {
      return {
        success: true,
        updatedRefs: new Map(),
        objectsImported: 0,
      };
    }

    // Phase 2: POST /git-upload-pack to negotiate and receive pack
    const uploadPackUrl = `${baseUrl}/git-upload-pack`;

    // Build request body: wants + haves + done
    const requestChunks: Uint8Array[] = [];

    // Determine what we want (all refs by default)
    let firstWant = true;
    for (const [_refName, oid] of state.refs) {
      state.wants.add(oid);

      // Add capabilities to first want line
      const caps = firstWant
        ? " multi_ack_detailed side-band-64k thin-pack no-progress include-tag ofs-delta no-done"
        : "";
      requestChunks.push(encodePacketLine(`want ${oid}${caps}`));
      firstWant = false;
    }
    requestChunks.push(encodeFlush());

    // Send haves for objects we already have
    const localRefs = await refStore.listAll();
    for (const [, localOid] of localRefs) {
      const hasObject = await repository.has(localOid);
      if (hasObject) {
        state.haves.add(localOid);
        requestChunks.push(encodePacketLine(`have ${localOid}`));
      }
    }

    // Send done (flush before done only needed for multi_ack negotiation rounds)
    if (state.haves.size > 0) {
      requestChunks.push(encodeFlush());
    }
    requestChunks.push(encodePacketLine("done"));

    // Concatenate request body
    const requestBodyLength = requestChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const requestBody = new Uint8Array(requestBodyLength);
    let offset = 0;
    for (const chunk of requestChunks) {
      requestBody.set(chunk, offset);
      offset += chunk.length;
    }

    // Send POST request
    const uploadPackResponse = await fetchFn(uploadPackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-upload-pack-request",
        Accept: "application/x-git-upload-pack-result",
      },
      body: requestBody,
    });

    if (!uploadPackResponse.ok) {
      return {
        success: false,
        error: `Failed to upload-pack: ${uploadPackResponse.status} ${uploadPackResponse.statusText}`,
      };
    }

    if (!uploadPackResponse.body) {
      return {
        success: false,
        error: "Empty response from /git-upload-pack",
      };
    }

    // Process response - skip ACK/NAK, import pack
    const responseData = await collectChunks(
      readableStreamToAsyncIterable(uploadPackResponse.body),
    );

    // Decode sideband-encoded response
    const sidebandResult = decodeSidebandResponse(responseData);

    // Check for server error
    if (sidebandResult.error) {
      return {
        success: false,
        error: sidebandResult.error,
      };
    }

    // Import pack data if we got any
    let objectsImported = 0;
    if (sidebandResult.packData.length > 0) {
      const packData = sidebandResult.packData;
      const packStream = (async function* () {
        yield packData;
      })();
      const importResult = await repository.importPack(packStream);
      objectsImported = importResult.objectsImported;
    }

    // Build updated refs map (apply refspec mapping if provided)
    const updatedRefs = new Map<string, string>();
    for (const [refName, oid] of state.refs) {
      const localRef = applyRefspecMapping(refName, options.refSpecs);
      if (localRef) {
        updatedRefs.set(localRef, oid);
      }
    }

    // Update refStore so subsequent fetches can send correct have lines
    if (!options.skipRefUpdate) {
      for (const [localRef, oid] of updatedRefs) {
        await refStore.update(localRef, oid);
      }
    }

    return {
      success: true,
      updatedRefs,
      objectsImported,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Apply refspec mapping to a remote ref name.
 *
 * Returns the local ref name if the remote ref matches a refspec,
 * or the original name if no refspecs are provided.
 * Returns undefined if refspecs are provided but none match.
 *
 * @param remoteRef - Remote ref name (e.g., "refs/heads/main")
 * @param refSpecs - Optional refspecs (e.g., ["refs/heads/main:refs/remotes/origin/main"])
 * @returns Mapped local ref name, or undefined if filtered out
 */
function applyRefspecMapping(remoteRef: string, refSpecs?: string[]): string | undefined {
  if (!refSpecs || refSpecs.length === 0) {
    return remoteRef;
  }

  for (const spec of refSpecs) {
    // Strip force prefix
    const refspec = spec.startsWith("+") ? spec.slice(1) : spec;
    const colonIdx = refspec.indexOf(":");
    if (colonIdx < 0) continue;

    const src = refspec.slice(0, colonIdx);
    const dst = refspec.slice(colonIdx + 1);

    // Wildcard matching
    const srcWild = src.indexOf("*");
    if (srcWild >= 0) {
      const srcPrefix = src.slice(0, srcWild);
      const srcSuffix = src.slice(srcWild + 1);
      if (remoteRef.startsWith(srcPrefix) && remoteRef.endsWith(srcSuffix)) {
        const endPos = srcSuffix.length > 0 ? remoteRef.length - srcSuffix.length : undefined;
        const matched = remoteRef.slice(srcPrefix.length, endPos);
        const dstWild = dst.indexOf("*");
        if (dstWild >= 0) {
          return dst.slice(0, dstWild) + matched + dst.slice(dstWild + 1);
        }
        return dst;
      }
    } else if (src === remoteRef) {
      // Exact match
      return dst;
    }
  }

  return undefined;
}

/**
 * Extract text lines from pkt-line encoded data, stripping length prefixes
 * and sideband channel bytes.
 */
function extractPktLineText(data: Uint8Array): string[] {
  const lines: string[] = [];
  let offset = 0;

  while (offset + 4 <= data.length) {
    const lengthHex = textDecoder.decode(data.slice(offset, offset + 4));
    if (lengthHex === "0000") break;

    const length = parseInt(lengthHex, 16);
    if (Number.isNaN(length) || length < 4) break;
    if (offset + length > data.length) break;

    let payload = textDecoder.decode(data.slice(offset + 4, offset + length));
    if (payload.endsWith("\n")) payload = payload.slice(0, -1);
    offset += length;

    // Strip sideband channel prefix if present
    if (payload.length > 0 && (payload[0] === "\x01" || payload[0] === "\x02")) {
      payload = payload.slice(1);
    }

    const trimmed = payload.trim();
    if (trimmed) lines.push(trimmed);
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Push Client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for HTTP push operation.
 */
export interface HttpPushOptions {
  /** Refs to push (format: "local:remote" or "refname") */
  refspecs: string[];
  /** Use atomic push (all refs succeed or all fail) */
  atomic?: boolean;
  /** Push options to send to server */
  pushOptions?: string[];
  /** Credentials for authentication */
  credentials?: { username: string; password: string };
  /** Additional headers to send */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Progress callback */
  onProgress?: (message: string) => void;
  /** Custom fetch function (for testing or different environments) */
  fetchFn?: typeof fetch;
}

/**
 * Performs a Git push over HTTP smart protocol.
 */
export async function httpPush(
  url: string,
  repository: RepositoryFacade,
  refStore: RefStore,
  options: HttpPushOptions,
): Promise<PushResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const { refspecs, atomic = false, pushOptions = [], credentials, headers = {} } = options;

  // Normalize URL
  const baseUrl = url.endsWith("/") ? url.slice(0, -1) : url;

  // Build authorization header if credentials provided
  const authHeaders: Record<string, string> = {};
  if (credentials) {
    const authString = `${credentials.username}:${credentials.password}`;
    const base64Auth = btoa(authString);
    authHeaders.Authorization = `Basic ${base64Auth}`;
  }

  const combinedHeaders = { ...headers, ...authHeaders };

  try {
    // Phase 1: GET /info/refs?service=git-receive-pack
    options.onProgress?.("Fetching remote refs...");

    const infoRefsUrl = `${baseUrl}/info/refs?service=git-receive-pack`;
    const infoRefsResponse = await fetchFn(infoRefsUrl, {
      method: "GET",
      headers: {
        ...combinedHeaders,
        Accept: "application/x-git-receive-pack-advertisement",
      },
    });

    if (!infoRefsResponse.ok) {
      return {
        success: false,
        error: `Failed to get refs: ${infoRefsResponse.status} ${infoRefsResponse.statusText}`,
      };
    }

    if (!infoRefsResponse.body) {
      return {
        success: false,
        error: "Empty response from /info/refs",
      };
    }

    // Parse ref advertisement
    const state = new ProtocolState();
    const infoRefsData = await collectChunks(readableStreamToAsyncIterable(infoRefsResponse.body));
    const pushAdvert = await parseBufferedAdvertisement(infoRefsData);
    for (const [ref, oid] of pushAdvert.refs) state.refs.set(ref, oid);
    for (const cap of pushAdvert.capabilities) state.capabilities.add(cap);

    // Phase 2: Parse refspecs and determine what to push
    const refUpdates = await resolveRefspecs(refspecs, refStore, state.refs);

    if (refUpdates.length === 0) {
      return {
        success: true,
        refStatus: new Map(),
      };
    }

    // Phase 3: Build and send receive-pack request
    options.onProgress?.("Sending pack data...");

    const receivePackUrl = `${baseUrl}/git-receive-pack`;

    // Build request body
    const requestChunks: Uint8Array[] = [];

    // Send ref update commands
    let firstUpdate = true;
    const wantedOids = new Set<string>();

    for (const update of refUpdates) {
      // Collect OIDs we need to send
      if (update.newOid !== ZERO_OID) {
        wantedOids.add(update.newOid);
      }

      // Build capability string for first line (null byte separates refname from capabilities)
      const caps = firstUpdate
        ? `\0report-status side-band-64k${atomic ? " atomic" : ""}${pushOptions.length > 0 ? " push-options" : ""}`
        : "";

      const line = `${update.oldOid} ${update.newOid} ${update.refName}${caps}`;
      requestChunks.push(encodePacketLine(line));
      firstUpdate = false;
    }

    requestChunks.push(encodeFlush());

    // Send push options if supported
    if (pushOptions.length > 0 && state.capabilities.has("push-options")) {
      for (const option of pushOptions) {
        requestChunks.push(encodePacketLine(option));
      }
      requestChunks.push(encodeFlush());
    }

    // Generate and append pack data if we have objects to send
    if (wantedOids.size > 0) {
      // Determine what objects the server already has
      const excludeOids = new Set<string>();
      for (const oid of state.refs.values()) {
        excludeOids.add(oid);
      }

      // Export pack with objects the server doesn't have
      for await (const chunk of repository.exportPack(wantedOids, excludeOids)) {
        requestChunks.push(chunk);
      }
    } else {
      // Send empty pack for delete-only operations
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

    // Send POST request
    const receivePackResponse = await fetchFn(receivePackUrl, {
      method: "POST",
      headers: {
        ...combinedHeaders,
        "Content-Type": "application/x-git-receive-pack-request",
        Accept: "application/x-git-receive-pack-result",
      },
      body: requestBody,
    });

    if (!receivePackResponse.ok) {
      return {
        success: false,
        error: `Failed to receive-pack: ${receivePackResponse.status} ${receivePackResponse.statusText}`,
      };
    }

    if (!receivePackResponse.body) {
      return {
        success: false,
        error: "Empty response from /git-receive-pack",
      };
    }

    // Parse response to get ref statuses
    const responseData = await collectChunks(
      readableStreamToAsyncIterable(receivePackResponse.body),
    );

    // Decode sideband if the server uses side-band-64k.
    // After sideband decoding, channel 1 data contains pkt-line encoded
    // report-status lines. If no sideband, the raw response is pkt-line.
    const sidebandResult = decodeSidebandResponse(responseData);
    const statusData = sidebandResult.packData.length > 0 ? sidebandResult.packData : responseData;
    const statusLines = extractPktLineText(statusData);
    const reportStatus = parseReportStatusLines(statusLines);

    // Convert to RefPushStatus map. Every entry carries the object ids the
    // command was built from: `oldOid` is the remote's advertised value (the
    // compare-and-swap expectation the server checked), `newOid` the value
    // pushed. The report-status lines name only the ref, so the ids come from
    // the resolved ref updates, and are attached whatever the outcome.
    const oidsFor = new Map(
      refUpdates.map((update) => [
        update.refName,
        { oldOid: update.oldOid, newOid: update.newOid },
      ]),
    );
    const refStatus = new Map<string, RefPushStatus>();
    for (const update of refUpdates) {
      refStatus.set(update.refName, { success: true, ...oidsFor.get(update.refName) });
    }
    if (!reportStatus.unpackOk) {
      for (const update of refUpdates) {
        refStatus.set(update.refName, {
          success: false,
          error: reportStatus.unpackMessage ?? "unpack failed",
          ...oidsFor.get(update.refName),
        });
      }
    }
    for (const ref of reportStatus.refUpdates) {
      if (!ref.ok) {
        refStatus.set(ref.refName, {
          success: false,
          error: ref.message ?? "rejected",
          ...oidsFor.get(ref.refName),
        });
      }
    }

    // Check if all refs succeeded
    const allSuccess = reportStatus.ok;

    options.onProgress?.(allSuccess ? "Push complete" : "Push completed with errors");

    return {
      success: allSuccess,
      refStatus,
      error: allSuccess ? undefined : "Some refs failed to update",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Ref update command.
 */
interface RefUpdate {
  refName: string;
  oldOid: string;
  newOid: string;
}

/**
 * Resolves refspecs to ref update commands.
 */
async function resolveRefspecs(
  refspecs: string[],
  refStore: RefStore,
  remoteRefs: Map<string, string>,
): Promise<RefUpdate[]> {
  const updates: RefUpdate[] = [];

  for (const refspec of refspecs) {
    let localRef: string;
    let remoteRef: string;

    // Parse refspec (local:remote or just ref for same name)
    if (refspec.includes(":")) {
      const parts = refspec.split(":");
      localRef = parts[0];
      remoteRef = parts[1];
    } else {
      localRef = refspec;
      remoteRef = refspec;
    }

    // Handle deletion (empty local ref)
    if (localRef === "") {
      updates.push({
        refName: remoteRef,
        oldOid: remoteRefs.get(remoteRef) ?? ZERO_OID,
        newOid: ZERO_OID,
      });
      continue;
    }

    // Get local ref value
    const localOid = await refStore.get(localRef);
    if (!localOid) {
      // Skip refs we don't have locally
      continue;
    }

    updates.push({
      refName: remoteRef,
      oldOid: remoteRefs.get(remoteRef) ?? ZERO_OID,
      newOid: localOid,
    });
  }

  return updates;
}
