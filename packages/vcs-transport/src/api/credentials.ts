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
  /**
   * An authentication scheme with its ready credential (git's credential `authtype` and
   * `credential`, 2.46+): sent as `Authorization: <authtype> <credential>`, before any
   * username or password (`Bearer` and a token, `Basic` and its base64 text).
   */
  authtype?: string;
  /** The credential of {@link authtype} */
  credential?: string;
}

/**
 * Whether credentials hold a secret to send (git's `username && password`, or `authtype &&
 * credential`; ours also a token).
 */
export function hasSecret(credentials: Credentials | undefined): boolean {
  if (!credentials) return false;
  if (credentials.authtype && credentials.credential) return true;
  if (credentials.token) return true;
  return credentials.username !== undefined && credentials.password !== undefined;
}

export type { ProgressInfo } from "../protocol/types.js";
