/**
 * git's URL matching for `<section>.<url>.<key>` configuration (urlmatch.c): `http.<url>.*`,
 * `credential.<url>.*`, `git config --get-urlmatch`.
 *
 * ```typescript
 * const url = normalizeUrl("HTTPS://User@Example.COM:443/a/./b/../c");
 * // { url: "https://User@example.com/a/c", ... }
 * const pattern = normalizeUrl("https://*.example.com", { allowGlobs: true });
 * matchUrls(normalizeUrl("https://sub.example.com/x"), pattern); // { hostLength: 13, pathLength: 1, userMatched: false }
 *
 * const chosen = selectUrlMatches(entries, { section: "http", url: "https://example.com/repo" });
 * // the best entry for each key, as git's urlmatch_config_entry picks them
 * ```
 *
 * A URL is normalized as `url_normalize` does (RFC 3986): scheme and host lowercased,
 * `%XX` escapes that need not be escaped decoded and those that must be encoded (in upper
 * case), the default port and leading zeros of a port dropped, `.` and `..` path segments
 * resolved, a `/` path added when there is none. Matching then compares scheme, user (when the
 * pattern has one), host (`*` matches one dot-separated component in patterns), port and a path
 * prefix ending at a `/`; among several matching entries of one key the one with the longest
 * host wins, then the longest path, then the one naming a user, then the later one.
 *
 * Strings are handled as git handles bytes: a non-ASCII character is encoded as UTF-8 and
 * each byte escaped.
 *
 * @module
 */

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const DIGIT = "0123456789";
const SCHEME_CHARS = `${ALPHA}${DIGIT}+.-`;
const HOST_CHARS = `${ALPHA}${DIGIT}.-_[:]`;
const UNSAFE_CHARS = ' <>"%{}|\\^`';
const RESERVED = ":/?#[]@!$&'()*+,;=";

/** A URL as git's `url_normalize` leaves it, with the offsets of its parts (`struct url_info`). */
export interface NormalizedUrl {
  /** The normalized URL */
  url: string;
  /** Length of the scheme (without `://`) */
  schemeLength: number;
  /** Offset of the user name, 0 when the URL names none */
  userOffset: number;
  userLength: number;
  /** Offset of the password, 0 when the URL has none */
  passwordOffset: number;
  passwordLength: number;
  /** Offset of the host, 0 when there is none (a `file:` URL) */
  hostOffset: number;
  hostLength: number;
  /** Offset of the port, 0 when there is none or it is the default */
  portOffset: number;
  portLength: number;
  /** Offset of the path (always starting with `/`) */
  pathOffset: number;
  pathLength: number;
}

/** A URL git refuses to normalize, with git's (translated) reason. */
export interface UrlNormalizeError {
  error: string;
}

/** How a pattern matched a URL (`struct urlmatch_item`); longer matches win. */
export interface UrlMatch {
  /** The length of the pattern's host */
  hostLength: number;
  /** The length of the path matched, including its implicit final `/` */
  pathLength: number;
  /** Whether the pattern named the URL's user */
  userMatched: boolean;
}

