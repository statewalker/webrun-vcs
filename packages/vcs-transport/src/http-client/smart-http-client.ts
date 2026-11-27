/**
 * The requests of a smart-HTTP connection, as git's http.c and remote-curl.c send them: the
 * first request (`info/refs`) with git's redirect, authentication and rate-limit handling
 * (`http_request_recoverable`), the later ones (`git-upload-pack`, `git-receive-pack`
 * POSTs) at the base URL the first one ended at. Every request carries the settings'
 * extra headers and user agent.
 *
 * @example
 * ```ts
 * const client = new SmartHttpClient({ url, fetchImpl, settings, credentialHelper, signal });
 * const refs = await client.discover("git-upload-pack", { Accept: "..." }, wait);
 * const answer = await client.post("git-upload-pack", { "Content-Type": "..." }, { body }, wait);
 * ```
 */

import { type Credentials, hasSecret } from "../api/credentials.js";
import { anonymizeUrl } from "../fetch-client/fetch-head.js";
import { authorizationHeader } from "../operations/http-auth.js";
import { AuthenticationError, TransportError } from "../protocol/index.js";
import type {
  CredentialRequest,
  HttpClientSettings,
  HttpCredentialHelper,
} from "./http-client-settings.js";
import {
  type DigestChallenge,
  digestAuthorization,
  digestChallengeOf,
  digestClientNonce,
} from "./http-digest.js";

/** Options of {@link SmartHttpClient}. */
export interface SmartHttpClientOptions {
  /** The repository's URL (`…/repo.git`) */
  url: string;
  fetchImpl: (request: Request) => Promise<Response>;
  /** Headers of the caller, on every request (the settings' extra headers override them) */
  headers?: Record<string, string>;
  /** Credentials sent with every request from the first on */
  auth?: Credentials;
  settings?: HttpClientSettings;
  credentialHelper?: HttpCredentialHelper;
  /** Aborts every request */
  signal: AbortSignal;
}

/** Runs a wait for the server under the connection's timeout. */
export type ServerWait = <T>(next: () => Promise<T>) => Promise<T>;

type Outcome = "ok" | "reauth" | "noauth" | "rate" | "error";

/** Requests of one smart-HTTP connection (see the module notes). */
export class SmartHttpClient {
  private baseUrl: string;
  private auth?: Credentials;
  /** Whether {@link auth} came from the helper (approved or rejected through it) */
  private filled = false;
  private approved = false;
  private wwwAuthenticate: string[] = [];
  /** After a re-root to another origin: the caller's Authorization/Cookie headers stay home */
  private dropCallerCredentials = false;
  /** The origin of the URL as given: the only one a dumb GET sends any header to */
  private readonly givenOrigin: string;
  /** Empty credentials a server took (`http.emptyAuth`), sent from then on */
  private emptyAuth?: Credentials;
  /**
   * Whether a 401 without credentials offered Digest: git restricts curl's methods to those
   * the server offered (`http_auth_methods &= auth_avail`), and curl prefers Digest to Basic
   */
  private useDigest = false;
  /** The last Digest challenge seen (curl keeps it on the handle for the next requests) */
  private digest?: DigestChallenge;
  /** The nonce count of the last answer to {@link digest}'s nonce */
  private digestNc = 0;
  private digestCnonce?: string;

  constructor(private readonly options: SmartHttpClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.givenOrigin = originOf(this.baseUrl);
    if (options.auth) this.auth = options.auth;
  }

  /** The repository's URL the requests go to (the first request's redirect applied). */
  get base(): string {
    return this.baseUrl;
  }

  private get settings(): HttpClientSettings {
    return this.options.settings ?? {};
  }

