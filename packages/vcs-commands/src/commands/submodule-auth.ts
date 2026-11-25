/**
 * Which credentials and headers a clone or fetch inside a submodule command may send, and
 * the transports that attach them.
 *
 * Submodule URLs come from `.gitmodules`, a file of the repository's content: anyone who
 * can commit can point a submodule (or a nested one) at any host. git matches its credential
 * helpers per URL; here a credential or header is sent only where the caller gave it for:
 * what a per-URL provider answers for that URL, or the static credentials and headers for a
 * URL whose origin (scheme, host, port) is one the caller named, or, when it named none, the
 * origin of the superproject's own remote.
 *
 * Two guards keep that true whatever a URL looks like:
 *
 * - {@link strictUrlOrigin} computes an origin from the parses the transports connect with
 *   (`new URL` for smart HTTP, `parseGitUrl` for the others) and gives none when they
 *   disagree or the authority holds anything a parser could read two ways (`\`, `%`,
 *   whitespace, controls, non-ASCII, a second `@`): no origin, no credentials.
 * - {@link guardSubmoduleTransports} attaches them itself, at connect time, never through
 *   the commands: a native connector gets them for the URL just checked, and every smart-HTTP
 *   request carries them only when `new URL(request.url).origin` is the approved origin;
 *   redirects are followed by hand (`redirect: "manual"`) so a redirect to another origin
 *   goes out without them; an opaque redirect (a browser's, whose target cannot be read) is
 *   asked again following it with none of them, and they go to where it ended only when
 *   that is the approved origin.
 *
 * @example
 * ```typescript
 * const authFor = createSubmoduleAuthPolicy({
 *   credentials: { token },
 *   origins: [strictUrlOrigin("https://git.example.com/org/super.git") as string],
 * });
 * const transports = guardSubmoduleTransports(createDefaultTransports(), authFor);
 * ```
 *
 * @module
 */
import {
  type Credentials,
  type GitConnectRequest,
  type GitSession,
  type GitTransportConnector,
  GitTransportRegistry,
  parseGitUrl,
  TransportError,
} from "@statewalker/vcs-transport";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";

/** What a clone or fetch of one URL authenticates with, and the origin it is approved for. */
export interface SubmoduleAuth {
  /** The origin the credentials and headers may go to (absent: none may go anywhere) */
  origin?: string;
  credentials?: Credentials;
  headers?: Record<string, string>;
}

/** The credentials and headers for one URL. */
export type SubmoduleAuthFor = (url: string) => SubmoduleAuth;

/** Credentials for a URL, undefined for none. */
export type CredentialsForUrl = (url: string) => Credentials | undefined;

/** HTTP headers for a URL, undefined for none. */
export type HeadersForUrl = (url: string) => Record<string, string> | undefined;

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, ssh: 22, git: 9418 };

