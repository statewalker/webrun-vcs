/**
 * Bundle URIs on the client (bundle-uri.c): before a clone or a fetch talks to the remote,
 * bundles are downloaded from a URI (`git clone --bundle-uri`, `fetch.bundleURI`) or from the
 * list the server advertises (`transfer.bundleURI`, the v2 `bundle-uri` command) and
 * unbundled into the repository, their refs written under `refs/bundles/`. The fetch that
 * follows then has them as local tips, so it asks only for what they lack.
 *
 * The engine is the host's: {@link BundleUriHost} downloads a URI, unbundles bytes and reads
 * and writes `fetch.bundleCreationToken`. {@link fetchBundleUri} and {@link fetchBundleList}
 * follow git's walk, its recursion limit, `all`/`any` modes and the `creationToken`
 * heuristic, and give git's warnings in order.
 */

import { parseBundleHeader } from "./bundle-format.js";
import { BundleList, parseBundleListConfig, type RemoteBundleInfo } from "./bundle-list.js";

/** What the walk needs of the repository and the network. */
export interface BundleUriHost {
  /**
   * `copy_uri_to_file`: the bytes at `uri` (an `http(s)://` URL, a `file://` URL or a path),
   * or undefined when they cannot be had (git's warning follows)
   */
  download(uri: string): Promise<Uint8Array | undefined>;
  /**
   * `unbundle_from_file`: the bundle verified (quietly) and its pack indexed, then its refs
   * written under `refs/bundles/`; false when the header, the prerequisites or the pack fail
   */
  unbundle(bytes: Uint8Array): Promise<boolean>;
  /** `fetch.bundleCreationToken` as set (undefined: unset; null: set without a value) */
  creationToken(): string | null | undefined;
  /** Stores `fetch.bundleCreationToken` in the repository's config */
  setCreationToken(value: string): Promise<void>;
  /** A line git prints on stderr (`warning: ...`, `error: ...`) */
  message(line: string): void;
  /**
   * How git names a downloaded list in its `bad config line` error (its temporary file,
   * `<objects>/bundles/tmp_uri_XXXXXX`)
   */
  tempFileName?(): string;
}

/** bundle-uri.c's `max_bundle_uri_depth`. */
const MAX_BUNDLE_URI_DEPTH = 4;

/** Whether the bytes read as a bundle (`is_bundle`: the whole header parses). */
export function isBundle(bytes: Uint8Array): boolean {
  return parseBundleHeader(bytes).ok;
}

/**
 * `fetch_bundle_uri_internal`: downloads `bundle`; a bundle is added to `global` (applied
 * later), anything else is read as a bundle list and followed. True when it worked.
 */
async function fetchBundleUriInternal(
  host: BundleUriHost,
  bundle: RemoteBundleInfo,
  depth: number,
  global: BundleList,
): Promise<boolean> {
  if (depth >= MAX_BUNDLE_URI_DEPTH) {
    host.message(`warning: exceeded bundle URI recursion limit (${MAX_BUNDLE_URI_DEPTH})`);
    return false;
  }
  if (bundle.uri === undefined) {
    host.message(`error: bundle '${bundle.id}' has no uri`);
    return false;
  }
  const bytes = await host.download(bundle.uri);
  if (bytes === undefined) {
    bundle.file = null;
    host.message(`warning: failed to download bundle from URI '${bundle.uri}'`);
    return false;
  }
  bundle.file = bytes;
  if (!isBundle(bytes)) {
    const ok = await fetchBundleListInConfigFormat(host, global, bundle, bytes, depth);
    if (!ok) {
      bundle.file = null;
      host.message(`warning: file at URI '${bundle.uri}' is not a bundle or bundle list`);
    }
    return ok;
  }
  global.add({ id: bundle.id, file: bytes, creationToken: 0n });
  return true;
}

/** `fetch_bundle_list_in_config_format`: the downloaded list followed. */
async function fetchBundleListInConfigFormat(
  host: BundleUriHost,
  global: BundleList,
  bundle: RemoteBundleInfo,
  bytes: Uint8Array,
  depth: number,
): Promise<boolean> {
  const list = new BundleList();
  const messages: string[] = [];
  const parsed = await parseBundleListConfig(
    bundle.uri ?? "",
    bytes,
    host.tempFileName?.() ?? "<bundle list>",
    list,
    messages,
  );
  for (const line of messages) host.message(line);
  if (!parsed) return false;
  // a creationToken list advertises bundles, not nested lists
  if (list.heuristic === "creationToken") {
    const ok = await fetchBundlesByToken(host, list);
    global.heuristic = "creationToken";
    return ok;
  }
  await downloadBundleList(host, list, global, depth);
  return true;
}

