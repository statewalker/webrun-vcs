/**
 * git's `FETCH_HEAD` file: what a fetch took, one line per remote ref, the refs to merge
 * first (fetch.c store_updated_refs and append_fetch_head).
 */

/** One line of `FETCH_HEAD`. */
export interface FetchHeadEntry {
  /** The remote ref's value */
  oid: string;
  /** The remote ref (`refs/heads/main`, `refs/tags/v1`, `HEAD`, or an object id) */
  remoteRef: string;
  /** Not one of the refs `git pull` merges (`not-for-merge`) */
  notForMerge: boolean;
}

/** A parsed line of `FETCH_HEAD`. */
export interface ParsedFetchHeadLine {
  oid: string;
  notForMerge: boolean;
  /** The rest of the line: `branch 'main' of <url>`, `tag 'v1' of <url>`, `<url>` */
  description: string;
}

/**
 * `FETCH_HEAD` as git writes it: `<oid>\t[not-for-merge]\t<description>\n` per entry, the
 * entries to merge first and then the others, each group in the given order. The
 * description names the ref (`branch 'main' of `, `tag 'v1' of `, `remote-tracking branch
 * 'origin/x' of `, `'refs/notes/x' of `, nothing for `HEAD`) and then the remote's URL
 * without credentials, trailing slashes or `.git` ({@link fetchHeadUrl}).
 *
 * @example
 * ```ts
 * formatFetchHead(
 *   [
 *     { oid: tip, remoteRef: "refs/heads/main", notForMerge: false },
 *     { oid: tag, remoteRef: "refs/tags/v1", notForMerge: true },
 *   ],
 *   "https://example.com/repo.git",
 * );
 * // `${tip}\t\tbranch 'main' of https://example.com/repo\n` +
 * // `${tag}\tnot-for-merge\ttag 'v1' of https://example.com/repo\n`
 * ```
 */
export function formatFetchHead(entries: readonly FetchHeadEntry[], url: string): string {
  const shownUrl = fetchHeadUrl(url).replaceAll("\n", "\\n");
  let out = "";
  for (const merge of [true, false]) {
    for (const entry of entries) {
      if (entry.notForMerge === merge) continue;
      const marker = entry.notForMerge ? "not-for-merge" : "";
      out += `${entry.oid}\t${marker}\t${describeRef(entry.remoteRef)}${shownUrl}\n`;
    }
  }
  return out;
}

/** The lines of a `FETCH_HEAD` file (blank lines skipped). */
export function parseFetchHead(content: string): ParsedFetchHeadLine[] {
  const lines: ParsedFetchHeadLine[] = [];
  for (const line of content.split("\n")) {
    if (line === "") continue;
    const first = line.indexOf("\t");
    const second = first < 0 ? -1 : line.indexOf("\t", first + 1);
    if (first < 0 || second < 0) {
      throw new Error(`malformed FETCH_HEAD line: ${line}`);
    }
    lines.push({
      oid: line.slice(0, first),
      notForMerge: line.slice(first + 1, second) === "not-for-merge",
      description: line.slice(second + 1),
    });
  }
  return lines;
}

/**
 * The URL as `FETCH_HEAD` shows it: credentials removed (git's transport_anonymize_url),
 * then trailing slashes and a final `.git` dropped.
 */
export function fetchHeadUrl(url: string): string {
  const anonymized = anonymizeUrl(url);
  let i = anonymized.length - 1;
  while (i >= 0 && anonymized[i] === "/") i--;
  let end = i + 1;
  if (i > 4 && anonymized.slice(i - 3, i + 1) === ".git") end = i - 3;
  return anonymized.slice(0, end);
}

/** `branch 'main' of `, `tag 'v1' of `, … (empty for `HEAD`), as fetch.c names a ref. */
function describeRef(name: string): string {
  if (name === "HEAD") return "";
  const kinds: [string, string][] = [
    ["refs/heads/", "branch "],
    ["refs/tags/", "tag "],
    ["refs/remotes/", "remote-tracking branch "],
  ];
  for (const [prefix, kind] of kinds) {
    if (name.startsWith(prefix)) {
      const what = name.slice(prefix.length);
      return what ? `${kind}'${what}' of ` : "";
    }
  }
  return `'${name}' of `;
}

/** git's transport_anonymize_url: `https://user:pw@host/x` → `https://host/x`, `me@host:x` → `host:x`. */
export function anonymizeUrl(url: string): string {
  const at = url.indexOf("@");
  if (at < 0 || isLocalUrl(url)) return url;
  const anonPart = url.slice(at + 1);
  const schemeAt = url.indexOf("://");
  if (schemeAt < 0) {
    // cannot be "me@there:/path/name"
    return anonPart.includes(":") ? anonPart : url;
  }
  if (!/^[A-Za-z0-9+.-]*$/.test(url.slice(0, schemeAt))) return url;
  // an @ past the first slash does not count
  const slash = url.indexOf("/", schemeAt + 3);
  if (slash >= 0 && slash < at + 1) return url;
  return `${url.slice(0, schemeAt + 3)}${anonPart}`;
}

/** git's url_is_local_not_ssh: no colon, or a slash before the first colon. */
function isLocalUrl(url: string): boolean {
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  return colon < 0 || (slash >= 0 && slash < colon);
}
