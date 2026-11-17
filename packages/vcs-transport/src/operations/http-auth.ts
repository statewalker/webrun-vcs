import { encodeGitPath } from "@statewalker/vcs-utils/encoding";

import type { Credentials } from "../api/credentials.js";

/**
 * The HTTP `Authorization` header value for the given credentials: Basic auth.
 * A token is sent as the password, with `username` defaulting to `x-access-token`.
 *
 * The `user:password` text goes out as its bytes, as curl sends what git hands it: UTF-8,
 * with a byte that was not UTF-8 in the config (a lone surrogate U+DC80..U+DCFF, see
 * `decodeGitPath`) restored. `btoa` alone would throw on any character above U+00FF.
 */
export function authorizationHeader(auth: Credentials): string {
  if (auth.token) return `Basic ${base64(`${auth.username ?? "x-access-token"}:${auth.token}`)}`;
  const { username, password } = auth;
  return `Basic ${base64(`${username}:${password}`)}`;
}

function base64(text: string): string {
  let binary = "";
  for (const byte of encodeGitPath(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