  /**
   * The first request of a connection, `GET <base>/info/refs?service=<service>`, as git's
   * `discover_refs` makes it: redirects followed unless `http.followRedirects=false` and the
   * base re-rooted where they ended, a 401 answered by the credential helper (three tries in
   * all), a 429 retried `http.maxRetries` times; the credentials approved once it succeeds.
   *
   * @returns the successful response, its body unread
   * @throws AuthenticationError / TransportError git's lines (`Authentication failed for`,
   *   `unable to access`, `rate limited by`, `unable to update url base from redirection`)
   */
  async discover(
    /** undefined: `GET <base>/info/refs` alone, as remote-curl asks under `GIT_SMART_HTTP=0` */
    service: string | undefined,
    headers: Record<string, string>,
    wait: ServerWait,
  ): Promise<Response> {
    const settings = this.settings;
    const tail = service === undefined ? "/info/refs" : `/info/refs?service=${service}`;
    let url = `${this.baseUrl}${tail}`;
    await this.fillProactively(url);
    let response = await this.send(url, { method: "GET", headers }, wait, true);
    let outcome = await this.outcomeOf(response);
    const retries = settings.rateLimitRetries === false ? 0 : (settings.maxRetries ?? 0);
    if (outcome !== "ok" && outcome !== "reauth" && outcome !== "rate") {
      throw await this.failure(response, outcome);
    }
    if (outcome === "rate" && retries <= 0) throw await this.failure(response, "error");
    url = this.rebase(url, tail, response.url);

    let reauths = 3;
    let rateRetries = retries;
    // http_request_recoverable: `(ret == HTTP_REAUTH && --i) || (ret == RATE && --retries)`
    while ((outcome === "reauth" && --reauths) || (outcome === "rate" && --rateRetries)) {
      if (outcome === "rate") {
        // the loop empties git's buffer first: a failure here shows no `remote:` lines
        await response.body?.cancel().catch(() => undefined);
        const delay = this.retryDelay(response);
        if (delay < 0) {
          throw await this.failure(response, "error", [...this.pendingErrors]);
        }
        if (delay > 0) {
          settings.onWarning?.(`warning: rate limited, waiting ${delay} seconds before retry`);
          await (settings.sleep ?? defaultSleep)(delay * 1000);
        }
      } else {
        await response.body?.cancel().catch(() => undefined);
        const filled = await this.fill(url);
        if (!filled) throw await this.failure(response, "noauth");
      }
      response = await this.send(url, { method: "GET", headers }, wait, true);
      outcome = await this.outcomeOf(response);
    }
    if (outcome === "rate") throw await this.rateLimited(response);
    if (outcome !== "ok") throw await this.failure(response, outcome);
    await this.approve(url);
    return response;
  }

  /**
   * A later request (`POST <base>/<path>`): redirects followed only under
   * `http.followRedirects=true` (else a redirect is answered as it is, an error).
   */
  async post(
    path: string,
    headers: Record<string, string>,
    init: Omit<RequestInit, "headers" | "method" | "signal" | "redirect">,
    wait: ServerWait,
  ): Promise<Response> {
    return this.send(`${this.baseUrl}/${path}`, { ...init, method: "POST", headers }, wait, false);
  }

  /**
   * A later request sent by `attempt` (a POST through {@link post}) as remote-curl's
   * `post_rpc` sends it: a 401 while the connection holds no credentials asks the helper
   * (`http_reauth_prepare`) and sends the request again, as long as the helper answers; a 401
   * to credentials rejects them (`credential_reject`); a success approves the helper's.
   *
   * @returns the last response, its body unread (a refusal for the caller to report)
   */
  async postAuthorized(attempt: () => Promise<Response>): Promise<Response> {
    for (;;) {
      const response = await attempt();
      if (response.ok) {
        await this.approve(`${this.baseUrl}/`);
        return response;
      }
      if (response.status !== 401) return response;
      if (hasSecret(this.auth)) {
        await this.reject();
        return response;
      }
      if (!this.options.credentialHelper) return response;
      await response.body?.cancel().catch(() => undefined);
      this.noteChallenges(this.wwwAuthenticate);
      if (!(await this.fill(`${this.baseUrl}/`))) return response;
    }
  }

  /**
   * A later GET of the dumb protocol (`HEAD`, `objects/...`, an alternate's files), as
   * http-walker sends it: redirects followed only under `http.followRedirects=true`. A URL on
   * the base's origin gets the connection's headers and credentials while that is still the
   * origin of the URL as given; any other (a base the first redirect moved to another server,
   * an alternate elsewhere) gets none of them: no caller headers, no `http.extraHeader`.
   */
  async get(url: string, wait: ServerWait): Promise<Response> {
    const origin = originOf(url);
    if (origin === originOf(this.baseUrl) && origin === this.givenOrigin) {
      return this.send(url, { method: "GET", headers: {} }, wait, false);
    }
    const follow = (this.settings.followRedirects ?? "initial") === "always";
    return wait(() =>
      this.options.fetchImpl(
        new Request(url, {
          method: "GET",
          redirect: follow ? "follow" : "manual",
          signal: this.options.signal,
        }),
      ),
    );
  }

