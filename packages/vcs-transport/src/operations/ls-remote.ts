/**
 * High-level ls-remote operation.
 *
 * Lists references in a remote repository without downloading objects.
 */

import type { Credentials } from "../api/credentials.js";
import { parseBufferedAdvertisement } from "../protocol/advertisement-parser.js";

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

    // Parse the pkt-line advertisement. Splitting on newlines does not work: a flush packet
    // (0000) carries none, so it would be read as part of the next ref's line.
    return (await parseBufferedAdvertisement(data)).refs;
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
