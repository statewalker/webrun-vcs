/**
 * The dumb HTTP protocol's client: a server that answers `info/refs` with the plain file
 * `git update-server-info` writes (no `application/x-git-upload-pack-advertisement`) is read
 * as git's remote-curl reads it (`parse_info_refs`, HEAD from the `HEAD` file), and a fetch
 * walks the remote's objects as git's http-walker does (walker.c over http-walker.c): each
 * object the local repository lacks is fetched loose (`objects/xx/...`), else from the pack
 * whose index (`objects/info/packs`, `objects/pack/pack-<id>.idx`) holds it, else from an
 * alternate the remote names in `objects/info/http-alternates` or `objects/info/alternates`
 * (only under `http.followRedirects=true`, and only to http, https, ftp or ftps where
 * `protocol.<scheme>.allow` allows a transport not from the user).
 *
 * Loose objects are checked (inflated, hashed) and imported as packs of their own, a few at a
 * time; downloaded packs are imported (kept) as they come, so the walk reads their objects
 * from the repository.
 */

import { namedObjects, type PackIndex, readPackIndex } from "@statewalker/vcs-core";
import { compressBlock, decompressBlock } from "@statewalker/vcs-utils/compression";
import {
  type ObjectFormat,
  objectFormatByHexLength,
  SHA1_OBJECT_FORMAT,
} from "@statewalker/vcs-utils/hash";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import type {
  GitObjectTypeName,
  PackImportResult,
  RepositoryFacade,
} from "../api/repository-facade.js";
import type { FollowRedirects } from "../http-client/index.js";
import { TransportError } from "../protocol/index.js";
import { OBJECT_FORMAT_CAPABILITY } from "../protocol/object-format.js";
import type { RemoteRef, UploadPackConnection } from "./connection.js";
import { anonymizeUrl } from "./fetch-head.js";

/** What a dumb connection's requests are sent with. */
export interface DumbHttpOptions {
  /**
   * Sends a GET (the connection's `SmartHttpClient.get`): the connection's headers and
   * credentials only on the base's origin (dropped already when the first request's redirect
   * moved the base to another one), none to an alternate elsewhere; redirects followed only
   * under `http.followRedirects=true`, where `fetch` drops `Authorization` across origins but
   * carries other headers along (as curl does under git's setting)
   */
  get: (url: string) => Promise<Response>;
  /** `http.followRedirects` (default `initial`): only `always` lets alternates be used */
  followRedirects?: FollowRedirects;
  /**
   * Whether an alternate of the scheme may be used (git's `is_transport_allowed(<scheme>, 0)`:
   * `protocol.<scheme>.allow`, a transport not from the user); default: any of http, https,
   * ftp and ftps
   */
  alternateAllowed?: (scheme: string) => boolean;
  /** Bounds each wait for the server */
  wait: <T>(next: () => Promise<T>) => Promise<T>;
}

/** The dumb protocol's remote, as a connection carries it ({@link UploadPackConnection.dumb}). */
export interface DumbHttpRemote {
  /** The repository's URL, after the first request's redirect, without a trailing slash */
  readonly baseUrl: string;
  /** The hash `info/refs` names its refs in (SHA-1 when it names none) */
  readonly objectFormat: ObjectFormat;
  readonly options: DumbHttpOptions;
}

const TEXT = new TextDecoder();

/**
 * remote-curl's `parse_info_refs`: one `<id>\t<name>` per line (a `^{}` line peels the tag
 * before it), the hash told by the first id's length (SHA-1 for a repository with no refs).
 *
 * @throws TransportError git's `info/refs not valid` deaths
 */
