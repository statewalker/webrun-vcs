/**
 * The part of Go's `net/url` git-lfs relies on to read endpoint URLs (`url.Parse` and
 * `(*URL).String`, Go 1.22): git-lfs passes an http(s), `file:` or `git:` URL through
 * `String()`, which re-escapes its path, and reads an ssh URL's host, user and decoded path.
 * Only what changes an endpoint is kept: parse errors (a colon in the first path segment of a
 * URL without scheme, a port that is no number, a bad escape), the lower-cased scheme, the
 * opaque form (`host:path`) and the path's re-encoding.
 *
 * @example
 * ```typescript
 * const u = goUrlParse("HTTPS://h/a b");
 * goUrlString(u); // "https://h/a%20b"
 * ```
 */

/** A parsed URL, as Go's `url.URL` holds it. */
export interface GoUrl {
  /** Lower case */
  scheme: string;
  opaque: string;
  /** `undefined` when the URL has no `@` */
  user?: { username: string; password?: string };
  host: string;
  /** Unescaped */
  path: string;
  /** The path as written when it differs from Go's own encoding */
  rawPath: string;
  omitHost: boolean;
  forceQuery: boolean;
  rawQuery: string;
  /** Unescaped */
  fragment: string;
  rawFragment: string;
}

type EncodeMode = "path" | "pathSegment" | "host" | "zone" | "userPassword" | "query" | "fragment";

const isHex = (c: number) =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
const unhex = (c: number) =>
  c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x61 && c <= 0x66 ? c - 0x57 : c - 0x37;

/** Go's `shouldEscape` for one byte. */
function shouldEscape(c: number, mode: EncodeMode): boolean {
  if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39)) {
    return false;
  }
  if (mode === "host" || mode === "zone") {
    switch (String.fromCharCode(c)) {
      case "!":
      case "$":
      case "&":
      case "'":
      case "(":
      case ")":
      case "*":
      case "+":
      case ",":
      case ";":
      case "=":
      case ":":
      case "[":
      case "]":
      case "<":
      case ">":
      case '"':
        return false;
    }
  }
  switch (String.fromCharCode(c)) {
    case "-":
    case "_":
    case ".":
    case "~":
      return false;
    case "$":
    case "&":
    case "+":
    case ",":
    case "/":
    case ":":
    case ";":
    case "=":
    case "?":
    case "@":
      switch (mode) {
        case "path":
          return c === 0x3f; // '?'
        case "pathSegment":
          return c === 0x2f || c === 0x3b || c === 0x2c || c === 0x3f;
        case "userPassword":
          return c === 0x40 || c === 0x2f || c === 0x3f || c === 0x3a;
        case "query":
          return true;
        case "fragment":
          return false;
      }
  }
  if (mode === "fragment") {
    switch (String.fromCharCode(c)) {
      case "!":
      case "(":
      case ")":
      case "*":
        return false;
    }
  }
  return true;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Go's `unescape`; throws where Go returns an error. */
function goUnescape(s: string, mode: EncodeMode): string {
  const bytes = encoder.encode(s);
  let hasPercent = false;
  for (let i = 0; i < bytes.length; ) {
    const c = bytes[i] as number;
    if (c === 0x25) {
      hasPercent = true;
      if (
        i + 2 >= bytes.length ||
        !isHex(bytes[i + 1] as number) ||
        !isHex(bytes[i + 2] as number)
      ) {
        throw new Error("invalid URL escape");
      }
      if (mode === "host" && unhex(bytes[i + 1] as number) < 8 && s.slice(i, i + 3) !== "%25") {
        throw new Error("invalid URL escape");
      }
      i += 3;
    } else {
      if ((mode === "host" || mode === "zone") && c < 0x80 && shouldEscape(c, mode)) {
        throw new Error("invalid character in host name");
      }
      i++;
    }
  }
  if (!hasPercent) return s;
  const out: number[] = [];
  for (let i = 0; i < bytes.length; ) {
    const c = bytes[i] as number;
    if (c === 0x25) {
      out.push((unhex(bytes[i + 1] as number) << 4) | unhex(bytes[i + 2] as number));
      i += 3;
    } else {
      out.push(c);
      i++;
    }
  }
  return decoder.decode(new Uint8Array(out));
}

