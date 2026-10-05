/**
 * High-level clone operation.
 *
 * Provides a simplified interface for cloning a remote repository
 * over HTTP/HTTPS.
 */

import type { ProgressInfo } from "../api/credentials.js";
import type { RawFetchResult } from "../api/fetch-result.js";
import type { BaseHttpOptions } from "../api/options.js";
import { fetch as httpFetch } from "./fetch.js";

/**
 * @deprecated Use {@link RawFetchResult} from `api/fetch-result.js` instead.
 */
export type CloneResult = RawFetchResult;

/**
 * Options for the clone operation.
 */
export interface CloneOptions extends BaseHttpOptions {
  /** Branch to clone (if not specified, uses default branch) */
  branch?: string;
  /** Shallow clone depth (omit for full clone) */
  depth?: number;
  /** Create a bare repository */
  bare?: boolean;
  /** Name to give the remote (default: "origin") */
  remoteName?: string;
  /** Progress callback */
  onProgress?: (info: ProgressInfo) => void;
  /** Progress message callback */
  onProgressMessage?: (message: string) => void;
}

/**
 * Clone a remote repository.
 *
 * Performs an initial fetch of all refs and objects from a remote repository.
 *
 * @param options - Clone options
 * @returns Clone result with refs and pack data
 *
 * @example
 * ```ts
 * const result = await clone({
 *   url: "https://github.com/user/repo.git",
 * });
 *
 * console.log("Default branch:", result.defaultBranch);
 * console.log("Bytes received:", result.bytesReceived);
 * ```
 */
export async function clone(options: CloneOptions): Promise<CloneResult> {
  // Clone is essentially a fetch with no local objects (no haves)
  // We want all refs from the remote
  const fetchResult = await httpFetch({
    url: options.url,
    auth: options.auth,
    headers: options.headers,
    timeout: options.timeout,
    fetchImpl: options.fetchImpl,
    depth: options.depth,
    onProgress: options.onProgress,
    onProgressMessage: options.onProgressMessage,
    // No local objects for clone
    localHas: undefined,
    localCommits: undefined,
    // Fetch all refs by default (no refspecs filtering)
    refspecs: options.branch
      ? [`+refs/heads/${options.branch}:refs/heads/${options.branch}`]
      : undefined,
  });

  return {
    refs: fetchResult.refs,
    packData: fetchResult.packData,
    defaultBranch: fetchResult.defaultBranch,
    bytesReceived: fetchResult.bytesReceived,
    isEmpty: fetchResult.isEmpty,
  };
}