/** `download_bundle_list`: each bundle of `local` fetched into `global` (one in `any` mode). */
async function downloadBundleList(
  host: BundleUriHost,
  local: BundleList,
  global: BundleList,
  depth: number,
): Promise<void> {
  let count = 0;
  for (const bundle of local.bundles()) {
    if (local.mode === "any" && count > 0) continue;
    // download_bundle_to_file recurses at ctx->depth + 1 with ctx->depth = depth + 1
    if (await fetchBundleUriInternal(host, bundle, depth + 2, global)) count++;
  }
}

/**
 * `fetch_bundles_by_token`: the bundles newest first, downloaded until one unbundles, then
 * back towards the newest, applying each; `fetch.bundleCreationToken` stops the walk at what
 * an earlier fetch applied, and is set to the newest token applied when the walk completes.
 * False where git returns nonzero (the walk ran off the end of the list).
 */
async function fetchBundlesByToken(host: BundleUriHost, list: BundleList): Promise<boolean> {
  const bundles = list.bundles();
  if (bundles.length === 0) return true;
  // QSORT (glibc's merge sort: stable) by creationToken, decreasing
  bundles.sort((a, b) =>
    a.creationToken > b.creationToken ? -1 : a.creationToken < b.creationToken ? 1 : 0,
  );
  let maxToken = 0n;
  let newMaxToken = 0n;
  const stored = host.creationToken();
  if (stored !== undefined) {
    const match = stored === null ? null : /^\s*(\d+)/.exec(stored);
    maxToken = match ? BigInt(match[1] ?? "0") % (1n << 64n) : 0n;
    if ((bundles[0]?.creationToken ?? 0n) <= maxToken) return true;
  }
  let cur = 0;
  let direction = 0;
  while (cur >= 0 && cur < bundles.length) {
    const bundle = bundles[cur] as RemoteBundleInfo;
    if (bundle.creationToken <= maxToken) break;
    let skipUnbundle = false;
    if (bundle.file === undefined) {
      if (!(await fetchBundleUriInternal(host, bundle, 1, list))) {
        bundle.unbundled = true;
        direction = 1;
        skipUnbundle = true;
      } else if (!bundle.file || !isBundle(bundle.file)) {
        host.message(`warning: file downloaded from '${bundle.uri}' is not a bundle`);
        break;
      }
    }
    if (!skipUnbundle && bundle.file && !bundle.unbundled) {
      if (!(await host.unbundle(bundle.file))) {
        direction = 1;
      } else {
        direction = -1;
        bundle.unbundled = true;
        if (bundle.creationToken > newMaxToken) newMaxToken = bundle.creationToken;
      }
    }
    cur += direction;
  }
  if (cur < 0) {
    try {
      await host.setCreationToken(String(newMaxToken));
    } catch {
      host.message("warning: failed to store maximum creation token");
    }
  }
  return cur < 0;
}

/**
 * `unbundle_all_bundles`: passes over the list applying what applies, until a pass applies
 * nothing (a bundle may need another's objects first).
 */
async function unbundleAllBundles(host: BundleUriHost, list: BundleList): Promise<void> {
  for (;;) {
    let applied = false;
    for (const bundle of list.bundles()) {
      if (!bundle.file || bundle.unbundled) continue;
      if (await host.unbundle(bundle.file)) {
        bundle.unbundled = true;
        applied = true;
        break;
      }
    }
    if (!applied) return;
  }
}

/**
 * `fetch_bundle_uri`: the bundle (or bundle list) at `uri` downloaded and applied. An empty
 * URI does nothing (a configured `fetch.bundleURI` turned off). `ok` false where git returns
 * nonzero (its warnings already given); `hasHeuristic` when a list used `creationToken` (git's
 * clone then stores the URI as `fetch.bundleURI`).
 */
export async function fetchBundleUri(
  host: BundleUriHost,
  uri: string,
): Promise<{ ok: boolean; hasHeuristic: boolean }> {
  const list = new BundleList();
  if (uri === "") return { ok: true, hasHeuristic: false };
  const bundle: RemoteBundleInfo = { id: "", uri, creationToken: 0n };
  const ok = await fetchBundleUriInternal(host, bundle, 0, list);
  if (ok) await unbundleAllBundles(host, list);
  return { ok, hasHeuristic: list.heuristic !== undefined };
}

/**
 * `fetch_bundle_list`: the list a server advertised, downloaded and applied (by token under
 * the `creationToken` heuristic). False where git warns `failed to fetch advertised bundles`.
 */
export async function fetchBundleList(host: BundleUriHost, list: BundleList): Promise<boolean> {
  if (list.heuristic === "creationToken") return fetchBundlesByToken(host, list);
  const global = new BundleList();
  await downloadBundleList(host, list, global, 0);
  await unbundleAllBundles(host, global);
  return true;
}
