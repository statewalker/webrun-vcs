/**
 * Git protocol request parser.
 *
 * Parses the initial git:// protocol request line that the server receives
 * when a client connects.
 *
 * Protocol format:
 *   <length><service> <path>\0host=<host>\0[extra-parameters]
 *
 * Examples:
 *   0033git-upload-pack /user/repo.git\0host=github.com\0
 *   0036git-receive-pack /user/repo.git\0host=github.com\0
 *
 * Format details:
 * - Length: 4 hex digits (pkt-line format)
 * - Service: "git-upload-pack" or "git-receive-pack"
 * - Path: repository path (starts with /)
 * - NUL byte separator
 * - Host parameter (required for remote, optional for local)
 * - Optional: extra parameters after second NUL (e.g., version=2)
 */

import { parsePacket } from "./pkt-line-codec.js";
import type { ServiceType } from "./types.js";

/** Git protocol service type alias. */
export type GitProtocolService = ServiceType;

/**
 * Parsed git:// protocol request.
 */
export interface GitProtocolRequest {
  /** The requested service */
  service: GitProtocolService;
  /** Repository path */
  path: string;
  /** Host name (may be empty for local connections) */
  host: string;
  /** Extra parameters (e.g., version=2) */
  extraParams?: Map<string, string>;
}

/**
 * Parse git:// protocol initial request from raw bytes.
 *
 * @param data - Raw request bytes (after pkt-line length prefix is stripped)
 * @returns Parsed request
 * @throws Error if request is invalid
 */
export function parseGitProtocolRequest(data: Uint8Array): GitProtocolRequest {
  const decoder = new TextDecoder();
  const text = decoder.decode(data);

  // Split by NUL bytes
  const parts = text.split("\0");

  if (parts.length < 1 || !parts[0]) {
    throw new Error("Invalid git protocol request: empty request");
  }

  // First part: "service path"
  const serviceAndPath = parts[0];
  const spaceIndex = serviceAndPath.indexOf(" ");

  if (spaceIndex === -1) {
    throw new Error("Invalid git protocol request: no space between service and path");
  }

  const service = serviceAndPath.slice(0, spaceIndex);
  const path = serviceAndPath.slice(spaceIndex + 1);

  // Validate service
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    throw new Error(`Unknown git service: ${service}`);
  }

  // Parse host parameter (second part, if present)
  let host = "";
  if (parts.length > 1 && parts[1]) {
    const hostParam = parts[1];
    if (hostParam.startsWith("host=")) {
      host = hostParam.slice(5);
    }
  }

  // Parse extra parameters (remaining parts)
  let extraParams: Map<string, string> | undefined;
  for (let i = 2; i < parts.length; i++) {
    const param = parts[i];
    if (!param) continue;

    const eqIndex = param.indexOf("=");
    if (eqIndex !== -1) {
      if (!extraParams) {
        extraParams = new Map();
      }
      const key = param.slice(0, eqIndex);
      const value = param.slice(eqIndex + 1);
      extraParams.set(key, value);
    }
  }

  return {
    service: service as GitProtocolService,
    path: path || "/",
    host,
    extraParams,
  };
}

/**
 * Parse git:// protocol request from an input stream.
 *
 * Reads exactly one pkt-line from the stream and parses it.
 *
 * @param input - The async iterable to read from
 * @returns Parsed request
 * @throws Error if request is invalid or connection closed
 */
export async function readGitProtocolRequest(
  input: AsyncIterable<Uint8Array>,
): Promise<GitProtocolRequest> {
  // Collect bytes until we have a complete pkt-line
  const chunks: Uint8Array[] = [];
  let buffer = new Uint8Array(0);

  for await (const chunk of input) {
    // Append chunk to buffer
    const newBuffer = new Uint8Array(buffer.length + chunk.length);
    newBuffer.set(buffer, 0);
    newBuffer.set(chunk, buffer.length);
    buffer = newBuffer;
    chunks.push(chunk);

    // Try to parse a packet
    const result = parsePacket(buffer);
    if (result !== null) {
      if (result.packet.type !== "data" || !result.packet.data) {
        throw new Error("Invalid git protocol request: expected data packet");
      }
      return parseGitProtocolRequest(result.packet.data);
    }
  }

  throw new Error("Connection closed before complete request received");
}

/**
 * Encode a git:// protocol request.
 *
 * Creates the wire format for a git protocol request, including pkt-line length.
 *
 * @param request - The request to encode
 * @returns Encoded request bytes (with pkt-line length prefix)
 */
export function encodeGitProtocolRequest(request: GitProtocolRequest): Uint8Array {
  const encoder = new TextEncoder();

  // Build content: "service path\0host=host\0[extra params]"
  let content = `${request.service} ${request.path}\0`;

  if (request.host) {
    content += `host=${request.host}\0`;
  } else {
    // Always include empty host parameter for compatibility
    content += `host=\0`;
  }

  // Add extra parameters
  if (request.extraParams) {
    for (const [key, value] of request.extraParams) {
      content += `${key}=${value}\0`;
    }
  }

  const payload = encoder.encode(content);

  // pkt-line format: 4 hex digits length (includes the 4 bytes) + payload
  const length = payload.length + 4;
  const lengthHex = length.toString(16).padStart(4, "0");
  const lengthBytes = encoder.encode(lengthHex);

  const result = new Uint8Array(length);
  result.set(lengthBytes, 0);
  result.set(payload, 4);

  return result;
}

/**
 * Git protocol default port (9418).
 */
export const GIT_PROTOCOL_DEFAULT_PORT = 9418;

/**
 * Check if a service is valid.
 */
export function isValidService(service: string): service is GitProtocolService {
  return service === "git-upload-pack" || service === "git-receive-pack";
}

/**
 * Convert Map-based extraParams to string array format.
 * For backward compatibility with ServerProtocolSession.
 */
export function extraParamsToArray(extraParams?: Map<string, string>): string[] {
  if (!extraParams) return [];
  return Array.from(extraParams.entries()).map(([key, value]) => `${key}=${value}`);
}

/**
 * Extract protocol version from parsed request.
 */
export function getProtocolVersion(extraParams?: Map<string, string>): "1" | "2" | undefined {
  if (!extraParams) return undefined;
  const version = extraParams.get("version");
  if (version === "2") return "2";
  if (version === "1") return "1";
  return undefined;
}