  /** Sends one request with the connection's headers and credentials. */
  private async send(
    url: string,
    init: RequestInit & { headers: Record<string, string> },
    wait: ServerWait,
    initial: boolean,
  ): Promise<Response> {
    const settings = this.settings;
    const mode = settings.followRedirects ?? "initial";
    const follow = mode === "always" || (initial && mode === "initial");
    const method = init.method ?? "GET";
    const resendable = !(init.body instanceof ReadableStream);
    let response: Response;
    let answeredAgain = false;
    for (;;) {
      const digest = this.digestAnswer(method, url);
      response = await wait(() =>
        this.options.fetchImpl(
          new Request(url, {
            ...init,
            headers: this.headersFor(init.headers, this.auth ?? this.emptyAuth, digest),
            redirect: follow ? "follow" : "manual",
            signal: this.options.signal,
          } as RequestInit),
        ),
      );
      const challenges = splitChallenges(response.headers.get("www-authenticate"));
      this.wwwAuthenticate = challenges;
      if (response.status !== 401) break;
      const fresh = digestChallengeOf(challenges);
      if (fresh) {
        if (fresh.nonce !== this.digest?.nonce) this.digestNc = 0;
        this.digest = fresh;
      }
      // curl answers a refused Digest answer once more with the 401's challenge (and again
      // whenever the server says the nonce was stale), within the same request
      if (digest === undefined || !fresh || !resendable || (answeredAgain && !fresh.stale)) {
        break;
      }
      answeredAgain = true;
      await response.body?.cancel().catch(() => undefined);
    }
    // http.emptyAuth=true: curl answers the 401 with empty credentials itself (CURLOPT_USERPWD
    // ":"), within the same request
    if (
      response.status === 401 &&
      settings.emptyAuth === true &&
      !hasSecret(this.auth) &&
      init.body === undefined
    ) {
      await response.body?.cancel().catch(() => undefined);
      const empty = { username: "", password: "" };
      const retried = await wait(() =>
        this.options.fetchImpl(
          new Request(url, {
            ...init,
            headers: this.headersFor(init.headers, empty),
            redirect: follow ? "follow" : "manual",
            signal: this.options.signal,
          } as RequestInit),
        ),
      );
      this.wwwAuthenticate = splitChallenges(retried.headers.get("www-authenticate"));
      // curl keeps sending what worked
      if (retried.status !== 401) this.emptyAuth = empty;
      return retried;
    }
    return response;
  }

