/**
 * What git-daemon knows of the host a client named (`host=`): the name, its canonical name and
 * address (daemon.c's `lookup_hostname`, a `getaddrinfo` the host does: portable code cannot
 * resolve names), and the port, as `--interpolated-path`'s placeholders and `--access-hook`'s
 * arguments use them.
 *
 * @example
 * ```ts
 * expandInterpolatedPath("/srv/%H%D", { hostname: "example.com", directory: "/r.git" });
 * // "/srv/example.com/r.git"
 * await daemonHostInfo("127.0.0.1", lookupLiteralHost);
 * // { canonicalHostname: "127.0.0.1", ipAddress: "127.0.0.1" }
 * ```
 */

import { sanitizeDaemonClient } from "../protocol/git-daemon-request.js";

/** What a host lookup gives for a name (daemon.c's `getaddrinfo` with `AI_CANONNAME`). */
export interface DaemonHostLookupResult {
  /** The first IPv4 address, dotted */
  ipAddress: string;
  /** The canonical name; absent: the address stands for it, as git-daemon's `canon_hostname` */
  canonicalHostname?: string;
}

/** Resolves a client's `host=` name; undefined when it does not resolve. */
export type DaemonHostLookup = (
  hostname: string,
) => Promise<DaemonHostLookupResult | undefined> | DaemonHostLookupResult | undefined;

/** The canonical name and address of a `host=` name: both empty when it does not resolve. */
export interface DaemonHostInfo {
  canonicalHostname: string;
  ipAddress: string;
}

/**
 * The default {@link DaemonHostLookup}: a dotted IPv4 literal is its own address and
 * canonical name (as `getaddrinfo` answers for one); any other name resolves to nothing.
 */
export function lookupLiteralHost(hostname: string): DaemonHostLookupResult | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    return undefined;
  }
  return { ipAddress: hostname, canonicalHostname: hostname };
}

/**
 * daemon.c's `lookup_hostname`: nothing for an empty name, else the lookup's address and its
 * canonical name (sanitized), the address standing for a name the lookup gives none.
 */
export async function daemonHostInfo(
  hostname: string | undefined,
  lookup: DaemonHostLookup = lookupLiteralHost,
): Promise<DaemonHostInfo> {
  if (!hostname) return { canonicalHostname: "", ipAddress: "" };
  let found: DaemonHostLookupResult | undefined;
  try {
    found = await lookup(hostname);
  } catch {
    found = undefined;
  }
  if (!found) return { canonicalHostname: "", ipAddress: "" };
  const canonical =
    found.canonicalHostname !== undefined ? sanitizeDaemonClient(found.canonicalHostname) : "";
  return {
    ipAddress: found.ipAddress,
    canonicalHostname: found.canonicalHostname !== undefined ? canonical : found.ipAddress,
  };
}

/** The values of {@link expandInterpolatedPath}'s placeholders. */
export interface InterpolationValues {
  /** `%H`: the `host=` name, canonicalized as git-daemon does (empty without one) */
  hostname?: string;
  /** `%CH`: the canonical name */
  canonicalHostname?: string;
  /** `%IP`: the address */
  ipAddress?: string;
  /** `%P`: the `host=` port */
  port?: string;
  /** `%D`: the path asked for */
  directory: string;
}

/**
 * git-daemon's `--interpolated-path` expansion (daemon.c's `path_ok`): `%H`, `%CH`, `%IP`,
 * `%P`, `%D`, `%%`; a `%` before anything else stays as it is.
 */
export function expandInterpolatedPath(template: string, values: InterpolationValues): string {
  let out = "";
  let at = 0;
  while (at < template.length) {
    const pct = template.indexOf("%", at);
    if (pct < 0) {
      out += template.slice(at);
      break;
    }
    out += template.slice(at, pct);
    const rest = template.slice(pct + 1);
    at = pct + 1;
    if (rest.startsWith("%")) {
      out += "%";
      at += 1;
    } else if (rest.startsWith("H")) {
      out += values.hostname ?? "";
      at += 1;
    } else if (rest.startsWith("CH")) {
      out += values.canonicalHostname ?? "";
      at += 2;
    } else if (rest.startsWith("IP")) {
      out += values.ipAddress ?? "";
      at += 2;
    } else if (rest.startsWith("P")) {
      out += values.port ?? "";
      at += 1;
    } else if (rest.startsWith("D")) {
      out += values.directory;
      at += 1;
    } else {
      out += "%";
    }
  }
  return out;
}
