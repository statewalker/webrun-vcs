/**
 * Authentication credentials for transport operations.
 */

/**
 * Credentials for authenticating with remote repositories.
 *
 * Supports username/password authentication and token-based authentication.
 */
export interface Credentials {
  /** Username for HTTP Basic authentication */
  username?: string;
  /** Password for HTTP Basic authentication */
  password?: string;
  /** Bearer token for token-based authentication */
  token?: string;
}

export type { ProgressInfo } from "../protocol/types.js";