export function parseInfoRefs(
  body: Uint8Array,
  baseUrl: string,
): { refs: RemoteRef[]; objectFormat: ObjectFormat } {
  const text = TEXT.decode(body);
  const shown = `${anonymizeUrl(baseUrl)}/`;
  const tab = text.indexOf("\t");
  const objectFormat = tab < 0 ? SHA1_OBJECT_FORMAT : objectFormatByHexLength(tab);
  if (!objectFormat) {
    throw new TransportError(
      `fatal: ${shown}info/refs not valid: could not determine hash algorithm; is this a git repository?`,
    );
  }
  const refs: RemoteRef[] = [];
  let start = 0;
  // only lines ended by a newline count, as the C loop reads them
  for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", start)) {
    const line = text.slice(start, nl);
    start = nl + 1;
    const mid = line.lastIndexOf("\t");
    if (mid !== objectFormat.hexLength) {
      throw new TransportError(`fatal: ${shown}info/refs not valid: is this a git repository?`);
    }
    const oid = line.slice(0, mid).toLowerCase();
    const name = line.slice(mid + 1);
    const last = refs[refs.length - 1];
    if (name.endsWith("^{}") && last && last.name === name.slice(0, -3)) last.peeled = oid;
    else refs.push({ name, oid });
  }
  return { refs, objectFormat };
}

/**
 * Whether an answer to `info/refs` that is not of the smart content type is the dumb
 * protocol's file: empty (a repository without refs), or a first line `<hex id>\t...`. A
 * smart advertisement served with another content type starts with a pkt-line length, never a
 * whole id followed by a tab, and is still read as one.
 */
export function looksLikeInfoRefs(body: Uint8Array): boolean {
  if (body.length === 0) return true;
  const head = TEXT.decode(body.subarray(0, 65));
  const tab = head.indexOf("\t");
  return (tab === 40 || tab === 64) && /^[0-9a-fA-F]+$/.test(head.slice(0, tab));
}

/** `<base>/<path>`, a slash between them (http.c's `end_url_with_slash`). */
function urlOf(base: string, path: string): string {
  return base.endsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

/** A GET of the dumb protocol, through the connection's client. */
function get(remote: DumbHttpRemote, url: string): Promise<Response> {
  return remote.options.get(url);
}

/** A GET's body, or undefined with why: missing (404, 410) or another failure. */
async function getBytes(
  remote: DumbHttpRemote,
  url: string,
): Promise<{ body?: Uint8Array; status: number; missing: boolean }> {
  let response: Response;
  try {
    response = await get(remote, url);
  } catch {
    return { status: 0, missing: false };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return {
      status: response.status,
      missing: response.status === 404 || response.status === 410,
    };
  }
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    status: response.status,
    missing: false,
  };
}

/**
 * http_fetch_ref of `HEAD`: its id, or the ref it names; undefined when it cannot be read.
 */
async function readRemoteHead(
  remote: DumbHttpRemote,
): Promise<{ oid?: string; symref?: string } | undefined> {
  const got = await getBytes(remote, urlOf(remote.baseUrl, "HEAD"));
  if (!got.body) return undefined;
  const text = TEXT.decode(got.body).replace(/\s+$/, "");
  if (text.length === remote.objectFormat.hexLength && /^[0-9a-fA-F]+$/.test(text)) {
    return { oid: text.toLowerCase() };
  }
  if (text.startsWith("ref: ")) return { symref: text.slice(5) };
  return undefined;
}

/**
 * The dumb protocol's connection (remote-curl after `discover_refs` found no smart server):
 * the refs of `info/refs`, HEAD first (with the ref it names, dropped when that ref is not
 * listed: `resolve_remote_symref`), no capabilities but the hash `info/refs` names; a fetch
 * walks it ({@link walkDumbHttp}) instead of sending requests.
 */
export async function openDumbHttpConnection(
  baseUrl: string,
  infoRefs: Uint8Array,
  options: DumbHttpOptions,
): Promise<UploadPackConnection> {
  const parsed = parseInfoRefs(infoRefs, baseUrl);
  const dumb: DumbHttpRemote = { baseUrl, objectFormat: parsed.objectFormat, options };
  const refs = parsed.refs;
  const head = await readRemoteHead(dumb);
  if (head?.oid) refs.unshift({ name: "HEAD", oid: head.oid });
  else if (head?.symref) {
    const target = refs.find((r) => r.name === head.symref);
    if (target?.oid) refs.unshift({ name: "HEAD", oid: target.oid, symref: head.symref });
  }
  const capabilities = new Map<string, string>([
    [OBJECT_FORMAT_CAPABILITY, parsed.objectFormat.name],
  ]);
  return {
    version: 0,
    stateless: true,
    capabilities,
    advertisedRefs: refs,
    advertisedShallow: [],
    dumb,
    async request() {
      throw new TransportError("the dumb HTTP protocol has no upload-pack to send requests to");
    },
    async close() {},
  };
}