  /**
   * The headers of a request: the caller's, the request's own, the user agent, the
   * credentials, then `http.extraHeader` lines over all of them.
   */
  private headersFor(
    own: Record<string, string>,
    auth: Credentials | undefined,
    digest?: string,
  ): Headers {
    const headers = new Headers(this.options.headers);
    if (this.dropCallerCredentials) {
      for (const name of ["authorization", "cookie", "proxy-authorization"]) headers.delete(name);
    }
    for (const [name, value] of Object.entries(own)) headers.set(name, value);
    const settings = this.settings;
    if (settings.userAgent !== undefined) headers.set("User-Agent", settings.userAgent);
    if (digest !== undefined) headers.set("Authorization", digest);
    else if (auth && (hasSecret(auth) || (auth.username === "" && auth.password === ""))) {
      headers.set("Authorization", authorizationHeader(auth));
    }
    const extra = new Set<string>();
    for (const line of settings.extraHeaders ?? []) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      const key = name.toLowerCase();
      try {
        if (value === "") headers.delete(name);
        else if (extra.has(key)) headers.append(name, value);
        else headers.set(name, value);
        extra.add(key);
      } catch {
        // a name or value Headers refuses (curl would send the line as it is)
      }
    }
    return headers;
  }

  /**
   * The Digest answer of a request: when the server's 401 offered Digest and the
   * credentials are a user and password (a helper's `authtype` goes as it is).
   */
  private digestAnswer(method: string, url: string): string | undefined {
    const auth = this.auth;
    const challenge = this.digest;
    if (!this.useDigest || !challenge || !auth || auth.authtype || !hasSecret(auth)) {
      return undefined;
    }
    const username = auth.token !== undefined ? (auth.username ?? "x-access-token") : auth.username;
    const password = auth.token ?? auth.password;
    if (username === undefined || password === undefined) return undefined;
    this.digestCnonce ??= digestClientNonce();
    const parsed = new URL(url);
    this.digestNc += 1;
    return digestAuthorization(
      challenge,
      { username, password },
      {
        method,
        uri: `${parsed.pathname}${parsed.search}`,
        nc: this.digestNc,
        cnonce: this.digestCnonce,
      },
    );
  }

  /**
   * A 401 without credentials: git restricts curl to the methods the server offered
   * (handle_curl_result's `http_auth_methods &= auth_avail`), so Digest is used from then on
   * when it was offered (curl picks it over Basic).
   */
  private noteChallenges(challenges: readonly string[]): void {
    if (challenges.length === 0) return;
    this.useDigest = digestChallengeOf(challenges) !== undefined;
  }

  /**
   * http.proactiveAuth (git 2.46+, `basic` or `auto`): the helper is asked before the first
   * request (`init_curl_http_auth`; under `basic` with `wwwauth[]=Basic` unless the URL names
   * a user), and what it gives is sent with it as Basic (or as its `authtype`).
   */
  private async fillProactively(url: string): Promise<void> {
    const mode = this.settings.proactiveAuth;
    if ((mode !== "basic" && mode !== "auto") || hasSecret(this.auth)) return;
    const named = new URL(url).username !== "";
    await this.fill(url, mode === "basic" && !named ? ["Basic"] : []);
  }

  /** handle_curl_result's reading of a response (credentials rejected on a refused 401). */
  private async outcomeOf(response: Response): Promise<Outcome> {
    if (response.ok) return "ok";
    if (response.status === 401) {
      if (hasSecret(this.auth)) {
        await this.reject();
        return "noauth";
      }
      this.noteChallenges(this.wwwAuthenticate);
      return "reauth";
    }
    if (response.status === 429 && this.settings.rateLimitRetries !== false) return "rate";
    return "error";
  }

  /** `error:` lines to print before a failure (`handle_rate_limit_retry`) */
  private pendingErrors: string[] = [];

  /**
   * handle_rate_limit_retry: the response's `Retry-After` (seconds, or an HTTP date as
   * seconds from now; only a positive one counts, as curl's CURLINFO_RETRY_AFTER) else
   * `http.retryAfter`; -1 with git's error when it exceeds `http.maxRetryTime`.
   */
  private retryDelay(response: Response): number {
    const settings = this.settings;
    const maxTime = settings.maxRetryTime ?? 300;
    const requested = retryAfterOf(response);
    if (requested >= 0) {
      if (requested > maxTime) {
        this.pendingErrors = [
          `error: response requested a delay greater than http.maxRetryTime (${requested} > ${maxTime} seconds)`,
        ];
        return -1;
      }
      return requested;
    }
    const configured = settings.retryAfter ?? 0;
    if (configured > maxTime) {
      this.pendingErrors = [
        `error: configured http.retryAfter exceeds http.maxRetryTime (${configured} > ${maxTime} seconds)`,
      ];
      return -1;
    }
    return configured;
  }

  /**
   * update_url_from_redirect: when the first request ended elsewhere, the new base is where
   * it ended less the part asked for (`/info/refs?service=...`); git dies when that part is
   * not at its end. Credentials stay only within the origin.
   *
   * @returns the URL later tries of the first request go to
   */
  private rebase(asked: string, tail: string, effective: string): string {
    if (!effective || effective === asked) return asked;
    if (!effective.endsWith(tail)) {
      throw new TransportError(
        `fatal: unable to update url base from redirection:\n  asked for: ${asked}\n   redirect: ${effective}`,
      );
    }
    const previous = this.baseUrl;
    this.baseUrl = effective.slice(0, effective.length - tail.length);
    if (originOf(previous) !== originOf(this.baseUrl)) {
      // the credentials were for the URL asked; git's credential_from_url starts over at the
      // new one, and nothing of the caller's that identifies the user follows it
      delete this.auth;
      this.filled = false;
      this.dropCallerCredentials = true;
      delete this.digest;
      this.useDigest = false;
    }
    return effective;
  }

  /** credential_fill: the helper's credentials for the URL, after a 401. */
  private async fill(url: string, wwwAuthenticate?: string[]): Promise<boolean> {
    const helper = this.options.credentialHelper;
    if (!helper) return false;
    const request = this.credentialRequest(url);
    if (wwwAuthenticate) request.wwwAuthenticate = wwwAuthenticate;
    const credentials = await helper.fill(request);
    if (!credentials || !hasSecret(credentials)) return false;
    this.auth = credentials;
    this.filled = true;
    this.approved = false;
    return true;
  }

  private async approve(url: string): Promise<void> {
    if (!this.filled || this.approved || !this.auth) return;
    this.approved = true;
    await this.options.credentialHelper?.approve?.(this.auth, this.credentialRequest(url));
  }

  private async reject(): Promise<void> {
    const auth = this.auth;
    if (!auth) return;
    if (this.filled) {
      await this.options.credentialHelper?.reject?.(
        auth,
        this.credentialRequest(`${this.baseUrl}/`),
      );
    }
  }

  private credentialRequest(url: string): CredentialRequest {
    const parsed = new URL(url);
    return {
      url: `${this.baseUrl}/`,
      protocol: parsed.protocol.replace(/:$/, ""),
      host: parsed.host,
      ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
      wwwAuthenticate: [...this.wwwAuthenticate],
    };
  }

  /** The error of a failed first request (`discover_refs`' deaths). */
  private async failure(
    response: Response,
    outcome: Outcome,
    before: string[] = [],
  ): Promise<TransportError> {
    const error = await httpRefsErrorOf(
      response,
      this.baseUrl,
      outcome === "noauth" || response.status === 401,
    );
    if (before.length === 0) return error;
    const message = `${before.join("\n")}\n${error.message}`;
    return error instanceof AuthenticationError
      ? new AuthenticationError(message)
      : new TransportError(message);
  }

  /** remote-curl's HTTP_RATE_LIMITED death: `rate limited by '<url>/', please try again ...`. */
  private async rateLimited(response: Response): Promise<TransportError> {
    const lines = await httpMessageLines(response);
    const url = `${anonymizeUrl(this.baseUrl)}/`;
    const after = retryAfterOf(response);
    const tail = after > 0 ? `please try again in ${after} seconds` : "please try again later";
    return new TransportError(`${lines}fatal: rate limited by '${url}', ${tail}`);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * A 429's `Retry-After` in seconds as curl's CURLINFO_RETRY_AFTER gives it: a number of
 * seconds, or an HTTP date as the seconds from now (0 when past); -1 without one.
 */
export function retryAfterOf(response: Response): number {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return -1;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return seconds > 0 ? seconds : -1;
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return -1;
  const seconds = Math.floor((date - Date.now()) / 1000);
  return seconds > 0 ? seconds : -1;
}

/**
 * The challenges of a `WWW-Authenticate` value: a header repeated reaches a `Headers` joined
 * by `, `, so a new challenge starts after a comma where a scheme (a token) is followed by a
 * space and not by `=` (an auth-param of the challenge before).
 */
export function splitChallenges(value: string | null): string[] {
  if (!value) return [];
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' && value[i - 1] !== "\\") quoted = !quoted;
    if (ch !== "," || quoted) continue;
    const rest = value.slice(i + 1);
    if (/^\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+(\s+[^=\s,]|\s*$)/.test(rest)) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter((c) => c !== "");
}

/** show_http_message: a `text/plain` body as `remote: ` lines. */
async function httpMessageLines(response: Response): Promise<string> {
  const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "text/plain") {
    await response.body?.cancel().catch(() => {});
    return "";
  }
  const text = (await response.text().catch(() => "")).trim();
  return text
    ? text
        .split("\n")
        .map((line) => `remote: ${line}\n`)
        .join("")
    : "";
}

