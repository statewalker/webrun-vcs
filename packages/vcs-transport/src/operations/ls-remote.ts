/**
 * High-level ls-remote operation.
 *
 * Lists references in a remote repository without downloading objects.
 */

import type { Credentials } from "../api/credentials.js";

/**
 * Options for ls-remote operation.
 */
export interface LsRemoteOptions {
  /** Authentication credentials */
  auth?: Credentials;
  /** Additional HTTP headers */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds */
  timeout?: number;
  /**
   * Fetch implementation used for the smart-HTTP request. Defaults to
   * `globalThis.fetch` bound to `globalThis`. Normalized to a single
   * `(Request) => Promise<Response>` shape so an alternative transport (e.g. a
   * webrun-streams `Duplex`) can back the client without a network port.
   */
  fetchImpl?: (request: Request) => Promise<Response>;
}

/**
 * List references in a remote repository.
 *
 * Connects to the remote and retrieves the list of refs without
 * downloading any objects.
 *
 * @param url - Remote repository URL
 * @param options - Optional settings
 * @returns Map of ref names to object ID hex strings
 *
 * @example
 * ```ts
 * const refs = await lsRemote("https://github.com/user/repo.git");
 *
 * for (const [refName, objectId] of refs) {
 *   console.log(`${refName} -> ${objectId}`);
 * }
 * ```
 */
export async function lsRemote(
  url: string,
  options?: LsRemoteOptions,
): Promise<Map<string, string>> {
  // Normalize URL
  const baseUrl = url.endsWith("/") ? url.slice(0, -1) : url;
  const infoRefsUrl = `${baseUrl}/info/refs?service=git-upload-pack`;

  // Build request headers
  const headers: Record<string, string> = {
    Accept: "application/x-git-upload-pack-advertisement",
    ...options?.headers,
  };

  // Add authentication if provided
  if (options?.auth) {
    const { username, password } = options.auth;
    const credentials = btoa(`${username}:${password}`);
    headers.Authorization = `Basic ${credentials}`;
  }

  // Perform the HTTP request
  const controller = options?.timeout ? new AbortController() : undefined;
  const timeoutId = options?.timeout
    ? setTimeout(() => controller?.abort(), options.timeout)
    : undefined;

  // Normalize to a single (Request) => Promise<Response> shape; default to
  // native fetch, preserving exact behavior when fetchImpl is omitted.
  const doFetch = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);

  try {
    const response = await doFetch(
      new Request(infoRefsUrl, {
        method: "GET",
        headers,
        signal: controller?.signal,
      }),
    );

    if (timeoutId) clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error("Empty response from /info/refs");
    }

    // Read response body
    const data = new Uint8Array(await response.arrayBuffer());

    // Parse ref advertisement
    return parseRefAdvertisement(data);
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
 * Parse ref advertisement from HTTP response.
 *
 * Handles Git smart HTTP protocol format:
 * - Service announcement line
 * - Pkt-line formatted refs (4-byte hex length prefix)
 * - First ref includes capabilities after null byte
 */
function parseRefAdvertisement(data: Uint8Array): Map<string, string> {
  const refs = new Map<string, string>();
  const textDecoder = new TextDecoder();
  const text = textDecoder.decode(data);
  const lines = text.split("\n");

  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) continue;

    // Skip flush packets (0000) and delim packets (0001)
    if (line.trim() === "0000" || line.trim() === "0001") {
      continue;
    }

    // Skip service announcement
    if (line.includes("# service=")) {
      continue;
    }

    // Extract content (remove pkt-line length prefix if present)
    let content = line;
    if (/^[0-9a-f]{4}/.test(content)) {
      content = content.slice(4);
    }

    // Parse ref line: "OID refname\0capabilities" or "OID refname"
    const nullIndex = content.indexOf("\0");
    const refPart = nullIndex >= 0 ? content.slice(0, nullIndex) : content;

    // Parse ref: "OID refname"
    const spaceIndex = refPart.indexOf(" ");
    if (spaceIndex > 0) {
      const oid = refPart.slice(0, spaceIndex);
      const refName = refPart.slice(spaceIndex + 1).trim();

      // Skip capabilities^{} pseudo-ref and peeled refs
      if (!refName.endsWith("^{}") && !refName.startsWith("capabilities") && refName.length > 0) {
        refs.set(refName, oid);
      }
    }
  }

  return refs;
}