/** What {@link walkDumbHttp} needs from the fetch. */
export interface DumbWalkOptions {
  repository: RepositoryFacade;
  /** The objects to fetch with everything they reach */
  wants: readonly string[];
  /** Whether a local commit is complete (reachable from a local ref: git's `COMPLETE`) */
  isComplete: (commit: string) => Promise<boolean>;
  /** git's `warning:` lines (alternates added or refused) */
  onWarning?: (line: string) => void;
}

/** What a dumb walk brought. */
export interface DumbWalkResult {
  /** Each pack imported: the remote's packs and our packs of loose objects */
  imports: PackImportResult[];
  /** Objects fetched (loose objects, and the objects of the packs downloaded) */
  objects: number;
  /** Bytes downloaded for objects and packs */
  bytes: number;
}

/** A remote objects directory: the repository's, or an alternate's. */
interface AltBase {
  base: string;
  /** The packs `objects/info/packs` lists, with their indexes; undefined until read */
  packs?: Array<{ hash: string; index: PackIndex }>;
}

const TYPE_CODES: Record<GitObjectTypeName, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
/** Loose objects kept in memory before they are imported (bytes of content) */
const PENDING_LIMIT = 16 * 1024 * 1024;

/**
 * walker.c's `walker_fetch` with http-walker.c's `fetch`: every object `wants` reaches that
 * the repository lacks is fetched; a commit complete here stops the walk, an object present
 * but not complete is scanned without fetching.
 *
 * @throws TransportError git's lines (`Unable to find <id> under <url>`, `Cannot obtain
 * needed <type> <id>`, `while processing commit <id>.`) when an object cannot be had
 */
