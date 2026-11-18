/**
 * The ref lines of a fetch as git prints them on stderr (builtin/fetch.c `display_ref_update`,
 * full and compact formats): `From <url>` once, then ` <code> <summary> <remote> -> <local>`,
 * the summary column `transport_summary_width` wide and the remote column `refcol_width`.
 *
 * @example
 * ```typescript
 * const result = await fetch({ url, repository, refStore, refspecs });
 * const entries = result.refUpdates.flatMap((u) => fetchUpdateDisplay(u) ?? []);
 * for (const line of formatFetchDisplay(entries, { url, summaryWidth: result.summaryWidth })) {
 *   console.error(line); // " * [new branch]      main       -> origin/main"
 * }
 * ```
 */

import { padSummary, prettifyRefName } from "../summary/index.js";
import { fetchHeadUrl } from "./fetch-head.js";
import type { FetchRefUpdate } from "./ref-updates.js";

/** One line of a fetch's report. */
export interface FetchDisplayEntry {
  /** `*` new, ` ` fast-forward, `+` forced, `t` tag update, `=` up to date, `!` refused, `-` pruned */
  code: string;
  /** The summary column: `[new branch]`, `1a2b3c4..5d6e7f8`, `[rejected]`, `[deleted]`, … */
  summary: string;
  /** The reason in parentheses after the line: `forced update`, `non-fast-forward`, … */
  detail?: string;
  /** The remote ref (full name; `(none)` for a pruned ref) */
  remote: string;
  /** The local ref written (full name, or `FETCH_HEAD`) */
  local: string;
  /** The local ref's value before (for the column widths' up-to-date test) */
  oldOid?: string;
  /** Its new value */
  newOid?: string;
}

/**
 * The line of one ref update, as git's update_local_ref chooses it; undefined for a ref
 * already up to date unless `verbose` (git shows those with `-v` only).
 */
export function fetchUpdateDisplay(
  update: FetchRefUpdate,
  verbose = false,
): FetchDisplayEntry | undefined {
  const base = {
    remote: update.remoteRef,
    local: update.localRef,
    ...(update.oldOid !== undefined ? { oldOid: update.oldOid } : {}),
    newOid: update.newOid,
  };
  switch (update.status) {
    case "up-to-date":
      return verbose ? { ...base, code: "=", summary: "[up to date]" } : undefined;
    case "new":
      return { ...base, code: "*", summary: update.summary };
    case "fast-forward":
      return { ...base, code: " ", summary: update.summary };
    case "forced":
      if (update.summary === "[tag update]") return { ...base, code: "t", summary: "[tag update]" };
      return {
        ...base,
        code: "+",
        summary: update.summary.replace(/^\+ /, ""),
        detail: "forced update",
      };
    case "rejected":
      return {
        ...base,
        code: "!",
        summary: "[rejected]",
        ...(update.reason !== undefined ? { detail: update.reason } : {}),
      };
  }
}

/** Options of {@link formatFetchDisplay}. */
export interface FormatFetchDisplayOptions {
  /** The remote's URL as given (`From <url>`) */
  url: string;
  /** The summary column's width (`FetchClientResult.summaryWidth`; 17 by default) */
  summaryWidth?: number;
  /**
   * The width of the remote column (`refcol_width`); by default computed from `entries`
   * (see {@link fetchRefcolWidth})
   */
  refcolWidth?: number;
  /** git's `fetch.output=compact`: `main -> origin/*` for a shared tail */
  compact?: boolean;
  /** The terminal's width, for `refcol_width` (default 80, git's when stderr is no terminal) */
  columns?: number;
  /** Whether the up-to-date refs are shown (`-v`), for `refcol_width` */
  verbose?: boolean;
}

/**
 * git's `refcol_width`: the widest remote name among the lines (at least 10), leaving out
 * refs already up to date (unless `verbose`), `HEAD`, lines without a local ref, and those
 * whose `21 + remote + 4 + local` would reach `columns`.
 */
export function fetchRefcolWidth(
  entries: readonly Pick<FetchDisplayEntry, "remote" | "local" | "oldOid" | "newOid">[],
  options: { compact?: boolean; columns?: number; verbose?: boolean } = {},
): number {
  let max = options.columns ?? 80;
  if (options.compact) max = Math.floor((max * 2) / 3);
  let width = 10;
  for (const e of entries) {
    if (e.local === "FETCH_HEAD" || e.remote === "HEAD") continue;
    if (!options.verbose && e.oldOid !== undefined && e.oldOid === e.newOid) continue;
    const rlen = prettifyRefName(e.remote).length;
    const llen = options.compact ? 0 : prettifyRefName(e.local).length;
    if (21 + rlen + 4 + llen >= max) continue;
    if (width < rlen) width = rlen;
  }
  return width;
}

/** git's `find_and_replace`: `needle` at a path-component boundary of `haystack` as `*`. */
function findAndReplace(haystack: string, needle: string): string | undefined {
  let at = -1;
  if (haystack.endsWith(needle)) at = haystack.length - needle.length;
  else at = haystack.indexOf(needle);
  if (at < 0) return undefined;
  if (at > 0 && haystack[at - 1] !== "/") return undefined;
  const after = haystack.length - at;
  if (after > needle.length && haystack[at + needle.length] !== "/") return undefined;
  return `${haystack.slice(0, at)}*${haystack.slice(at + needle.length)}`;
}

/**
 * The lines git prints on stderr for these entries, in order: `From <url>` before the first,
 * then each ` <code> <summary> <remote> -> <local>` with its detail as `  (<detail>)`.
 */
export function formatFetchDisplay(
  entries: readonly FetchDisplayEntry[],
  options: FormatFetchDisplayOptions,
): string[] {
  if (entries.length === 0) return [];
  const summaryWidth = options.summaryWidth ?? 17;
  const refcol =
    options.refcolWidth ??
    fetchRefcolWidth(entries, {
      compact: options.compact,
      columns: options.columns,
      verbose: options.verbose,
    });
  const lines = [`From ${fetchHeadUrl(options.url)}`];
  for (const e of entries) {
    const remote = prettifyRefName(e.remote);
    const local = prettifyRefName(e.local);
    let line = ` ${e.code} ${padSummary(e.summary, summaryWidth)} `;
    if (!options.compact) line += `${padSummary(remote, refcol)} -> ${local}`;
    else if (remote === local) line += `${padSummary(remote, refcol)} -> *`;
    else {
      let r = remote;
      let l = local;
      const replaced = findAndReplace(r, local);
      if (replaced !== undefined) r = replaced;
      else l = findAndReplace(l, remote) ?? l;
      line += `${padSummary(r, refcol)} -> ${l}`;
    }
    if (e.detail !== undefined) line += `  (${e.detail})`;
    lines.push(line);
  }
  return lines;
}
