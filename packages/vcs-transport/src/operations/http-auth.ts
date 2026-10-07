import type { Credentials } from "../api/credentials.js";

/**
 * The HTTP `Authorization` header value for the given credentials:
 * `Bearer <token>` when a token is set, Basic auth from username/password otherwise.
 */
export function authorizationHeader(auth: Credentials): string {
  if (auth.token) return `Bearer ${auth.token}`;
  const { username, password } = auth;
  return `Basic ${btoa(`${username}:${password}`)}`;
}
