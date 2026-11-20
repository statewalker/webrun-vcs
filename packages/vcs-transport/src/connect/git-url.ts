/**
 * Remote URLs as git reads them: transport.c's `transport_get` (a `<helper>::<address>`, an
 * `is_url` URL, or else a path or an scp-like `host:path`) and connect.c's
 * `parse_connect_url` / `url_is_local_not_ssh` for the builtin smart transports (`file`,
 * `ssh`, `git`).
 */

/** A remote URL taken apart the way git's transports read it. */
export interface GitUrl {
  /** The URL as given (cut at a NUL, as git's C strings are) */
  raw: string;
  /**
   * The transport it names: `file` (a path or a `file://` URL), `ssh` (`ssh://`,
   * `git+ssh://`, `ssh+git://` and the scp-like `host:path`), `git`, `http`, `https`, any
   * other `<scheme>://` as written, or the helper of a `<helper>::<address>` URL (`ext`,
   * a custom helper name)
   */
  scheme: string;
  /** The host, without brackets (`::1` for `[::1]`) or user */
  host?: string;
  /** The port, when the URL names one */
  port?: number;
  /** The user (`user@host`), without a password */
  user?: string;
  /**
   * The repository's path as the transport asks for it: a local path as given, the path of a
   * `file://` URL (decoded), an ssh/git path (`~user/x` for `/~user/x`), the path of any other
   * URL as written, or the address of a `<helper>::<address>` URL. Empty when there is none
   * (git's "no path specified").
   */
  path: string;
  /** Whether it is the scp-like `[user@]host:path` form of ssh */
  scpLike: boolean;
  /** Whether it names a repository by a path (not a URL): git's local transport */
  local: boolean;
  /** For `<helper>::<address>`: the address handed to the helper */
  address?: string;
  /**
   * The part between the scheme (or the start) and the path as git's `parse_connect_url`
   * leaves it (`user@host:22`, `[::1]:9418`): the `host=` git sends to git-daemon
   */
  authority?: string;
}

/** git's `is_urlschemechar`: `[A-Za-z0-9]`, and `+.-` after the first character. */
export function isUrlSchemeChar(first: boolean, ch: string | undefined): boolean {
  if (ch === undefined) return false;
  if (/^[A-Za-z0-9]$/.test(ch)) return true;
  return !first && (ch === "+" || ch === "-" || ch === ".");
}

/**
 * git's `is_url`: `<scheme>://`, the scheme `[A-Za-z0-9][A-Za-z0-9+.-]*`.
 *
 * @example
 * ```ts
 * isGitUrl("https://example.com/r.git"); // true
 * isGitUrl("host:path");                 // false (scp-like)
 * ```
 */
export function isGitUrl(url: string): boolean {
  if (!isUrlSchemeChar(true, url[0])) return false;
  let i = 1;
  while (i < url.length && url[i] !== ":") {
    if (!isUrlSchemeChar(false, url[i])) return false;
    i++;
  }
  return url.startsWith("://", i);
}

/** A DOS drive prefix followed by a separator (`C:\x`, `C:/x`). */
const DOS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * git's `url_is_local_not_ssh`: no colon, or a slash before the first colon. A DOS drive path
 * (`C:\x`) is local too, as git reads it on Windows (git on POSIX takes it for `ssh` to host
 * `C`), since this code runs on either.
 */
export function urlIsLocalNotSsh(url: string): boolean {
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  return colon < 0 || (slash >= 0 && slash < colon) || DOS_DRIVE.test(url);
}

/**
 * The length of a `<helper>::<address>` URL's helper name (transport_get's scan over
 * `is_urlschemechar`), or 0 when the URL is not of that form.
 */
function helperLength(url: string): number {
  let p = 0;
  while (isUrlSchemeChar(p === 0, url[p])) p++;
  return p > 0 && url.startsWith("::", p) ? p : 0;
}

/**
 * git's `url_decode`: `%XX` escapes decoded (an invalid one, and `%00`, kept as is) after the
 * scheme's colon, the bytes read as UTF-8.
 */
function urlDecode(url: string): string {
  const colon = url.indexOf(":");
  const head = colon > 0 ? url.slice(0, colon) : "";
  const rest = colon > 0 ? url.slice(colon) : url;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    // hex2chr's `0 < val`: `%00` is no escape (git's C strings could not hold the NUL)
    if (ch === "%" && /^[0-9A-Fa-f]{2}$/.test(rest.slice(i + 1, i + 3))) {
      const value = Number.parseInt(rest.slice(i + 1, i + 3), 16);
      if (value > 0) {
        bytes.push(value);
        i += 2;
        continue;
      }
    }
    for (const b of encoder.encode(ch)) bytes.push(b);
  }
  return head + new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * connect.c's `host_end`: where the host of `host` ends; a bracketed host (`[::1]`, also after
 * `user@`) ends after its `]`, any other at its start (the caller looks for the separator).
 */
