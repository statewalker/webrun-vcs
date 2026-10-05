/**
 * Base option interfaces for transport operations.
 *
 * Shared interfaces that capture common patterns across HTTP and duplex
 * transport operations.
 */

import type { Credentials } from "./credentials.js";
import type { Duplex } from "./duplex.js";
import type { RepositoryFacade } from "./repository-facade.js";

/**
 * Common HTTP transport options.
 */
export interface BaseHttpOptions {
  /** Remote URL */
  url: string;
  /** Authentication credentials */
  auth?: Credentials;
  /** Additional HTTP headers */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds */
  timeout?: number;
  /**
   * Fetch implementation used for the smart-HTTP requests. Defaults to
   * `globalThis.fetch` bound to `globalThis`. Normalized to a single
   * `(Request) => Promise<Response>` shape so an alternative transport (e.g. a
   * webrun-streams `Duplex`) can back the client without a network port.
   */
  fetchImpl?: (request: Request) => Promise<Response>;
}

/**
 * Common duplex transport options.
 */
export interface BaseDuplexOptions {
  /** Bidirectional stream to use for transport */
  duplex: Duplex;
  /** Repository facade for pack import/export */
  repository: RepositoryFacade;
}

/**
 * Common fetch options shared across transports.
 */
export interface BaseFetchOptions {
  /** Refspecs to fetch */
  refspecs?: string[];
  /** Shallow clone depth */
  depth?: number;
}

/**
 * Common push options shared across transports.
 */
export interface BasePushOptions {
  /** Refspecs to push (source:destination format) */
  refspecs?: string[];
  /** Force push even if not fast-forward */
  force?: boolean;
  /** Use atomic push (all-or-nothing) */
  atomic?: boolean;
}
