/**
 * HTTP Digest authentication (RFC 7616) as curl answers a challenge for git: the
 * `WWW-Authenticate: Digest ...` of a 401 gives the realm, nonce, opaque value, algorithm and
 * qop, and each request then carries `Authorization: Digest ...` computed from the user's
 * name and password, the request's method and its path (curl's `uri`). The parameters are
 * written in curl's order and quoting (lib/vauth/digest.c), so a server sees what native git
 * sends.
 *
 * Supported: `algorithm` MD5 (the default), SHA-256 and SHA-512-256, each with its `-sess`
 * variant (curl 7.57+), `qop=auth` or none (RFC 2069), `userhash`, `stale`. A challenge of
 * another algorithm or with only `qop=auth-int` is not answered: the client falls back to
 * Basic when the server offers it, else the request stays refused.
 *
 * @example
 * ```ts
 * const challenge = parseDigestChallenge('Digest realm="r", nonce="n", qop="auth"');
 * const value = digestAuthorization(challenge!, { username: "alice", password: "pw" }, {
 *   method: "GET", uri: "/repo.git/info/refs?service=git-upload-pack", nc: 1, cnonce: "abc",
 * });
 * // 'Digest username="alice", realm="r", nonce="n", uri="/repo.git/...", cnonce="abc", nc=00000001, qop=auth, response="..."'
 * ```
 */

import { md5Hex, sha256Hex, sha512_256Hex } from "@statewalker/vcs-utils/hash";

/** The hash of each algorithm a challenge may name (lower case, without `-sess`). */
const HASHES: Record<string, (text: string) => string> = {
  md5: md5Hex,
  "sha-256": sha256Hex,
  "sha-512-256": sha512_256Hex,
};

/** A Digest challenge the client can answer. */
export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  /** The algorithm as the server spelled it (`MD5`, `SHA-256-sess`), if it named one */
  algorithm?: string;
  /** The algorithm's hash, hex digits out */
  hash: (text: string) => string;
  /** Whether `algorithm` is a `-sess` variant */
  session: boolean;
  /** `auth` when the server offers it; undefined: RFC 2069's answer without qop */
  qop?: "auth";
  /** `stale=true`: the nonce expired, the credentials were right */
  stale: boolean;
  /** `userhash=true`: the user name is sent hashed */
  userhash: boolean;
}

/** The auth-params of a challenge or credentials (`name=token` or `name="quoted"`). */
function authParams(text: string): Map<string, string> {
  const params = new Map<string, string>();
  let i = 0;
  while (i < text.length) {
    while (i < text.length && (text[i] === "," || text[i] === " " || text[i] === "\t")) i++;
    const nameStart = i;
    while (i < text.length && text[i] !== "=" && text[i] !== "," && text[i] !== " ") i++;
    const name = text.slice(nameStart, i).toLowerCase();
    while (text[i] === " ") i++;
    if (text[i] !== "=") {
      // a token without a value: skip to the next comma
      while (i < text.length && text[i] !== ",") i++;
      continue;
    }
    i++;
    while (text[i] === " ") i++;
    let value = "";
    if (text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) i++;
        value += text[i];
        i++;
      }
      i++;
    } else {
      const start = i;
      while (i < text.length && text[i] !== ",") i++;
      value = text.slice(start, i).trim();
    }
    if (name && !params.has(name)) params.set(name, value);
  }
  return params;
}

/**
 * The challenge of a `WWW-Authenticate` value (one challenge, `Digest ...`) when the client
 * can answer it, else undefined (another scheme, no nonce, an algorithm or qop not supported).
 */
export function parseDigestChallenge(challenge: string): DigestChallenge | undefined {
  const m = /^\s*digest\s+/i.exec(challenge);
  if (!m) return undefined;
  const params = authParams(challenge.slice(m[0].length));
  const nonce = params.get("nonce");
  if (nonce === undefined) return undefined;
  const algorithm = params.get("algorithm");
  const lower = algorithm?.toLowerCase() ?? "md5";
  const session = lower.endsWith("-sess");
  const hash = HASHES[session ? lower.slice(0, -"-sess".length) : lower];
  if (!hash) return undefined;
  let qop: "auth" | undefined;
  const qops = params.get("qop");
  if (qops !== undefined) {
    const offered = qops.split(",").map((q) => q.trim().toLowerCase());
    if (!offered.includes("auth")) return undefined;
    qop = "auth";
  }
  return {
    realm: params.get("realm") ?? "",
    nonce,
    ...(params.has("opaque") ? { opaque: params.get("opaque") as string } : {}),
    ...(algorithm !== undefined ? { algorithm } : {}),
    hash,
    session,
    ...(qop ? { qop } : {}),
    stale: params.get("stale")?.toLowerCase() === "true",
    userhash: params.get("userhash")?.toLowerCase() === "true",
  };
}

/** The first Digest challenge the client can answer among a 401's challenges. */
export function digestChallengeOf(challenges: readonly string[]): DigestChallenge | undefined {
  for (const challenge of challenges) {
    const parsed = parseDigestChallenge(challenge);
    if (parsed) return parsed;
  }
  return undefined;
}

/** curl's auth_digest_string_quoted: `"` and `\` escaped with a backslash. */
function quoted(text: string): string {
  return text.replace(/["\\]/g, (c) => `\\${c}`);
}

/** What one answer to a challenge depends on besides the credentials. */
export interface DigestRequest {
  method: string;
  /** The request's path and query, as sent (curl's `uripath`) */
  uri: string;
  /** The nonce count of this answer (1 for the first answer to a nonce) */
  nc: number;
  /** The client nonce */
  cnonce: string;
}

/**
 * The `Authorization` value answering `challenge` (RFC 7616 3.4), parameters in curl's order:
 * username, realm, nonce, uri, then cnonce, nc, qop with a qop, response, opaque, algorithm,
 * userhash.
 */
export function digestAuthorization(
  challenge: DigestChallenge,
  credentials: { username: string; password: string },
  request: DigestRequest,
): string {
  const { realm, nonce } = challenge;
  const { username, password } = credentials;
  const h = challenge.hash;
  let ha1 = h(`${username}:${realm}:${password}`);
  if (challenge.session) ha1 = h(`${ha1}:${nonce}:${request.cnonce}`);
  const ha2 = h(`${request.method}:${request.uri}`);
  const nc = request.nc.toString(16).padStart(8, "0");
  const response = challenge.qop
    ? h(`${ha1}:${nonce}:${nc}:${request.cnonce}:${challenge.qop}:${ha2}`)
    : h(`${ha1}:${nonce}:${ha2}`);
  const user = challenge.userhash ? h(`${username}:${realm}`) : quoted(username);
  let value = `Digest username="${user}", realm="${quoted(realm)}", nonce="${quoted(nonce)}", uri="${request.uri}"`;
  if (challenge.qop) {
    value += `, cnonce="${request.cnonce}", nc=${nc}, qop=${challenge.qop}`;
  }
  value += `, response="${response}"`;
  if (challenge.opaque !== undefined) value += `, opaque="${quoted(challenge.opaque)}"`;
  if (challenge.algorithm !== undefined) value += `, algorithm=${challenge.algorithm}`;
  if (challenge.userhash) value += ", userhash=true";
  return value;
}

/** A client nonce: 32 random hex digits, as curl's `Curl_rand_hex`. */
export function digestClientNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