/**
 * The error git's remote-curl dies with when `info/refs` fails (`discover_refs`): a 404 is
 * "repository '<url>/' not found", a 401 "Authentication failed for '<url>/'" (an
 * {@link AuthenticationError}, as is a 403), any other "unable to access '<url>/': The
 * requested URL returned error: <code>"; a `text/plain` body comes first as `remote: ` lines
 * (`show_http_message`). The URL ends with a slash and carries no credentials, as git prints it.
 */
export async function httpRefsErrorOf(
  response: Response,
  baseUrl: string,
  noAuth = response.status === 401,
): Promise<TransportError> {
  const lines = await httpMessageLines(response);
  const url = `${anonymizeUrl(baseUrl.replace(/\/+$/, ""))}/`;
  if (response.status === 404) {
    return new TransportError(`${lines}fatal: repository '${url}' not found`);
  }
  // a redirect a browser cannot show (`opaqueredirect`) has status 0
  const status = response.type === "opaqueredirect" ? 302 : response.status;
  const unable = `fatal: unable to access '${url}': The requested URL returned error: ${status}`;
  if (noAuth) {
    return new AuthenticationError(`${lines}fatal: Authentication failed for '${url}'`);
  }
  if (response.status === 403) return new AuthenticationError(`${lines}${unable}`);
  return new TransportError(`${lines}${unable}`);
}