/** Go's `escape`. */
function goEscape(s: string, mode: EncodeMode): string {
  let out = "";
  for (const c of encoder.encode(s)) {
    if (shouldEscape(c, mode)) out += `%${c.toString(16).toUpperCase().padStart(2, "0")}`;
    else out += String.fromCharCode(c);
  }
  return out;
}

/** Go's `validEncoded`: `s` is a valid encoding of some text in `mode`. */
function validEncoded(s: string, mode: EncodeMode): boolean {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if ("!$&'()*+,;=:@[]".includes(ch)) continue;
    if (ch === "%") continue;
    const c = s.charCodeAt(i);
    if (c >= 0x80 || shouldEscape(c, mode)) return false;
  }
  return true;
}

function getScheme(raw: string): [string, string] {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)) continue;
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      if (i === 0) return ["", raw];
      continue;
    }
    if (c === 0x3a) {
      if (i === 0) throw new Error("missing protocol scheme");
      return [raw.slice(0, i), raw.slice(i + 1)];
    }
    return ["", raw];
  }
  return ["", raw];
}

function validOptionalPort(port: string): boolean {
  if (port === "") return true;
  if (port[0] !== ":") return false;
  return /^[0-9]*$/.test(port.slice(1));
}

function parseHost(host: string): string {
  if (host.startsWith("[")) {
    const i = host.lastIndexOf("]");
    if (i < 0) throw new Error("missing ']' in host");
    const colonPort = host.slice(i + 1);
    if (!validOptionalPort(colonPort)) throw new Error("invalid port");
    const zone = host.slice(0, i).indexOf("%25");
    if (zone >= 0) {
      return (
        goUnescape(host.slice(0, zone), "host") +
        goUnescape(host.slice(zone, i), "zone") +
        goUnescape(host.slice(i), "host")
      );
    }
  } else {
    const i = host.lastIndexOf(":");
    if (i >= 0 && !validOptionalPort(host.slice(i))) throw new Error("invalid port");
  }
  return goUnescape(host, "host");
}