export async function walkDumbHttp(
  remote: DumbHttpRemote,
  options: DumbWalkOptions,
): Promise<DumbWalkResult> {
  const { repository } = options;
  const format = remote.objectFormat;
  const result: DumbWalkResult = { imports: [], objects: 0, bytes: 0 };
  const alts: AltBase[] = [{ base: remote.baseUrl }];
  let gotAlternates = false;
  const errors: string[] = [];
  const pending = new Map<string, { type: GitObjectTypeName; content: Uint8Array }>();
  let pendingBytes = 0;

  const flush = async () => {
    if (pending.size === 0) return;
    const objects = [...pending.values()];
    const pack = await encodePack(objects, format);
    result.imports.push(await repository.importPack(chunksOf(pack)));
    pending.clear();
    pendingBytes = 0;
  };

  const has = async (id: string) => pending.has(id) || (await repository.has(id));

  const fetchAlternates = async () => {
    if (gotAlternates) return;
    gotAlternates = true;
    const base = alts[0]?.base as string;
    let httpSpecific = true;
    let got = await getBytes(remote, urlOf(base, "objects/info/http-alternates"));
    if (!got.body || got.body.length === 0) {
      httpSpecific = false;
      got = await getBytes(remote, urlOf(base, "objects/info/alternates"));
      if (!got.body && !got.missing) return;
    }
    const data = got.body ? TEXT.decode(got.body) : "";
    for (const target of alternateTargets(base, data, httpSpecific)) {
      if (!target.endsWith("objects")) {
        options.onWarning?.(
          `warning: ignoring alternate that does not end in 'objects': ${target}`,
        );
        continue;
      }
      const url = target.slice(0, -"objects".length);
      if (!alternateAllowed(remote, url, options.onWarning)) continue;
      options.onWarning?.(`warning: adding alternate object store: ${url}`);
      alts.push({ base: url });
    }
  };

  /** http-walker's fetch_object: the loose object, from the repository, then each alternate. */
  const fetchLoose = async (id: string): Promise<boolean> => {
    for (let at = 0; at < alts.length; at++) {
      const alt = alts[at] as AltBase;
      const url = urlOf(alt.base, `objects/${id.slice(0, 2)}/${id.slice(2)}`);
      const got = await getBytes(remote, url);
      if (got.missing) {
        await fetchAlternates();
        continue;
      }
      if (!got.body) {
        errors.push(
          `error: The requested URL returned error: ${got.status} (http_code = ${got.status}, sha1 = ${id})`,
        );
        return false;
      }
      const object = await decodeLoose(got.body, id, format).catch(() => undefined);
      if (!object) {
        errors.push(`error: File ${id} (${url}) corrupt`);
        return false;
      }
      if (object === "bad-hash") {
        errors.push(`error: File ${id} has bad hash`);
        return false;
      }
      pending.set(id, object);
      pendingBytes += object.content.length;
      result.objects++;
      result.bytes += got.body.length;
      return true;
    }
    return false;
  };

  /** fetch_indices: `objects/info/packs` and each pack's index; false when unreadable. */
  const fetchIndices = async (alt: AltBase): Promise<boolean> => {
    if (alt.packs) return true;
    const got = await getBytes(remote, urlOf(alt.base, "objects/info/packs"));
    if (!got.body && !got.missing) return false;
    const packs: NonNullable<AltBase["packs"]> = [];
    const pattern = new RegExp(`^P pack-([0-9a-f]{${format.hexLength}})\\.pack$`);
    for (const line of got.body ? TEXT.decode(got.body).split("\n") : []) {
      const hash = pattern.exec(line)?.[1];
      if (!hash) continue;
      const url = urlOf(alt.base, `objects/pack/pack-${hash}.idx`);
      const idx = await getBytes(remote, url);
      if (!idx.body) {
        errors.push(`error: Unable to get pack index ${url}`);
        continue;
      }
      const index = openPackIndex(idx.body, format);
      if (!index) {
        errors.push(`error: packfile pack-${hash}.pack index unusable`);
        continue;
      }
      result.bytes += idx.body.length;
      // packfile_list_prepend: the last listed is looked in first
      packs.unshift({ hash, index });
    }
    alt.packs = packs;
    return true;
  };

  /** http_fetch_pack: the pack holding `id` downloaded and imported. */
  const fetchPackOf = async (alt: AltBase, id: string): Promise<boolean> => {
    if (!(await fetchIndices(alt))) return false;
    const at = alt.packs?.findIndex((p) => p.index.has(id)) ?? -1;
    if (at < 0) return false;
    const pack = alt.packs?.[at] as { hash: string; index: PackIndex };
    const url = urlOf(alt.base, `objects/pack/pack-${pack.hash}.pack`);
    let response: Response;
    try {
      response = await get(remote, url);
    } catch (error) {
      errors.push(`error: Unable to get pack file ${url}\n${(error as Error).message}`);
      return false;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      errors.push(
        `error: Unable to get pack file ${url}\nThe requested URL returned error: ${response.status}`,
      );
      return false;
    }
    let bytes = 0;
    const counted = async function* (body: ReadableStream<Uint8Array>) {
      const reader = body.getReader();
      try {
        while (true) {
          const next = await remote.options.wait(() => reader.read());
          if (next.done) return;
          bytes += next.value.length;
          yield next.value;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    };
    try {
      result.imports.push(await repository.importPack(counted(response.body), { keepPack: true }));
    } catch (error) {
      errors.push(`error: ${(error as Error).message}`);
      return false;
    }
    // http_install_packfile: its objects are ours now
    alt.packs?.splice(at, 1);
    result.objects += pack.index.objectCount;
    result.bytes += bytes;
    return true;
  };

  /** http-walker's fetch: loose, then each objects directory's packs. */
  const fetchObject = async (id: string): Promise<boolean> => {
    if (await fetchLoose(id)) return true;
    for (let at = 0; at < alts.length; at++) {
      if (await fetchPackOf(alts[at] as AltBase, id)) return true;
      await fetchAlternates();
    }
    errors.push(`error: Unable to find ${id} under ${anonymizeUrl(remote.baseUrl)}`);
    return false;
  };

  const load = async (id: string) =>
    pending.get(id) ??
    (await repository.loadObject?.(id).catch(() => undefined)) ??
    // the empty tree is always here (git's cached object), stored or not
    (id === format.emptyTreeId ? { type: "tree" as const, content: new Uint8Array(0) } : undefined);

  // walker.c: process() queues each object once, marked for scanning when present here
  const seen = new Set<string>();
  const queue: Array<{ id: string; scan: boolean }> = [];
  const process = async (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    queue.push({ id, scan: await has(id) });
  };
  for (const want of options.wants) await process(want);

  let currentCommit: string | undefined;
  const fail = (id: string, type?: string): never => {
    const lines = [
      ...errors,
      `Cannot obtain needed ${type ?? "object"} ${id}`,
      ...(currentCommit ? [`while processing commit ${currentCommit}.`] : []),
      "error: fetch failed.",
    ];
    throw new TransportError(lines.join("\n"));
  };

  try {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { id, scan } = next;
      // fetch_object: an object a pack brought since it was queued is not fetched again
      if (!scan && !(await has(id)) && !(await fetchObject(id))) fail(id);
      const object = await load(id);
      if (!object) fail(id);
      const { type, content } = object as { type: GitObjectTypeName; content: Uint8Array };
      if (type === "commit") {
        if (await options.isComplete(id)) continue;
        currentCommit = id;
        for (const link of namedObjects("commit", content, format.rawLength)) await process(link);
      } else if (type === "tree") {
        for (const link of treeLinks(content, format.rawLength)) await process(link);
      } else if (type === "tag") {
        for (const link of namedObjects("tag", content, format.rawLength)) await process(link);
      }
      if (pendingBytes > PENDING_LIMIT) await flush();
    }
    await flush();
  } catch (error) {
    // what came is kept, as git keeps the loose objects it wrote
    await flush().catch(() => {});
    throw error;
  }
  return result;
}

/** The ids a tree names, gitlinks left out (submodule commits are not stored here). */
function treeLinks(bytes: Uint8Array, idLength: number): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at);
    const nul = bytes.indexOf(0, at);
    if (space < 0 || nul < 0 || nul + 1 + idLength > bytes.length) break;
    const mode = TEXT.decode(bytes.subarray(at, space));
    if (mode !== "160000") out.push(bytesToHex(bytes.subarray(nul + 1, nul + 1 + idLength)));
    at = nul + 1 + idLength;
  }
  return out;
}

