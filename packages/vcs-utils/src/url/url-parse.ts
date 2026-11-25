/**
 * git's `url_parse` (urlmatch.c, git 2.5x's `git url-parse`): a git URL in any of its forms
 * (`scheme://...`, scp-like `[user@]host:path`, with `[...]` around an IPv6 address or a
 * `host:port`) normalized as `url_normalize` does, with the offsets of its parts. An scp-like
 * URL becomes `ssh://`; for `ssh` and `git` URLs a path starting with `/~` loses its `/`
 * (`~user/repo`).
 *
 * ```typescript
 * const parsed = urlParse("user@example.com:~user/repo");
 * if (!("error" in parsed)) urlComponent(parsed, "path"); // "~user/repo"
 * urlParse("/abs/path").error;
 * // "'/abs/path' is not a URL; if you meant a local repository, use 'file:///abs/path'"
 * ```
 *
 * @module
 */

import { decodeGitPath, encodeGitPath } from "../encoding/index.js";
import { isUrlNormalizeError, type NormalizedUrl, normalizeUrl } from "./urlmatch.js";

/** A part of a URL, as `git url-parse -c <component>` names them. */
export type UrlComponent = "scheme" | "user" | "password" | "host" | "port" | "path";

/** The components `git url-parse -c` knows. */
export const URL_COMPONENTS: readonly UrlComponent[] = [
  "path",
  "host",
  "scheme",
  "user",
  "password",
  "port",
];

/** Bytes of a string, one character per byte, as git sees them. */
function toBytes(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range
  if (/^[\x00-\x7f]*$/.test(text)) return text;
  let out = "";
  // a byte that is no UTF-8 (decodeGitPath's U+DC80..U+DCFF) is that byte again
  for (const b of encodeGitPath(text)) out += String.fromCharCode(b);
  return out;
}

/** A byte string back to text, as git paths are decoded (`decodeGitPath`). */
function fromBytes(bytes: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range
  if (/^[\x00-\x7f]*$/.test(bytes)) return bytes;
  return decodeGitPath(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
}

/** url.c's `url_is_local_not_ssh` (no DOS drive prefixes off Windows). */
export function urlIsLocalNotSsh(url: string): boolean {
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  return colon < 0 || (slash >= 0 && slash < colon);
}

const isAlnum = (c: string) => /^[A-Za-z0-9]$/.test(c);

/** url.c's `is_url`: a scheme of `[A-Za-z0-9][A-Za-z0-9+.-]*` followed by `://`. */
function isUrl(url: string): boolean {
  if (!isAlnum(url[0] ?? "")) return false;
  let i = 1;
  while (i < url.length && url[i] !== ":") {
    const c = url[i] as string;
    if (!isAlnum(c) && c !== "+" && c !== "-" && c !== ".") return false;
    i++;
  }
  return url.startsWith("://", i);
}

/** url.c's `url_decode`: `%XX` escapes (but `%00`) decoded after the scheme's colon. */
function urlDecode(url: string): string {
  const colon = url.indexOf(":");
  let out = colon > 0 ? url.slice(0, colon) : "";
  let i = colon > 0 ? colon : 0;
  while (i < url.length) {
    const c = url[i] as string;
    if (c === "%" && i + 3 <= url.length && /^[0-9A-Fa-f]{2}$/.test(url.slice(i + 1, i + 3))) {
      const value = Number.parseInt(url.slice(i + 1, i + 3), 16);
      if (value > 0) {
        out += String.fromCharCode(value);
        i += 3;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** url.c's `url_get_scheme`, as far as `url_parse` asks: ssh and git. */
function schemeKind(name: string): "ssh" | "git" | "other" {
  if (name === "ssh" || name === "git+ssh" || name === "ssh+git") return "ssh";
  return name === "git" ? "git" : "other";
}

/**
 * git's `url_parse`: the URL normalized with its parts, or git's reason for refusing it as
 * `git url-parse` dies with it (without `fatal: `): a local path (`'<url>' is not a URL; ...`)
 * or a URL `url_normalize` refuses (`invalid git URL '<url>': <reason>`).
 */
export function urlParse(input: string): NormalizedUrl | { error: string } {
  const original = toBytes(input);
  if (urlIsLocalNotSsh(original)) {
    return {
      error: original.startsWith("/")
        ? `'${input}' is not a URL; if you meant a local repository, use 'file://${input}'`
        : `'${input}' is not a URL; if you meant a local repository, use a 'file://' URL with an absolute path`,
    };
  }
  let url = isUrl(original) ? urlDecode(original) : original;
  let scheme: "ssh" | "git" | "other" | "local" = "local";
  let host = url.indexOf("://");
  let scp = false;
  if (host >= 0) {
    scheme = schemeKind(url.slice(0, host));
    host += 3;
  } else if (!urlIsLocalNotSsh(url)) {
    scp = true;
    scheme = "ssh";
    url = `ssh://${url}`;
    host = "ssh://".length;
  }
  if (scp) {
    // the path follows the ':' after the host part: past `user@` and any `[...]`
    const userAt = url.indexOf("@", host);
    const hostStart = userAt >= 0 ? userAt + 1 : host;
    let separator: number;
    if (url[hostStart] === "[") {
      const bracketEnd = url.indexOf("]", hostStart);
      let innerColons = 0;
      for (let p = hostStart + 1; bracketEnd >= 0 && p < bracketEnd; p++) {
        if (url[p] === ":") innerColons++;
      }
      if (bracketEnd >= 0 && innerColons <= 1) {
        // `[host]` or `[host:port]`: the brackets go
        url =
          url.slice(0, hostStart) +
          url.slice(hostStart + 1, bracketEnd) +
          url.slice(bracketEnd + 1);
        separator = bracketEnd - 1;
      } else if (bracketEnd >= 0) separator = url.indexOf(":", bracketEnd + 1);
      else separator = url.indexOf(":", hostStart);
    } else separator = url.indexOf(":", hostStart);
    // git replaces whatever follows `[host]` (meant to be the `:`)
    if (separator >= 0 && separator < url.length) {
      url =
        url[separator + 1] === "/"
          ? url.slice(0, separator) + url.slice(separator + 1)
          : `${url.slice(0, separator)}/${url.slice(separator + 1)}`;
    }
  }
  const normalized = normalizeUrl(url, { bytes: true });
  if (isUrlNormalizeError(normalized)) {
    return { error: `invalid git URL '${input}': ${normalized.error}` };
  }
  // `ssh://host/~user/repo`, `git://host/~user/repo`, `host:~user/repo`: the path is `~user/repo`
  if ((scheme === "ssh" || scheme === "git") && normalized.url[normalized.pathOffset + 1] === "~") {
    return {
      ...normalized,
      pathOffset: normalized.pathOffset + 1,
      pathLength: normalized.pathLength - 1,
    };
  }
  return normalized;
}

/** A component of a parsed URL as `git url-parse -c <component>` prints it ("" for none). */
export function urlComponent(url: NormalizedUrl, component: UrlComponent): string {
  const [offset, length] =
    component === "scheme"
      ? [0, url.schemeLength]
      : component === "user"
        ? [url.userOffset, url.userLength]
        : component === "password"
          ? [url.passwordOffset, url.passwordLength]
          : component === "host"
            ? [url.hostOffset, url.hostLength]
            : component === "port"
              ? [url.portOffset, url.portLength]
              : [url.pathOffset, url.pathLength];
  return fromBytes(url.url.slice(offset, offset + length));
}
