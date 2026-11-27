/**
 * What git's `http.*` configuration (http.c's `http_options`) asks of the HTTP client, and
 * the credential helper git's `credential_fill` / `credential_approve` / `credential_reject`
 * talk to. The settings come from the configuration of the remote's URL (`http.<url>.*`,
 * read by the commands); here they only shape the requests.
 *
 * What stays the host `fetch`'s: TLS (`http.sslVerify`, `sslCAInfo`, client certificates),
 * proxies (`http.proxy`, `HTTPS_PROXY`), cookies, HTTP versions, low-speed limits and the
 * Negotiate/NTLM schemes (a browser speaks them itself). Basic, Digest (RFC 7616, MD5) and a
 * helper's `authtype` are the client's own. A browser also drops a
 * `User-Agent` it does not allow and follows redirects it cannot show (`opaqueredirect`).
 *
 * @example
 * ```ts
 * const settings: HttpClientSettings = {
 *   extraHeaders: ["X-Request-Id: 42"],
 *   userAgent: "git/2.56.1",
 *   followRedirects: "initial",
 *   maxRetries: 3,
 *   retryAfter: 1,
 * };
 * ```
 */

import type { Credentials } from "../api/credentials.js";

/** `http.followRedirects`: `true` (always), `false` (none) or `initial` (git's default). */
export type FollowRedirects = "always" | "none" | "initial";

/** How the HTTP client talks to a server, as git's `http.*` keys set it. */
export interface HttpClientSettings {
  /**
   * `http.extraHeader`: header lines (`Name: value`) added to every request, in order. A
   * line overrides a header the client sets itself (`Authorization`, `User-Agent`), as curl
   * replaces its own header by a custom one; a line `Name:` with no value removes it.
   */
  extraHeaders?: readonly string[];
  /** `http.userAgent` / `GIT_HTTP_USER_AGENT`: the `User-Agent` sent (none: the host's) */
  userAgent?: string;
  /**
   * `http.followRedirects` (default `initial`): `initial` follows redirects of the first
   * request (`info/refs`) only and re-roots the later ones at the URL it ended at; `always`
   * follows every redirect; `none` takes a redirect for an error.
   */
  followRedirects?: FollowRedirects;
  /**
   * `http.emptyAuth`: `true` answers a 401 with empty credentials (`Basic Og==`) once before
   * asking the credential helper; `false` and `auto` (default) do not (`auto` would only for
   * Negotiate, which is the host's).
   */
  emptyAuth?: boolean | "auto";
  /**
   * `http.proactiveAuth` (git 2.46+): `basic` and `auto` ask the credential helper before the
   * first request and send its credentials with it (`basic` tells the helper
   * `wwwauth[]=Basic`; a user and password go as Basic, an `authtype` as it is); `none`
   * (default) waits for a 401. The commands leave it unset under git 2.43 compatibility.
   */
  proactiveAuth?: "basic" | "auto" | "none";
  /**
   * `http.maxRetries` / `GIT_HTTP_MAX_RETRIES`: requests made in all when the first request
   * (`info/refs`) answers 429 Too Many Requests (git counts the first: 3 retries twice);
   * 0 (default) fails at once.
   */
  maxRetries?: number;
  /**
   * `http.retryAfter` / `GIT_HTTP_RETRY_AFTER`: seconds to wait before a retry when the 429
   * names no `Retry-After` (default 0)
   */
  retryAfter?: number;
  /**
   * `http.maxRetryTime` / `GIT_HTTP_MAX_RETRY_TIME`: the longest wait in seconds (default
   * 300); a longer one fails at once
   */
  maxRetryTime?: number;
  /**
   * Whether a 429 is retried at all: git 2.52 added the retries; false answers a 429 as git
   * 2.43 does (`The requested URL returned error: 429`). Default true.
   */
  rateLimitRetries?: boolean;
  /** Waits `ms` milliseconds before a retry (default `setTimeout`) */
  sleep?(ms: number): Promise<void>;
  /** git's `warning:` lines on stderr (`rate limited, waiting <n> seconds before retry`) */
  onWarning?(line: string): void;
}

/**
 * What git hands a credential helper (`credential fill`): the remote's protocol and host
 * (with its port), the user the URL names, and the challenges of the 401 (`wwwauth[]`).
 */
export interface CredentialRequest {
  /** The URL the request was for (the repository's, after a redirect the new one) */
  url: string;
  /** `http` or `https` */
  protocol: string;
  /** `host[:port]`, as git writes it */
  host: string;
  /** The user the URL names, if any */
  username?: string;
  /** The `WWW-Authenticate` challenges of the 401, one per challenge */
  wwwAuthenticate: string[];
}

/**
 * A credential helper as git's credential.c drives it: asked after a 401 (`fill`), told
 * when credentials worked (`approve`, git's `store`) and when the server refused them
 * (`reject`, git's `erase`).
 *
 * @example
 * ```ts
 * const helper: HttpCredentialHelper = {
 *   fill: ({ host }) => vault.lookup(host),
 *   approve: (credentials, { host }) => vault.save(host, credentials),
 *   reject: (_credentials, { host }) => vault.forget(host),
 * };
 * await git.fetch().setCredentialHelper(helper).call();
 * ```
 */
export interface HttpCredentialHelper {
  /** Credentials for a request a server refused (401); undefined gives up */
  fill(request: CredentialRequest): Promise<Credentials | undefined> | Credentials | undefined;
  /** The credentials `fill` gave worked (git's `credential approve`) */
  approve?(credentials: Credentials, request: CredentialRequest): Promise<void> | void;
  /** The server refused the credentials `fill` gave (git's `credential reject`) */
  reject?(credentials: Credentials, request: CredentialRequest): Promise<void> | void;
}