/** Bytes of a string as a "binary" string (one char per byte), as git sees them. */
function toBytes(text: string): string {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return text;
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

const hexValue = (c: string | undefined): number => {
  if (c === undefined) return -1;
  const v = Number.parseInt(c, 16);
  return /^[0-9a-fA-F]$/.test(c) ? v : -1;
};

/** git's `append_normalized_escapes`; undefined for a bad `%` escape. */
function normalizedEscapes(from: string, escOk: string): string | undefined {
  let out = "";
  for (let i = 0; i < from.length; ) {
    let ch = from.charCodeAt(i++);
    let wasEscaped = false;
    if (ch === 0x25 /* % */) {
      if (from.length - i < 2) return undefined;
      const hi = hexValue(from[i]);
      const lo = hexValue(from[i + 1]);
      if (hi < 0 || lo < 0) return undefined;
      ch = (hi << 4) | lo;
      i += 2;
      wasEscaped = true;
    }
    const c = String.fromCharCode(ch);
    if (ch <= 0x1f || ch >= 0x7f || UNSAFE_CHARS.includes(c) || (wasEscaped && escOk.includes(c))) {
      out += `%${ch.toString(16).toUpperCase().padStart(2, "0")}`;
    } else out += c;
  }
  return out;
}

/** strspn: the length of the prefix of `s` made of `chars` */
function span(s: string, from: number, chars: string): number {
  let n = 0;
  while (from + n < s.length && chars.includes(s[from + n] as string)) n++;
  return n;
}

/** strcspn: the length of the prefix of `s` made of anything but `chars` */
function cspan(s: string, from: number, chars: string): number {
  let n = 0;
  while (from + n < s.length && !chars.includes(s[from + n] as string)) n++;
  return n;
}

/**
 * git's `url_normalize` (`url_normalize_pattern` with `allowGlobs`: `*` allowed in the host).
 *
 * @returns the normalized URL with its parts, or git's reason for refusing it
 * (`invalid URL scheme name or missing '://' suffix`, `invalid %XX escape sequence`,
 * `missing host and scheme is not 'file:'`, `a 'file:' URL may not have a port number`,
 * `invalid characters in host name`, `invalid port number`, `invalid '..' path segment`)
 */
export function normalizeUrl(
  input: string,
  options: { allowGlobs?: boolean } = {},
): NormalizedUrl | UrlNormalizeError {
  const url = toBytes(input);
  let at = 0;
  let spanned = span(url, 0, SCHEME_CHARS);
  if (
    !spanned ||
    !/[A-Za-z]/.test(url[0] ?? "") ||
    spanned + 3 > url.length ||
    url[spanned] !== ":" ||
    url[spanned + 1] !== "/" ||
    url[spanned + 2] !== "/"
  ) {
    return { error: "invalid URL scheme name or missing '://' suffix" };
  }
  const schemeLength = spanned;
  let norm = url.slice(0, spanned + 3).toLowerCase();
  at = spanned + 3;

  let userOffset = 0;
  let userLength = 0;
  let passwordOffset = 0;
  let passwordLength = 0;
  const atSign = url.indexOf("@", at);
  const slash = at + cspan(url, at, "/?#");
  if (atSign >= 0 && atSign < slash) {
    userOffset = norm.length;
    if (atSign > at) {
      const escaped = normalizedEscapes(url.slice(at, atSign), RESERVED);
      if (escaped === undefined) return { error: "invalid %XX escape sequence" };
      norm += escaped;
      const colon = norm.indexOf(":", schemeLength + 3);
      if (colon >= 0) {
        passwordOffset = colon + 1;
        passwordLength = norm.length - passwordOffset;
        userLength = passwordOffset - 1 - (schemeLength + 3);
      } else userLength = norm.length - (schemeLength + 3);
    }
    norm += "@";
    at = atSign + 1;
  }

  let hostOffset = 0;
  if (at >= url.length || ":/?#".includes(url[at] as string)) {
    if (!norm.startsWith("file:")) return { error: "missing host and scheme is not 'file:'" };
  } else hostOffset = norm.length;
  let colon = slash - 1;
  while (colon > at && url[colon] !== ":" && url[colon] !== "]") colon--;
  if (url[colon] !== ":") colon = slash;
  else if (!hostOffset && colon < slash && colon + 1 !== slash) {
    return { error: "a 'file:' URL may not have a port number" };
  }
  spanned = span(url, at, options.allowGlobs ? `${HOST_CHARS}*` : HOST_CHARS);
  if (spanned < colon - at) return { error: "invalid characters in host name" };
  norm += url.slice(at, colon).toLowerCase();
  at = colon;

  let portOffset = 0;
  let portLength = 0;
  if (colon < slash) {
    at++;
    at += span(url, at, "0");
    if (at === slash && url[at - 1] === "0") at--;
    const port = url.slice(at, slash);
    if (at === slash) {
      // ":" with no number: the default
    } else if (port.length === 2 && norm.startsWith("http:") && port === "80") {
      // http's default
    } else if (port.length === 3 && norm.startsWith("https:") && port === "443") {
      // https's default
    } else {
      if (span(url, at, DIGIT) < slash - at) return { error: "invalid port number" };
      const number = port.length <= 5 ? Number.parseInt(port, 10) : 0;
      if (number === 0 || number > 65535) return { error: "invalid port number" };
      norm += ":";
      portOffset = norm.length;
      norm += port;
      portLength = port.length;
    }
    at = slash;
  }
  const hostLength = hostOffset ? norm.length - hostOffset - (portLength ? portLength + 1 : 0) : 0;

  const pathOffset = norm.length;
  if (url[at] === "/") at++;
  // the path's segments, `.` dropped and `..` taking the one before it (a stack, joined once:
  // rebuilding the string per segment would be quadratic in their number)
  const segments: string[] = [];
  for (;;) {
    const next = at + cspan(url, at, "/?#");
    const segment = normalizedEscapes(url.slice(at, next), RESERVED);
    if (segment === undefined) return { error: "invalid %XX escape sequence" };
    if (segment === "..") {
      if (segments.length === 0) return { error: "invalid '..' path segment" };
      segments.pop();
    } else if (segment !== ".") segments.push(segment);
    at = next;
    if (url[at] !== "/") break;
    at++;
  }
  norm += `/${segments.join("/")}`;
  const pathLength = norm.length - pathOffset;

  if (at < url.length) {
    const escaped = normalizedEscapes(url.slice(at), RESERVED);
    if (escaped === undefined) return { error: "invalid %XX escape sequence" };
    norm += escaped;
  }
  return {
    url: norm,
    schemeLength,
    userOffset,
    userLength,
    passwordOffset,
    passwordLength,
    hostOffset,
    hostLength,
    portOffset,
    portLength,
    pathOffset,
    pathLength,
  };
}

/** Whether `normalizeUrl` refused the URL. */
export function isUrlNormalizeError(
  value: NormalizedUrl | UrlNormalizeError,
): value is UrlNormalizeError {
  return "error" in value;
}

/** git's `match_host`: dot-separated components, `*` in the pattern matching any one. */
function matchHost(url: NormalizedUrl, pattern: NormalizedUrl): boolean {
  let u = url.url.slice(url.hostOffset, url.hostOffset + url.hostLength);
  let p = pattern.url.slice(pattern.hostOffset, pattern.hostOffset + pattern.hostLength);
  while (u.length && p.length) {
    const uEnd = u.indexOf(".") < 0 ? u.length : u.indexOf(".");
    const pEnd = p.indexOf(".") < 0 ? p.length : p.indexOf(".");
    if (!(pEnd === 1 && p[0] === "*") && u.slice(0, uEnd) !== p.slice(0, pEnd)) return false;
    u = u.slice(uEnd < u.length ? uEnd + 1 : uEnd);
    p = p.slice(pEnd < p.length ? pEnd + 1 : pEnd);
  }
  return !u.length && !p.length;
}

/** git's `url_match_prefix`: the length matched (with the implicit final `/`), 0 for none. */
function matchPathPrefix(path: string, prefix: string): number {
  if (prefix === "" || prefix === "/") return path === "" || path[0] === "/" ? 1 : 0;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (!path.startsWith(p)) return 0;
  if (path.length === p.length || path[p.length] === "/") return p.length + 1;
  return 0;
}

/**
 * git's `match_urls`: whether the (normalized) `pattern` matches `url`: the same scheme, the
 * pattern's user if it names one, the host (`*` components), the port, and a path prefix
 * ending at a `/`.
 */
export function matchUrls(url: NormalizedUrl, pattern: NormalizedUrl): UrlMatch | undefined {
  if (
    pattern.schemeLength !== url.schemeLength ||
    url.url.slice(0, url.schemeLength) !== pattern.url.slice(0, url.schemeLength)
  ) {
    return undefined;
  }
  let userMatched = false;
  if (pattern.userOffset) {
    if (
      !url.userOffset ||
      url.userLength !== pattern.userLength ||
      url.url.slice(url.userOffset, url.userOffset + url.userLength) !==
        pattern.url.slice(pattern.userOffset, pattern.userOffset + pattern.userLength)
    ) {
      return undefined;
    }
    userMatched = true;
  }
  if (!matchHost(url, pattern)) return undefined;
  if (
    pattern.portLength !== url.portLength ||
    url.url.slice(url.portOffset, url.portOffset + url.portLength) !==
      pattern.url.slice(pattern.portOffset, pattern.portOffset + url.portLength)
  ) {
    return undefined;
  }
  const pathLength = matchPathPrefix(
    url.url.slice(url.pathOffset),
    pattern.url.slice(pattern.pathOffset),
  );
  if (!pathLength) return undefined;
  return { hostLength: pattern.hostLength, pathLength, userMatched };
}

/** git's `cmp_matches`: negative when `a` is a worse match than `b`. */
export function compareUrlMatches(a: UrlMatch, b: UrlMatch): number {
  if (a.hostLength !== b.hostLength) return a.hostLength < b.hostLength ? -1 : 1;
  if (a.pathLength !== b.pathLength) return a.pathLength < b.pathLength ? -1 : 1;
  if (a.userMatched !== b.userMatched) return b.userMatched ? -1 : 1;
  return 0;
}

/** The match of a key without a URL (`http.sslVerify`): the weakest there is. */
const NO_URL_MATCH: UrlMatch = { hostLength: 0, pathLength: 0, userMatched: false };

/**
 * git's `urlmatch_config_entry` over a whole configuration: for each `<section>.<key>` and
 * `<section>.<url>.<key>` entry (canonical keys, in the configuration's order) whose URL
 * matches, the entry chosen for its key, keyed by `<section>.<key>` in byte order (git's
 * sorted string list). A later entry replaces an earlier one unless its match is worse.
 *
 * @param entries the configuration's entries, keys canonical (`http.https://Example.com.sslverify`)
 * @param section the section, lower case (`http`)
 * @param url the URL, normalized with {@link normalizeUrl}
 * @param key only this key (lower case), or every key of the section
 */
export function selectUrlMatches<E extends { key: string }>(
  entries: Iterable<E>,
  section: string,
  url: NormalizedUrl,
  key?: string,
): Map<string, E> {
  const best = new Map<string, { entry: E; match: UrlMatch }>();
  for (const entry of entries) {
    const var_ = entry.key;
    if (!var_.startsWith(section) || var_[section.length] !== ".") continue;
    let rest = var_.slice(section.length + 1);
    let match = NO_URL_MATCH;
    const dot = rest.lastIndexOf(".");
    if (dot >= 0) {
      const pattern = normalizeUrl(rest.slice(0, dot), { allowGlobs: true });
      if (isUrlNormalizeError(pattern)) continue;
      const matched = matchUrls(url, pattern);
      if (!matched) continue;
      match = matched;
      rest = rest.slice(dot + 1);
    }
    if (key !== undefined && rest !== key) continue;
    const previous = best.get(rest);
    if (previous && compareUrlMatches(match, previous.match) < 0) continue;
    best.set(rest, { entry, match });
  }
  const names = [...best.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out = new Map<string, E>();
  for (const name of names) out.set(`${section}.${name}`, (best.get(name) as { entry: E }).entry);
  return out;
}
