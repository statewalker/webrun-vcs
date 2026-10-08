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
  /** Access token, sent as the HTTP Basic password (username defaults to `x-access-token`) */
  token?: string;
}

export type { ProgressInfo } from "../protocol/types.js";