/**
 * process_alternates_response's parse of an alternates file: each complete line, `/...`
 * on the base's server, `../...` relative to the base (one `../` more than the path parts it
 * drops), any other `<scheme>:...` URL only from `http-alternates`.
 */
export function alternateTargets(base: string, data: string, httpSpecific: boolean): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < data.length) {
    const posn = data.indexOf("\n", i);
    if (posn < 0) break;
    let okay = false;
    let serverlen = 0;
    if (data[i] === "/") {
      const colon = base.indexOf("://");
      if (colon >= 0) {
        const slash = base.indexOf("/", colon + 3);
        serverlen = slash < 0 ? base.length : slash;
        okay = true;
      }
    } else if (data.startsWith("../", i)) {
      i += 3;
      serverlen = base.length;
      while (i + 2 < posn && data.startsWith("../", i)) {
        do {
          serverlen--;
        } while (serverlen > 0 && base[serverlen - 1] !== "/");
        i += 3;
      }
      okay = base.indexOf(":") + 3 < serverlen;
    } else if (httpSpecific) {
      const line = data.slice(i, posn);
      const colon = line.indexOf(":");
      const slash = line.indexOf("/");
      okay = colon >= 0 && slash >= 0 && colon < slash;
    }
    if (okay) out.push(base.slice(0, serverlen) + data.slice(i, posn));
    i = posn + 1;
  }
  return out;
}

