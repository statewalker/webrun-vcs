/**
 * Bundle lists (bundle-uri.c): what a bundle URI or a server's `bundle-uri` answer describes.
 * A list has a version (1), a mode (`all`: every bundle is needed; `any`: one is enough), an
 * optional heuristic (`creationToken`: bundles ordered by a number, fetched newest first and
 * applied oldest first) and bundles by id, each with a URI resolved against the list's own URI.
 *
 * Lists come in two shapes: the `key=value` lines of a v2 `bundle-uri` answer
 * ({@link parseBundleListLine}, `bundle_uri_parse_line`) and a git config file a bundle URI
 * serves instead of a bundle ({@link parseBundleListConfig}, `bundle_uri_parse_config_format`).
 *
 * @example
 * ```ts
 * const list = new BundleList("https://example.com/repo");
 * parseBundleListLine(list, "bundle.one.uri=one.bundle");
 * printBundleList(list); // "[bundle]\n\tversion = 1\n\tmode = all\n[bundle \"one\"]\n..."
 * ```
 */

import { ConfigParseError, GitWorkingCopyConfig } from "@statewalker/vcs-store-files";

import { relativeUrl } from "../submodule-model.js";

/** One bundle of a list (`struct remote_bundle_info`). */
export interface RemoteBundleInfo {
  /** The `<id>` of `bundle.<id>.*` */
  readonly id: string;
  /** `bundle.<id>.uri`, resolved against the list's base URI */
  uri?: string;
  /** `bundle.<id>.creationToken` (0 when unset or unparsable) */
  creationToken: bigint;
  /** The downloaded bytes (undefined: not tried yet; null: the download failed) */
  file?: Uint8Array | null;
  /** Applied, or given up on (`unbundled`) */
  unbundled?: boolean;
}

/** git's 32-bit FNV-1 `strhash`. */
function strhash(text: string): number {
  let hash = 0x811c9dc5;
  for (const c of new TextEncoder().encode(text)) hash = (Math.imul(hash, 0x01000193) ^ c) >>> 0;
  return hash;
}

/**
 * A bundle list (`struct bundle_list`). Its bundles iterate in the order of git's hashmap
 * (hashmap.c keyed by `strhash` of the id: 64 buckets growing fourfold past 80% load, each new
 * entry first in its bucket), which decides the order bundles are downloaded and applied in.
 */
export class BundleList {
  version = 1;
  mode: "all" | "any" = "all";
  heuristic?: "creationToken";
  /** The URI relative bundle URIs resolve against */
  baseURI?: string;
  private table: { hash: number; info: RemoteBundleInfo }[][] = Array.from(
    { length: 64 },
    () => [],
  );
  private count = 0;

  constructor(baseURI?: string) {
    if (baseURI !== undefined) this.baseURI = baseURI;
  }

  /** The bundle `id` names (`hashmap_get_entry`), the first added on duplicates. */
  get(id: string): RemoteBundleInfo | undefined {
    const hash = strhash(id);
    const bucket = this.table[hash & (this.table.length - 1)] ?? [];
    // hashmap_get finds the first matching entry from the bucket's head (the newest)
    return bucket.find((e) => e.info.id === id)?.info;
  }

  /** Adds a bundle (`hashmap_add`: duplicates allowed). */
  add(info: RemoteBundleInfo): void {
    const hash = strhash(info.id);
    this.table[hash & (this.table.length - 1)]?.unshift({ hash, info });
    this.count++;
    if (this.count > Math.floor((this.table.length * 80) / 100)) {
      const size = this.table.length * 4;
      const old = this.table;
      this.table = Array.from({ length: size }, () => []);
      for (const bucket of old) {
        for (const e of bucket) this.table[e.hash & (size - 1)]?.unshift(e);
      }
    }
  }

  /** The bundles in git's iteration order (`for_all_bundles_in_list`). */
  bundles(): RemoteBundleInfo[] {
    return this.table.flat().map((e) => e.info);
  }

  get size(): number {
    return this.count;
  }
}

/** What went wrong parsing a list: git's `error:`/`warning:` lines, in order. */
export interface BundleListMessages {
  readonly lines: string[];
}

/**
 * `bundle_list_update`: applies `bundle.<key>` = `value` (`value` undefined for a key written
 * without `=`). Returns false where git returns -1 (a key outside `bundle.`, a version other
 * than 1, an unknown mode, a second `uri`, a missing value: the last with git's `error:` line).
 *
 * @throws GitApiError git's `cannot strip one component off url` death of a relative URI
 *   climbing above the base
 */