const validUserinfo = (s: string) => /^[A-Za-z0-9\-._:~!$&'()*+,;=%@]*$/.test(s);

function parseAuthority(authority: string): Pick<GoUrl, "user" | "host"> {
  const i = authority.lastIndexOf("@");
  if (i < 0) return { host: parseHost(authority) };
  const host = parseHost(authority.slice(i + 1));
  const userinfo = authority.slice(0, i);
  if (!validUserinfo(userinfo)) throw new Error("net/url: invalid userinfo");
  const colon = userinfo.indexOf(":");
  if (colon < 0) return { host, user: { username: goUnescape(userinfo, "userPassword") } };
  return {
    host,
    user: {
      username: goUnescape(userinfo.slice(0, colon), "userPassword"),
      password: goUnescape(userinfo.slice(colon + 1), "userPassword"),
    },
  };
}

/** Go's `url.Parse`; throws where it returns an error. */
export function goUrlParse(rawUrl: string): GoUrl {
  const hash = rawUrl.indexOf("#");
  const beforeFragment = hash >= 0 ? rawUrl.slice(0, hash) : rawUrl;
  const rawFragment = hash >= 0 ? rawUrl.slice(hash + 1) : "";
  const u: GoUrl = {
    scheme: "",
    opaque: "",
    host: "",
    path: "",
    rawPath: "",
    omitHost: false,
    forceQuery: false,
    rawQuery: "",
    fragment: "",
    rawFragment: "",
  };
  if ([...beforeFragment].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) {
    throw new Error("net/url: invalid control character in URL");
  }
  if (beforeFragment === "*") {
    u.path = "*";
  } else if (beforeFragment !== "") {
    let [scheme, rest] = getScheme(beforeFragment);
    u.scheme = scheme.toLowerCase();
    if (rest.endsWith("?") && rest.split("?").length === 2) {
      u.forceQuery = true;
      rest = rest.slice(0, -1);
    } else {
      const q = rest.indexOf("?");
      if (q >= 0) {
        u.rawQuery = rest.slice(q + 1);
        rest = rest.slice(0, q);
      }
    }
    if (!rest.startsWith("/")) {
      if (u.scheme !== "") {
        u.opaque = rest;
        setFragment(u, rawFragment);
        return u;
      }
      const colon = rest.indexOf(":");
      const slash = rest.indexOf("/");
      if (colon >= 0 && (slash < 0 || colon < slash)) {
        throw new Error("first path segment in URL cannot contain colon");
      }
    }
    if ((u.scheme !== "" || !rest.startsWith("///")) && rest.startsWith("//")) {
      let authority = rest.slice(2);
      rest = "";
      const slash = authority.indexOf("/");
      if (slash >= 0) {
        rest = authority.slice(slash);
        authority = authority.slice(0, slash);
      }
      const parsed = parseAuthority(authority);
      u.host = parsed.host;
      if (parsed.user) u.user = parsed.user;
    } else if (u.scheme !== "" && rest.startsWith("/")) {
      u.omitHost = true;
    }
    u.path = goUnescape(rest, "path");
    u.rawPath = goEscape(u.path, "path") === rest ? "" : rest;
  }
  setFragment(u, rawFragment);
  return u;
}

function setFragment(u: GoUrl, raw: string): void {
  u.fragment = goUnescape(raw, "fragment");
  u.rawFragment = goEscape(u.fragment, "fragment") === raw ? "" : raw;
}

function escapedPath(u: GoUrl): string {
  if (u.rawPath !== "" && validEncoded(u.rawPath, "path")) {
    try {
      if (goUnescape(u.rawPath, "path") === u.path) return u.rawPath;
    } catch {
      // not a valid encoding
    }
  }
  if (u.path === "*") return "*";
  return goEscape(u.path, "path");
}

function escapedFragment(u: GoUrl): string {
  if (u.rawFragment !== "" && validEncoded(u.rawFragment, "fragment")) {
    try {
      if (goUnescape(u.rawFragment, "fragment") === u.fragment) return u.rawFragment;
    } catch {
      // not a valid encoding
    }
  }
  return goEscape(u.fragment, "fragment");
}

/** `(&url.URL{Path: path}).EscapedPath()`. */
export function goEscapedPath(path: string): string {
  return path === "*" ? "*" : goEscape(path, "path");
}

/** Go's `(*URL).String`. */
export function goUrlString(u: GoUrl): string {
  let buf = "";
  if (u.scheme !== "") buf += `${u.scheme}:`;
  if (u.opaque !== "") {
    buf += u.opaque;
  } else {
    if (u.scheme !== "" || u.host !== "" || u.user !== undefined) {
      if (!(u.omitHost && u.host === "" && u.user === undefined)) {
        if (u.host !== "" || u.path !== "" || u.user !== undefined) buf += "//";
        if (u.user !== undefined) {
          buf += goEscape(u.user.username, "userPassword");
          if (u.user.password !== undefined) buf += `:${goEscape(u.user.password, "userPassword")}`;
          buf += "@";
        }
        if (u.host !== "") buf += goEscape(u.host, "host");
      }
    }
    const path = escapedPath(u);
    if (path !== "" && path[0] !== "/" && u.host !== "") buf += "/";
    if (buf === "") {
      const segment = path.split("/")[0] ?? "";
      if (segment.includes(":")) buf += "./";
    }
    buf += path;
  }
  if (u.forceQuery || u.rawQuery !== "") buf += `?${u.rawQuery}`;
  if (u.fragment !== "") buf += `#${escapedFragment(u)}`;
  return buf;
}