/** Characters an authority may hold here: no `%`, `\`, whitespace, controls or non-ASCII. */
const PLAIN_AUTHORITY = /^[A-Za-z0-9._~:@!$&'()*+,;=[\]-]*$/;

/**
 * The origin a URL connects to, as `<scheme>://<host>[:<port>]` (the scheme's default port
 * left out; `ssh` for every ssh spelling and the scp-like form), or undefined when it has
 * none or it cannot be told for sure: a local path, a `file:` URL, a `<helper>::` URL, an
 * authority holding `%`, `\`, whitespace, a control or non-ASCII character or two `@`, or an
 * http(s) URL `new URL` and `parseGitUrl` read with different hosts or ports.
 *
 * @example
 * ```typescript
 * strictUrlOrigin("HTTPS://user@Git.Example.com:443/x.git"); // "https://git.example.com"
 * strictUrlOrigin("git@example.com:org/x.git");              // "ssh://example.com"
 * strictUrlOrigin("http://127.0.0.1:1\\@localhost:2/up");     // undefined
 * strictUrlOrigin("../lib");                                 // undefined
 * ```
 */
export function strictUrlOrigin(url: string): string | undefined {
  let parsed: ReturnType<typeof parseGitUrl>;
  try {
    parsed = parseGitUrl(url);
  } catch {
    return undefined;
  }
  if (parsed.local || parsed.address !== undefined || parsed.raw !== url) return undefined;
  const scheme = parsed.scheme.toLowerCase();
  if (scheme === "file") return undefined;
  let authority: string;
  if (parsed.scpLike) authority = parsed.authority ?? "";
  else {
    const start = url.indexOf("://");
    if (start < 0) return undefined;
    const rest = url.slice(start + 3);
    const end = rest.search(/[/?#]/);
    authority = end < 0 ? rest : rest.slice(0, end);
  }
  if (!PLAIN_AUTHORITY.test(authority)) return undefined;
  if ((authority.match(/@/g) ?? []).length > 1) return undefined;
  const host = parsed.host?.toLowerCase();
  if (!host) return undefined;
  if (scheme === "http" || scheme === "https") {
    let whatwg: URL;
    try {
      whatwg = new URL(url);
    } catch {
      return undefined;
    }
    if (whatwg.protocol !== `${scheme}:`) return undefined;
    const whatwgHost = whatwg.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    const whatwgPort = whatwg.port ? Number(whatwg.port) : DEFAULT_PORTS[scheme];
    const gitPort = parsed.port ?? DEFAULT_PORTS[scheme];
    if (whatwgHost !== host || whatwgPort !== gitPort) return undefined;
    return whatwg.origin;
  }
  const name = scheme === "git+ssh" || scheme === "ssh+git" ? "ssh" : scheme;
  const port = parsed.port !== undefined && parsed.port !== DEFAULT_PORTS[name] ? parsed.port : 0;
  return `${name}://${host.includes(":") ? `[${host}]` : host}${port ? `:${port}` : ""}`;
}

/** What {@link createSubmoduleAuthPolicy} is built from. */
export interface SubmoduleAuthOptions {
  /** Static credentials, for the {@link origins} alone */
  credentials?: Credentials;
  /** Static headers, for the {@link origins} alone */
  headers?: Record<string, string>;
  /** The origins ({@link strictUrlOrigin}) the static credentials and headers are for */
  origins: readonly string[];
  /** Asked with each URL that has an origin; its answer is for that origin alone */
  credentialsFor?: CredentialsForUrl;
  /** Asked with each URL that has an origin; its answer is for that origin alone */
  headersFor?: HeadersForUrl;
}

/**
 * The policy: for a URL with a {@link strictUrlOrigin}, a provider's answer, else the static
 * value when that origin is one of `origins`; nothing for a URL without one.
 */
export function createSubmoduleAuthPolicy(options: SubmoduleAuthOptions): SubmoduleAuthFor {
  const origins = new Set(options.origins);
  return (url) => {
    const origin = strictUrlOrigin(url);
    if (origin === undefined) return {};
    const trusted = origins.has(origin);
    const credentials =
      options.credentialsFor?.(url) ?? (trusted ? options.credentials : undefined);
    const headers = options.headersFor?.(url) ?? (trusted ? options.headers : undefined);
    if (!credentials && !headers) return {};
    return {
      origin,
      ...(credentials ? { credentials } : {}),
      ...(headers ? { headers } : {}),
    };
  };
}

/**
 * `transports` whose connectors attach the credentials and headers `authFor` gives each
 * URL (the commands using them are given none): a native session through the connect
 * request, a smart-HTTP session through its `fetchImpl`, request by request, only to the
 * approved origin (see the module's notes).
 */
export function guardSubmoduleTransports(
  transports: GitTransportRegistry,
  authFor: SubmoduleAuthFor,
): GitTransportRegistry {
  const guarded = new GitTransportRegistry();
  // list() is highest first; among equal priorities the later registration wins
  for (const connector of [...transports.list()].reverse()) {
    guarded.register(guardConnector(connector, authFor));
  }
  return guarded;
}

function guardConnector(
  connector: GitTransportConnector,
  authFor: SubmoduleAuthFor,
): GitTransportConnector {
  return {
    name: connector.name,
    ...(connector.schemes ? { schemes: connector.schemes } : {}),
    ...(connector.matches ? { matches: (url) => connector.matches?.(url) ?? false } : {}),
    async connect(request: GitConnectRequest): Promise<GitSession> {
      // whatever the command asked for: credentials are this guard's alone
      const { credentials: _c, headers: _h, ...bare } = request;
      const auth = authFor(request.url.raw);
      if (!auth.origin || (!auth.credentials && !auth.headers)) return connector.connect(bare);
      const scheme = request.url.scheme.toLowerCase();
      const http = scheme === "http" || scheme === "https";
      const session = await connector.connect(
        http
          ? bare
          : {
              ...bare,
              ...(auth.credentials ? { credentials: auth.credentials } : {}),
              ...(auth.headers ? { headers: auth.headers } : {}),
            },
      );
      if (session.kind !== "http") return session;
      let approved: string | undefined = auth.origin;
      if (!http) {
        // a connector of another scheme serving smart HTTP: its own endpoint's origin
        try {
          approved = new URL(session.baseUrl).origin;
        } catch {
          approved = undefined;
        }
      }
      if (approved === undefined || approved === "null") return session;
      return { ...session, fetchImpl: guardedFetch(session.fetchImpl, approved, auth) };
    },
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A redirect as the response shows it (a browser's `opaqueredirect` included). */
function isRedirect(response: Response): boolean {
  return response.type === "opaqueredirect" || REDIRECTS.has(response.status);
}
const MAX_REDIRECTS = 20;

/**
 * A `fetch` that adds the approved credentials and headers to requests for `origin` only,
 * and follows redirects itself so none crosses to another origin with them.
 */
function guardedFetch(
  fetchImpl: (request: Request) => Promise<Response>,
  origin: string,
  auth: SubmoduleAuth,
): (request: Request) => Promise<Response> {
  const added = new Map<string, string>();
  for (const [name, value] of Object.entries(auth.headers ?? {})) added.set(name, value);
  if (auth.credentials) added.set("Authorization", basicAuthorization(auth.credentials));
  return async (request) => {
    let current = request;
    for (let hops = 0; ; hops++) {
      const target = new URL(current.url);
      const headers = new Headers(current.headers);
      for (const name of added.keys()) headers.delete(name);
      if (target.origin === origin) for (const [name, value] of added) headers.set(name, value);
      const kept = current.clone();
      const probe = current.clone();
      const response = await fetchImpl(new Request(current, { headers, redirect: "manual" }));
      // a request that follows no redirect (`http.followRedirects`) gets the redirect itself
      if (request.redirect !== "follow" && isRedirect(response)) return response;
      if (response.type === "opaqueredirect") {
        // a browser hides where it leads: ask again, following, with none of the guard's
        // headers; the credentials go only to where that ended, on the approved origin
        if (hops >= MAX_REDIRECTS) throw new TransportError("too many redirects");
        const followed = await fetchImpl(new Request(probe, { redirect: "follow" }));
        let landed: URL | undefined;
        try {
          landed = followed.url ? new URL(followed.url) : undefined;
        } catch {
          landed = undefined;
        }
        if (!landed || landed.href === target.href || landed.origin !== origin) return followed;
        await followed.body?.cancel().catch(() => undefined);
        const body = kept.method === "GET" || kept.method === "HEAD" ? null : kept.body;
        current = new Request(landed, {
          method: kept.method,
          headers: kept.headers,
          ...(body ? { body, duplex: "half" } : {}),
          signal: kept.signal,
        } as RequestInit);
        continue;
      }
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || location === null) return response;
      if (hops >= MAX_REDIRECTS) throw new TransportError("too many redirects");
      await response.body?.cancel().catch(() => undefined);
      const next = new URL(location, target);
      const toGet =
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && kept.method === "POST");
      const method = toGet ? "GET" : kept.method;
      const body = toGet || method === "GET" || method === "HEAD" ? null : kept.body;
      current = new Request(next, {
        method,
        headers: kept.headers,
        ...(body ? { body, duplex: "half" } : {}),
        signal: kept.signal,
      } as RequestInit);
    }
  };
}

/** `Authorization: Basic` as the transports write it (a token as the password). */
function basicAuthorization(auth: Credentials): string {
  const text = auth.token
    ? `${auth.username ?? "x-access-token"}:${auth.token}`
    : `${auth.username}:${auth.password}`;
  let binary = "";
  for (const byte of encodeGitPath(text)) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}
