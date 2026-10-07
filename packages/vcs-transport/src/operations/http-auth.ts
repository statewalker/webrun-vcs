import type { Credentials } from "../api/credentials.js";

/**
 * The HTTP `Authorization` header value for the given credentials: Basic auth.
 * A token is sent as the password, with `username` defaulting to `x-access-token`.
 */
export function authorizationHeader(auth: Credentials): string {
  if (auth.token) return `Basic ${btoa(`${auth.username ?? "x-access-token"}:${auth.token}`)}`;
  const { username, password } = auth;
  return `Basic ${btoa(`${username}:${password}`)}`;
}