/** http-walker's `is_alternate_allowed`, with git's warnings. */
function alternateAllowed(
  remote: DumbHttpRemote,
  url: string,
  onWarning?: (line: string) => void,
): boolean {
  if ((remote.options.followRedirects ?? "initial") !== "always") {
    onWarning?.(`warning: alternate disabled by http.followRedirects: ${url}`);
    return false;
  }
  const scheme = ["http", "https", "ftp", "ftps"].find((s) => url.startsWith(`${s}://`));
  if (!scheme) {
    onWarning?.(`warning: ignoring alternate with unknown protocol: ${url}`);
    return false;
  }
  if (!(remote.options.alternateAllowed?.(scheme) ?? true)) {
    onWarning?.(`warning: ignoring alternate with restricted protocol: ${url}`);
    return false;
  }
  return true;
}

/**
 * A downloaded `.idx`, checked as http.c's `parse_pack_index` and `verify_pack_index` check
 * it: a known version, fanout counts that never decrease, the size they give, the trailer's
 * checksum; undefined when it is unusable.
 */
function openPackIndex(bytes: Uint8Array, format: ObjectFormat): PackIndex | undefined {
  const raw = format.rawLength;
  if (bytes.length < 8 + 256 * 4 + 2 * raw) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const v2 = view.getUint32(0) === 0xff744f63;
  if (v2 && view.getUint32(4) !== 2) return undefined;
  const fanout = v2 ? 8 : 0;
  let previous = 0;
  for (let i = 0; i < 256; i++) {
    const count = view.getUint32(fanout + i * 4);
    if (count < previous) return undefined;
    previous = count;
  }
  const n = previous;
  const minimum = v2 ? 8 + 1024 + n * (raw + 8) + 2 * raw : 1024 + n * (raw + 4) + 2 * raw;
  if (bytes.length < minimum || (!v2 && bytes.length !== minimum)) return undefined;
  if (v2 && bytes.length > minimum + Math.max(0, n - 1) * 8) return undefined;
  const hasher = format.createHasher();
  hasher.update(bytes.subarray(0, bytes.length - raw));
  const sum = hasher.digest();
  const trailer = bytes.subarray(bytes.length - raw);
  for (let i = 0; i < raw; i++) if (sum[i] !== trailer[i]) return undefined;
  try {
    return readPackIndex(bytes, raw);
  } catch {
    return undefined;
  }
}

/**
 * A loose object's file: inflated, its header read and its id checked; `bad-hash` when the
 * content hashes to another id.
 */
async function decodeLoose(
  compressed: Uint8Array,
  id: string,
  format: ObjectFormat,
): Promise<{ type: GitObjectTypeName; content: Uint8Array } | "bad-hash" | undefined> {
  const raw = await decompressBlock(compressed);
  const nul = raw.indexOf(0);
  if (nul < 0) return undefined;
  const header = TEXT.decode(raw.subarray(0, nul));
  const space = header.indexOf(" ");
  const type = header.slice(0, space) as GitObjectTypeName;
  const size = Number(header.slice(space + 1));
  if (!(type in TYPE_CODES) || !Number.isInteger(size) || size !== raw.length - nul - 1) {
    return undefined;
  }
  const hasher = format.createHasher();
  hasher.update(raw);
  if (bytesToHex(hasher.digest()) !== id) return "bad-hash";
  return { type, content: raw.subarray(nul + 1) };
}

/** A pack of `objects`, each whole (no deltas), in the given order. */
async function encodePack(
  objects: ReadonlyArray<{ type: GitObjectTypeName; content: Uint8Array }>,
  format: ObjectFormat,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  const header = new Uint8Array(12);
  header.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2]);
  new DataView(header.buffer).setUint32(8, objects.length);
  chunks.push(header);
  for (const object of objects) {
    let size = object.content.length;
    const head: number[] = [(TYPE_CODES[object.type] << 4) | (size & 0x0f)];
    size = Math.floor(size / 16);
    while (size > 0) {
      head[head.length - 1] = (head[head.length - 1] as number) | 0x80;
      head.push(size & 0x7f);
      size = Math.floor(size / 128);
    }
    chunks.push(Uint8Array.from(head), await compressBlock(object.content));
  }
  const hasher = format.createHasher();
  for (const chunk of chunks) hasher.update(chunk);
  chunks.push(hasher.digest());
  return chunks;
}

async function* chunksOf(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* chunks;
}
