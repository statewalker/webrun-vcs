/**
 * Which credentials and headers a clone or fetch inside a submodule command may send.
 *
 * Submodule URLs come from `.gitmodules`, a file of the repository's content: anyone who
 * can commit can point a submodule (or a nested one) at any host. git matches its credential
 * helpers per URL; here a credential or header is sent only where the caller gave it for:
 * what a per-URL provider answers for that URL, or the static credentials and headers for a
 * URL whose origin (scheme, host, port) is one the caller named, or, when it named none, the
 * origin of the superproject's own remote.
 *
 * @example
 * ```typescript
 * const authFor = createSubmoduleAuthPolicy({
 *   credentials: { token },
 *   origins: [urlOrigin("https://git.example.com/org/super.git")],
 * });
 * authFor("https://git.example.com/org/lib.git"); // { credentials: { token } }
 * authFor("https://evil.example/lib.git");        // {}
 * ```
 *
 * @module
 */
import type { Credentials } from "@statewalker/vcs-transport";

/** What a clone or fetch of one URL authenticates with. */
export interface SubmoduleAuth {
  credentials?: Credentials;
  headers?: Record<string, string>;
}

/** The credentials and headers for one URL (an empty object: none). */
export type SubmoduleAuthFor = (url: string) => SubmoduleAuth;

/** Credentials for a URL, undefined for none. */
export type CredentialsForUrl = (url: string) => Credentials | undefined;

/** HTTP headers for a URL, undefined for none. */
export type HeadersForUrl = (url: string) => Record<string, string> | undefined;

const DEFAULT_PORTS: Record<string, string> = {
  http: "80",
  https: "443",
  ssh: "22",
  "git+ssh": "22",
  "ssh+git": "22",
  git: "9418",
};

/**
 * The origin of a URL: `<scheme>://<host>[:<port>]`, lowercase, the scheme's default port
 * left out, user information dropped; `ssh://<host>` for scp-like `[user@]host:path`;
 * undefined for a local path, a `file:` URL or anything without a host.
 *
 * @example
 * ```typescript
 * urlOrigin("HTTPS://user@Git.Example.com:443/x.git"); // "https://git.example.com"
 * urlOrigin("git@example.com:org/x.git");              // "ssh://example.com"
 * urlOrigin("../lib");                                 // undefined
 * ```
 */
export function urlOrigin(url: string): string | undefined {
  const full = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(url);
  if (full) {
    const scheme = (full[1] as string).toLowerCase();
    if (scheme === "file") return undefined;
    let authority = full[2] as string;
    const at = authority.lastIndexOf("@");
    if (at >= 0) authority = authority.slice(at + 1);
    let host = authority;
    let port = "";
    const bracket = /^(\[[^\]]*\])(?::(\d*))?$/.exec(authority);
    if (bracket) {
      host = bracket[1] as string;
      port = bracket[2] ?? "";
    } else {
      const colon = authority.lastIndexOf(":");
      if (colon >= 0) {
        host = authority.slice(0, colon);
        port = authority.slice(colon + 1);
      }
    }
    host = host.toLowerCase();
    if (host === "") return undefined;
    if (port === DEFAULT_PORTS[scheme]) port = "";
    return `${scheme}://${host}${port ? `:${port}` : ""}`;
  }
  // scp-like: a colon before any slash, and something before it that is no drive letter
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  if (colon > 1 && (slash < 0 || colon < slash)) {
    let host = url.slice(0, colon);
    const at = host.lastIndexOf("@");
    if (at >= 0) host = host.slice(at + 1);
    host = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    return host ? `ssh://${host}` : undefined;
  }
  return undefined;
}

/** What {@link createSubmoduleAuthPolicy} is built from. */
export interface SubmoduleAuthOptions {
  /** Static credentials, for the {@link origins} alone */
  credentials?: Credentials;
  /** Static headers, for the {@link origins} alone */
  headers?: Record<string, string>;
  /** The origins (see {@link urlOrigin}) the static credentials and headers are for */
  origins: readonly string[];
  /** Asked with each URL; its answer is used whatever the origin */
  credentialsFor?: CredentialsForUrl;
  /** Asked with each URL; its answer is used whatever the origin */
  headersFor?: HeadersForUrl;
}

/**
 * The policy: for each URL, a provider's answer, else the static value when the URL's
 * origin is one of `origins`, else nothing.
 */
export function createSubmoduleAuthPolicy(options: SubmoduleAuthOptions): SubmoduleAuthFor {
  const origins = new Set(options.origins);
  return (url) => {
    const origin = urlOrigin(url);
    const trusted = origin !== undefined && origins.has(origin);
    const credentials =
      options.credentialsFor?.(url) ?? (trusted ? options.credentials : undefined);
    const headers = options.headersFor?.(url) ?? (trusted ? options.headers : undefined);
    return {
      ...(credentials ? { credentials } : {}),
      ...(headers ? { headers } : {}),
    };
  };
}
