/**
 * Base option interfaces for transport operations.
 *
 * Shared interfaces that capture common patterns across HTTP and duplex
 * transport operations.
 */

import type { Credentials } from "./credentials.js";

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
