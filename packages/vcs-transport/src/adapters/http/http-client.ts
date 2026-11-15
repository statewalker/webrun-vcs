/**
 * HTTP Smart Protocol push client (fetch over HTTP is `fetch` in operations, on the shared
 * fetch client).
 *
 * Performs Git push over HTTP smart protocol:
 * 1. GET /info/refs?service=git-receive-pack - Get refs
 * 2. POST /git-receive-pack - Send commands and pack, read report-status
 */

import { fetchWithRequestBody, shouldStreamRequestBody } from "@statewalker/vcs-utils/streams";
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

const textDecoder = new TextDecoder();

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
  /**
   * Stream the request body (fetch `duplex: "half"`). Default: outside browsers, where the
   * runtime supports it; browsers collect the body first unless this is `true` (Chromium
   * refuses streamed bodies over HTTP/1.1). A streamed request that fails with a `TypeError`
   * before any response is sent once more with a collected body.
   */
  streamRequestBody?: boolean;
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
    // OFS deltas only when the server advertised ofs-delta
    const ofsDelta = state.capabilities.has("ofs-delta");

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
        ? `\0report-status side-band-64k${atomic ? " atomic" : ""}${pushOptions.length > 0 ? " push-options" : ""}${ofsDelta ? " ofs-delta" : ""}`
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

    // The pack follows the commands, streamed as it is written where the runtime streams
    // request bodies (otherwise collected first: Firefox, Safari)
    const excludeOids = new Set<string>(state.refs.values());
    async function* body(): AsyncGenerator<Uint8Array> {
      yield* requestChunks;
      if (wantedOids.size > 0) {
        // the objects the server does not have
        yield* repository.exportPack(wantedOids, excludeOids, { ofsDelta });
      } else {
        // an empty pack for delete-only operations
        yield createEmptyPack();
      }
    }

    // Send POST request (retried once with a collected body if a streamed one is refused)
    const receivePackResponse = await fetchWithRequestBody(
      body,
      (init) =>
        fetchFn(receivePackUrl, {
          method: "POST",
          headers: {
            ...combinedHeaders,
            "Content-Type": "application/x-git-receive-pack-request",
            Accept: "application/x-git-receive-pack-result",
          },
          ...init,
        } as RequestInit),
      shouldStreamRequestBody(options.streamRequestBody),
    );

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