export function updateBundleList(
  list: BundleList,
  key: string,
  value: string | undefined,
  messages: string[],
): boolean {
  // parse_config_key: section `bundle` (as written: config keys come canonical), the last
  // dot ends the subsection
  const firstDot = key.indexOf(".");
  if (firstDot < 0 || key.slice(0, firstDot) !== "bundle") return false;
  const lastDot = key.lastIndexOf(".");
  const subkey = key.slice(lastDot + 1);
  const nonbool = () => {
    messages.push(`error: missing value for '${key}'`);
    return false;
  };
  if (lastDot === firstDot) {
    if (subkey === "version") {
      if (value === undefined || !/^[-+]?\d+[kmgKMG]?$/.test(value.trim())) return false;
      if (Number.parseInt(value, 10) !== 1 || /[kmgKMG]$/.test(value)) return false;
      list.version = 1;
      return true;
    }
    if (subkey === "mode") {
      if (value === undefined) return nonbool();
      if (value === "all" || value === "any") {
        list.mode = value;
        return true;
      }
      return false;
    }
    if (subkey === "heuristic") {
      if (value === undefined) return nonbool();
      if (value === "creationToken") list.heuristic = "creationToken";
      // unknown heuristics are ignored
      return true;
    }
    // other unknown global keys are ignored
    return true;
  }
  const id = key.slice(firstDot + 1, lastDot);
  let bundle = list.get(id);
  if (!bundle) {
    bundle = { id, creationToken: 0n };
    list.add(bundle);
  }
  if (subkey === "uri") {
    if (value === undefined) return nonbool();
    if (bundle.uri !== undefined) return false;
    bundle.uri = list.baseURI !== undefined ? relativeUrl(list.baseURI, value) : value;
    return true;
  }
  if (subkey === "creationtoken") {
    if (value === undefined) return nonbool();
    const token = scanUint64(value);
    if (token === undefined) {
      messages.push(`warning: could not parse bundle list key creationToken with value '${value}'`);
    } else {
      bundle.creationToken = token;
    }
    return true;
  }
  // keys for heuristics this client does not know are ignored
  return true;
}

/** `sscanf("%" PRIu64)`: leading whitespace, an optional sign, digits (wrapping at 2^64). */
function scanUint64(text: string): bigint | undefined {
  const match = /^\s*([-+]?)(\d+)/.exec(text);
  if (!match) return undefined;
  const digits = BigInt(match[2] ?? "0");
  const mod = 1n << 64n;
  return match[1] === "-" ? (mod - (digits % mod)) % mod : digits % mod;
}

/**
 * `bundle_uri_parse_line`: one `key=value` line of a `bundle-uri` answer applied to `list`.
 * Returns git's `error:` line for a malformed line (empty, no `=`, an empty key or value),
 * `""` for a line {@link updateBundleList} refuses, undefined when it was taken.
 */
export function parseBundleListLine(
  list: BundleList,
  line: string,
  messages: string[] = [],
): string | undefined {
  if (line.length === 0) return "error: bundle-uri: got an empty line";
  const equals = line.indexOf("=");
  if (equals < 0) return "error: bundle-uri: line is not of the form 'key=value'";
  if (equals === 0 || equals === line.length - 1) {
    return "error: bundle-uri: line has empty key or value";
  }
  return updateBundleList(list, line.slice(0, equals), line.slice(equals + 1), messages)
    ? undefined
    : "";
}

/**
 * `strbuf_strip_file_from_path`: the URI up to and including its last `/` (all of it when it
 * has none).
 */
export function stripFileFromPath(uri: string): string {
  const slash = uri.lastIndexOf("/");
  return slash < 0 ? uri : uri.slice(0, slash + 1);
}

/**
 * `bundle_uri_parse_config_format`: a list in git's config format, downloaded from `uri`
 * (`name` is how git names the file in its `bad config line` error). The list's base URI is
 * `uri` without its file name unless it has one already. Returns false where git returns
 * nonzero (a line git's parser refuses, a key `bundle_list_update` refuses, a bundle without a
 * URI), with git's lines in `messages`.
 *
 * @throws GitApiError a relative URI climbing above the base (git dies)
 */
export async function parseBundleListConfig(
  uri: string,
  bytes: Uint8Array,
  name: string,
  list: BundleList,
  messages: string[],
): Promise<boolean> {
  if (list.baseURI === undefined) list.baseURI = stripFileFromPath(uri);
  const config = new GitWorkingCopyConfig(
    { read: async () => bytes, write: async () => {} },
    name,
    { includes: false, fileOnly: true },
  );
  try {
    await config.load();
  } catch (error) {
    if (error instanceof ConfigParseError) {
      messages.push(`error: bad config line ${error.line} in file ${name}`);
      return false;
    }
    throw error;
  }
  for (const entry of config.listWithOrigin()) {
    if (!updateBundleList(list, entry.key, entry.text, messages)) {
      messages.push(`error: bad config line ${entry.line ?? 0} in file ${name}`);
      return false;
    }
  }
  let ok = true;
  for (const bundle of list.bundles()) {
    if (bundle.uri === undefined) {
      messages.push(`error: bundle list at '${uri}': bundle '${bundle.id}' has no uri`);
      ok = false;
    }
  }
  return ok;
}

/**
 * `print_bundle_list`: the list as a config file (the bundles in iteration order, a bundle
 * without a URI as `# uri = (missing)`).
 */
export function printBundleList(list: BundleList): string {
  let out = `[bundle]\n\tversion = ${list.version}\n\tmode = ${list.mode}\n`;
  if (list.heuristic) out += `\theuristic = ${list.heuristic}\n`;
  for (const bundle of list.bundles()) {
    out += `[bundle "${bundle.id}"]\n`;
    out += bundle.uri !== undefined ? `\turi = ${bundle.uri}\n` : "\t# uri = (missing)\n";
    if (bundle.creationToken !== 0n) out += `\tcreationToken = ${bundle.creationToken}\n`;
  }
  return out;
}