function hostEnd(host: string): number {
  const at = host.indexOf("@[");
  const start = at >= 0 ? at + 1 : 0;
  if (host[start] === "[") {
    const close = host.indexOf("]", start + 1);
    if (close >= 0) return close;
  }
  return 0;
}

/** A port as git's `strtol` checks it: digits only, 0..65535. */
function portOf(text: string): number | undefined {
  if (!/^[0-9]+$/.test(text)) return undefined;
  const n = Number(text);
  return n < 65536 ? n : undefined;
}

/**
 * Splits the `[user[:password]@]host[:port]` of a URL git hands to a remote helper (http(s)
 * and other schemes): brackets removed, a valid port split off, a lone trailing colon dropped.
 */
function splitAuthority(authority: string): { user?: string; host?: string; port?: number } {
  let rest = authority;
  let user: string | undefined;
  const bracketAt = rest.indexOf("@[");
  const at = bracketAt >= 0 ? bracketAt : rest.lastIndexOf("@");
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let host = rest;
  let port: number | undefined;
  let after = "";
  if (rest.startsWith("[") && rest.indexOf("]") > 0) {
    const close = rest.indexOf("]");
    host = rest.slice(1, close);
    after = rest.slice(close + 1);
    if (after.startsWith(":")) {
      const p = portOf(after.slice(1));
      if (p !== undefined) port = p;
    }
  } else {
    const colon = rest.indexOf(":");
    if (colon >= 0) {
      const p = portOf(rest.slice(colon + 1));
      if (p !== undefined) {
        port = p;
        host = rest.slice(0, colon);
      } else if (colon === rest.length - 1) {
        host = rest.slice(0, colon);
      }
    }
  }
  return {
    ...(user !== undefined ? { user } : {}),
    ...(host !== "" ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
  };
}

/**
 * A port as git's `strtol` check reads it (`get_host_and_port`, `get_port`): optional leading
 * white space and sign, at least one digit, nothing after, 0..65535.
 */
function strtolPort(text: string): number | undefined {
  const m = /^[ \t\n\v\f\r]*([+-]?)([0-9]+)$/.exec(text);
  if (!m) return undefined;
  const n = Number.parseInt(m[2] ?? "", 10);
  if (m[1] === "-" && n !== 0) return undefined;
  return n < 65536 ? n : undefined;
}

/**
 * connect.c's `get_host_and_port` (brackets removed, a valid port after the first colon past
 * the host split off, a lone trailing colon dropped), then for ssh `get_port` (a host still
 * holding `name:port`, from `[name:port]`). The user stays in the host, as git hands
 * `user@host` to ssh; ssh splits it at the last `@`.
 */
function gitHostAndPort(authority: string, ssh: boolean): { host: string; port?: number } {
  // host_end(&host, 1): the bracketed part unwrapped, the rest searched for the port
  let head = "";
  let rest = authority;
  const at = authority.indexOf("@[");
  const start = at >= 0 ? at + 1 : 0;
  if (authority[start] === "[") {
    const close = authority.indexOf("]", start + 1);
    if (close >= 0) {
      head = authority.slice(0, start) + authority.slice(start + 1, close);
      rest = authority.slice(close + 1);
    }
  }
  let host = head + rest;
  let port: number | undefined;
  const colon = rest.indexOf(":");
  if (colon >= 0) {
    const p = strtolPort(rest.slice(colon + 1));
    if (p !== undefined) port = p;
    if (p !== undefined || colon === rest.length - 1) host = head + rest.slice(0, colon);
  }
  if (ssh && port === undefined) {
    const c = host.indexOf(":");
    const p = c >= 0 ? strtolPort(host.slice(c + 1)) : undefined;
    if (p !== undefined) {
      port = p;
      host = host.slice(0, c);
    }
  }
  return { host, ...(port !== undefined ? { port } : {}) };
}

/** `user@host` split at its last `@`, as ssh reads it. */
function splitUser(userAndHost: string): { user?: string; host?: string } {
  const at = userAndHost.lastIndexOf("@");
  const user = at >= 0 ? userAndHost.slice(0, at) : undefined;
  const host = at >= 0 ? userAndHost.slice(at + 1) : userAndHost;
  return { ...(user !== undefined ? { user } : {}), ...(host !== "" ? { host } : {}) };
}

/** url.c's `url_get_scheme` for the builtin smart transports. */
function builtinScheme(scheme: string): "file" | "ssh" | "git" | undefined {
  if (scheme === "ssh" || scheme === "git+ssh" || scheme === "ssh+git") return "ssh";
  if (scheme === "git") return "git";
  if (scheme === "file") return "file";
  return undefined;
}

/**
 * Takes a remote URL apart as git's transports read it.
 *
 * @example
 * ```ts
 * parseGitUrl("git@example.com:org/repo.git");
 * // { scheme: "ssh", user: "git", host: "example.com", path: "org/repo.git", scpLike: true, ... }
 * parseGitUrl("ssh://host:22/~user/x");   // { scheme: "ssh", host: "host", port: 22, path: "~user/x" }
 * parseGitUrl("../other");                // { scheme: "file", path: "../other", local: true }
 * parseGitUrl("ext::ssh -p 22 host %S x");// { scheme: "ext", address: "ssh -p 22 host %S x" }
 * ```
 *
 * The order is transport_get's: `<helper>::<address>` first (`scheme` is the helper); then a
 * `<scheme>://` URL, whose `file`, `ssh` (and its deprecated spellings) and `git` parts are
 * read as connect.c's `parse_connect_url` reads them (the URL decoded, `/~user` becomes
 * `~user`, a `file://` path starts at the first `/` after the host), any other kept as
 * written; else a path when git's `url_is_local_not_ssh` holds, or the scp-like
 * `[user@]host:path` of ssh. A missing path is left empty (git dies with "no path
 * specified" when it connects).
 */
export function parseGitUrl(given: string): GitUrl {
  // git reads the URL as a C string: nothing after a NUL reaches it
  const nul = given.indexOf("\0");
  const raw = nul >= 0 ? given.slice(0, nul) : given;
  const helper = helperLength(raw);
  if (helper > 0) {
    const address = raw.slice(helper + 2);
    return {
      raw,
      scheme: raw.slice(0, helper),
      path: address,
      scpLike: false,
      local: false,
      address,
    };
  }

  if (isGitUrl(raw)) {
    const written = raw.slice(0, raw.indexOf(":"));
    const builtin = builtinScheme(written);
    if (builtin) {
      const decoded = urlDecode(raw);
      const rest = decoded.slice(decoded.indexOf("://") + 3);
      const end = hostEnd(rest);
      const slash = rest.indexOf("/", end);
      let path = slash < 0 ? "" : rest.slice(slash);
      const authority = slash < 0 ? rest : rest.slice(0, slash);
      if (builtin !== "file" && path.startsWith("/~")) path = path.slice(1);
      let parts: { user?: string; host?: string; port?: number };
      if (builtin === "file") {
        parts = authority ? { host: authority } : {};
      } else {
        const { host, port } = gitHostAndPort(authority, builtin === "ssh");
        parts = { ...splitUser(host), ...(port !== undefined ? { port } : {}) };
      }
      return {
        raw,
        scheme: builtin,
        ...(parts.host !== undefined ? { host: parts.host } : {}),
        ...(parts.port !== undefined ? { port: parts.port } : {}),
        ...(parts.user !== undefined ? { user: parts.user } : {}),
        path,
        scpLike: false,
        local: false,
        authority,
      };
    }
    // http(s) and any other scheme: the authority up to the first `/`, `?` or `#`
    const rest = raw.slice(raw.indexOf("://") + 3);
    const stop = rest.search(/[/?#]/);
    const authority = stop < 0 ? rest : rest.slice(0, stop);
    const parts = splitAuthority(authority);
    const user = parts.user?.split(":")[0];
    return {
      raw,
      scheme:
        written.toLowerCase() === "http" || written.toLowerCase() === "https"
          ? written.toLowerCase()
          : written,
      ...(parts.host !== undefined ? { host: parts.host } : {}),
      ...(parts.port !== undefined ? { port: parts.port } : {}),
      ...(user ? { user: urlDecode(`x:${user}`).slice(2) } : {}),
      path: stop < 0 ? "" : rest.slice(stop),
      scpLike: false,
      local: false,
      authority,
    };
  }

  if (urlIsLocalNotSsh(raw)) {
    return { raw, scheme: "file", path: raw, scpLike: false, local: true };
  }

  // scp-like `[user@]host:path`: the path after the first colon past a bracketed host
  const end = hostEnd(raw);
  const colon = raw.indexOf(":", end);
  const authority = raw.slice(0, colon);
  let path = raw.slice(colon + 1);
  // parse_connect_url: `host:/~user/x` asks for `~user/x`
  if (path.startsWith("/~")) path = path.slice(1);
  const { host, port } = gitHostAndPort(authority, true);
  const parts = { ...splitUser(host), ...(port !== undefined ? { port } : {}) };
  return {
    raw,
    scheme: "ssh",
    ...(parts.host !== undefined ? { host: parts.host } : {}),
    ...(parts.port !== undefined ? { port: parts.port } : {}),
    ...(parts.user !== undefined ? { user: parts.user } : {}),
    path,
    scpLike: true,
    local: false,
    authority,
  };
}
