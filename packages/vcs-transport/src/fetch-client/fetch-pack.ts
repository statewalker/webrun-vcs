/**
 * The negotiation and pack transfer of a fetch (git's fetch-pack.c), over any
 * {@link UploadPackConnection}: protocol v0 (stateful or stateless) and v2.
 */

import type { ObjectFormat } from "@statewalker/vcs-utils/hash";
import type { PackImportResult } from "../api/repository-facade.js";
import { ObjectFormatMismatchError } from "../protocol/errors.js";
import {
  encodeDelim,
  encodeFlush,
  encodePacketLine,
  ServerError,
  TransportError,
} from "../protocol/index.js";
import { formatOf, mismatchedAlgorithms } from "../protocol/object-format.js";
import type { UploadPackConnection } from "./connection.js";
import {
  createNegotiator,
  type FetchNegotiator,
  type NegotiationAlgorithm,
  type NegotiatorSource,
} from "./negotiator.js";
import { type PktStream, readSidebandPack } from "./pkt-stream.js";

/** git's first batch of haves */
export const INITIAL_FLUSH = 16;
/** Stateful v0: past this many haves, batches grow by this much instead of doubling */
export const PIPESAFE_FLUSH = 32;
/** Stateless: past this many haves, batches grow by 10% instead of doubling */
export const LARGE_FLUSH = 16384;
/**
 * Haves sent in vain, after the first ACK, before giving up: v0 counts from the last newly
 * common commit, v2 (as git's do_fetch_pack_v2) from the last ACK of any kind
 */
export const MAX_IN_VAIN = 256;

/** The agent the client names itself as */
export const CLIENT_AGENT = "statewalker-vcs/1.0";

/** git's next_flush: where the next batch of haves ends. */
export function nextFlush(stateless: boolean, count: number): number {
  if (stateless) return count < LARGE_FLUSH ? count * 2 : Math.floor((count * 11) / 10);
  return count < PIPESAFE_FLUSH ? count * 2 : count + PIPESAFE_FLUSH;
}

/** One want of a v2 request with `ref-in-want`: a ref by name, or an id (no name). */
export interface WantEntry {
  /** The ref asked for by name (`want-ref <name>`); undefined: `want <oid>` */
  name?: string;
  /** The id the ref was listed at, or the id wanted */
  oid: string;
}

/** What to fetch, and what the client has. */
export interface FetchPackRequest {
  /** Object ids to fetch (ref tips) */
  wants: string[];
  /** Local ref tips: the negotiator walks the local history from them */
  localTips: Iterable<string>;
  /** Remote ref tips already here: offered once, their ancestors never */
  knownCommon?: Iterable<string>;
  /** `fetch.negotiationAlgorithm` (default `consecutive`) */
  negotiationAlgorithm?: NegotiationAlgorithm;
  /** The commits git has parsed before negotiating (the skipping negotiator's dates) */
  parsedCommits?: Iterable<string>;
  /** The client's shallow commits (its shallow file) */
  shallow?: Iterable<string>;
  /** `deepen <depth>`: at most `depth` commits from the wants */
  depth?: number;
  /** `deepen-relative`: `depth` counts from the current shallow boundary */
  deepenRelative?: boolean;
  /** `deepen-since`: commits newer than this time (seconds since the epoch) */
  deepenSince?: number;
  /** `deepen-not`: commits not reachable from these remote refs */
  deepenNot?: string[];
  /**
   * Partial clone filter (`blob:none`): sent when the server takes filters
   * ({@link serverSupportsFilter}), else dropped with {@link FILTER_NOT_RECOGNIZED} passed
   * to `onWarning`
   */
  filter?: string;
  /** Warnings fetch-pack prints (`warning: ...`) */
  onWarning?: (line: string) => void;
  /** Ask the server for the annotated tags of the objects it sends (`include-tag`) */
  includeTag?: boolean;
  /** Progress messages (side-band channel 2); without it the client asks for `no-progress` */
  onProgress?: (message: string) => void;
  /**
   * The local repository's object format (SHA-1 when absent): a server speaking another one
   * is refused before anything is asked (git's "mismatched algorithms" in v2, "Server does
   * not support this repository's object format" in v0)
   */
  objectFormat?: ObjectFormat;
  /**
   * Protocol v2 `server-option=<option>` lines sent with each `fetch` command (git's
   * `--server-option`, `remote.<name>.serverOption`); a server that does not advertise
   * `server-option` is refused as git's `ensure_server_supports_v2` refuses it
   */
  serverOptions?: readonly string[];
  /**
   * The client's session id, sent as `session-id=<id>` to a server advertising one (git's
   * `transfer.advertiseSID` on the client); undefined: none sent
   */
  sessionId?: string;
  /**
   * The request's wants in git's add_wants order, for a server that takes them by name (v2
   * `fetch=... ref-in-want`): an entry with a name is `want-ref <name>`, one without is
   * `want <oid>`, both kinds interleaved as listed; a {@link wants} id no entry names goes
   * after them as `want <id>`. The ids the server answers for the names come back as
   * {@link FetchPackResult.wantedRefs}. Ignored by a server without `ref-in-want`
   */
  wantRefs?: ReadonlyArray<WantEntry>;
  /**
   * The protocols the client takes packfile URIs over (git's `fetch.uriProtocols`): sent as
   * `packfile-uris <list>` to a server advertising `fetch=... packfile-uris`, keeping only
   * `http` and `https` (fetch-pack's send_fetch_request). The URIs the server answers come
   * back as {@link FetchPackResult.packfileUris}: the caller downloads them
   */
  uriProtocols?: readonly string[];
  /** Stores the pack as it arrives (never buffered whole) */
  importPack(pack: AsyncIterable<Uint8Array>, info?: PackInfo): Promise<PackImportResult>;
  /**
   * Called with the server's shallow update before the pack is imported (it may refuse it by
   * throwing: a repository that cannot record shallow commits).
   */
  onShallowUpdate?(update: ServerShallowUpdate): Promise<void> | void;
}

/** What {@link FetchPackRequest.importPack} is told about the pack it stores. */
export interface PackInfo {
  /**
   * The server named packfile URIs: the objects are split across packs, so this one is
   * indexed and kept whatever its size (fetch-pack's get_pack with `index_pack_args`)
   */
  packfileUris?: boolean;
}

/** The server's `shallow`/`unshallow` lines. */
export interface ServerShallowUpdate {
  shallow: string[];
  unshallow: string[];
}

/** Counters of a negotiation. */
export interface NegotiationStats {
  /** Requests sent (negotiation rounds, the last one included) */
  rounds: number;
  /** `have` lines sent for the first time (re-sent common commits not counted) */
  haves: number;
}

export interface FetchPackResult {
  /** The server's shallow update (empty unless the fetch deepened or the client is shallow) */
  shallowUpdate: ServerShallowUpdate;
  /** What importing the pack reported */
  imported: PackImportResult;
  /** Objects in the pack as sent (its header), before a thin pack is completed */
  packObjects: number;
  /** Bytes of the pack */
  packBytes: number;
  stats: NegotiationStats;
  /**
   * The server's `wanted-refs` section (v2 with `want-ref`): each ref asked for by name and the
   * id the server sent for it, which may differ from the one listed before (it moved)
   */
  wantedRefs?: Map<string, string>;
  /**
   * The server's `packfile-uris` section (v2): packs the server left out of its answer, each
   * to be downloaded from `uri` and checked to be the pack named `hash` (its trailer)
   */
  packfileUris?: PackfileUri[];
}

/** A `<hash> <uri>` line of a v2 `packfile-uris` section. */
export interface PackfileUri {
  /** The checksum the pack's trailer must hold (hex) */
  hash: string;
  uri: string;
}

/**
 * Negotiates with upload-pack and imports the pack it sends, as git's fetch-pack.
 *
 * The negotiator ({@link Negotiator}) offers local commits newest first, in batches of 16,
 * then growing (doubling, or by 32 on a stateful v0 connection). Each acknowledged commit
 * makes its ancestry common. The client says `done` when it has nothing more to offer, when
 * the server is ready, or after {@link MAX_IN_VAIN} haves without a new common commit once
 * one was found. Over a stateless connection every request repeats the wants and the common
 * commits found so far, since the server remembers nothing.
 */
export async function fetchPack(
  connection: UploadPackConnection,
  source: NegotiatorSource,
  request: FetchPackRequest,
): Promise<FetchPackResult> {
  if (request.wants.length === 0) throw new Error("fetchPack: nothing to fetch");
  checkObjectFormat(connection, formatOf(request));
  if (request.filter && !serverSupportsFilter(connection)) {
    request.onWarning?.(FILTER_NOT_RECOGNIZED);
    request = { ...request, filter: undefined };
  }
  const shallow = [...(request.shallow ?? [])];
  const negotiator = createNegotiator(request.negotiationAlgorithm, source, {
    shallow,
    ...(request.parsedCommits ? { parsed: request.parsedCommits } : {}),
  });
  for (const oid of request.knownCommon ?? []) await negotiator.knownCommon(oid);
  for (const oid of request.localTips) await negotiator.addTip(oid);
  const deepen =
    request.depth !== undefined ||
    request.deepenSince !== undefined ||
    (request.deepenNot?.length ?? 0) > 0;
  checkShallowSupport(connection, request, shallow.length > 0, deepen);
  return connection.version === 2
    ? fetchPackV2(connection, negotiator, request, shallow)
    : fetchPackV0(connection, negotiator, request, shallow, deepen);
}

/**
 * The server's object format against the local repository's, as git checks it before it
 * asks for anything: v2's write_command_and_capabilities (`mismatched algorithms: client
 * <ours>; server <theirs>`, or `the server does not support algorithm '<ours>'` from a v2
 * server naming none), v0's do_fetch_pack (`Server does not support this repository's object
 * format`: a server naming none speaks SHA-1).
 */
export function checkObjectFormat(connection: UploadPackConnection, local: ObjectFormat): void {
  const named = connection.capabilities.get("object-format");
  if (connection.version === 2) {
    if (named !== undefined) {
      if (named !== local.name)
        throw new ObjectFormatMismatchError(mismatchedAlgorithms(local, named));
    } else if (local.name !== "sha1") {
      throw new ObjectFormatMismatchError(`the server does not support algorithm '${local.name}'`);
    }
    return;
  }
  if ((named ?? "sha1") !== local.name) {
    throw new ObjectFormatMismatchError("Server does not support this repository's object format");
  }
}

function fetchFeatures(connection: UploadPackConnection): Set<string> {
  return new Set((connection.capabilities.get("fetch") ?? "").split(" ").filter(Boolean));
}

function checkShallowSupport(
  connection: UploadPackConnection,
  request: FetchPackRequest,
  clientShallow: boolean,
  deepen: boolean,
): void {
  const caps = connection.capabilities;
  if (connection.version === 2) {
    const features = fetchFeatures(connection);
    if ((clientShallow || deepen) && !features.has("shallow")) {
      throw new TransportError("The server does not support shallow clients or fetches");
    }
    return;
  }
  if ((clientShallow || deepen) && !caps.has("shallow")) {
    throw new TransportError("The server does not support shallow clients or fetches");
  }
  if (request.deepenSince !== undefined && !caps.has("deepen-since")) {
    throw new TransportError("The server does not support deepen-since");
  }
  if (request.deepenNot?.length && !caps.has("deepen-not")) {
    throw new TransportError("The server does not support deepen-not");
  }
  if (request.deepenRelative && !caps.has("deepen-relative")) {
    throw new TransportError("The server does not support deepen-relative");
  }
}

/**
 * Whether the server takes a `filter` (v0's `filter` capability, v2's `fetch=... filter`):
 * without it fetch-pack sends none, warning "filtering not recognized by server, ignoring".
 */
export function serverSupportsFilter(connection: UploadPackConnection): boolean {
  return connection.version === 2
    ? fetchFeatures(connection).has("filter")
    : connection.capabilities.has("filter");
}

/** The warning fetch-pack prints for a filter the server does not take (send_filter). */
export const FILTER_NOT_RECOGNIZED = "warning: filtering not recognized by server, ignoring";

/** The shallow and deepen lines both protocols share. */
function shallowLines(request: FetchPackRequest, shallow: string[]): string[] {
  const lines = shallow.map((oid) => `shallow ${oid}`);
  if (request.depth !== undefined) lines.push(`deepen ${request.depth}`);
  if (request.depth !== undefined && request.deepenRelative) lines.push("deepen-relative");
  if (request.deepenSince !== undefined) lines.push(`deepen-since ${request.deepenSince}`);
  for (const ref of request.deepenNot ?? []) lines.push(`deepen-not ${ref}`);
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Protocol v0 (find_common)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPackV0(
  connection: UploadPackConnection,
  negotiator: FetchNegotiator,
  request: FetchPackRequest,
  shallow: string[],
  deepen: boolean,
): Promise<FetchPackResult> {
  const caps = connection.capabilities;
  const stateless = connection.stateless;
  const multiAck = caps.has("multi_ack_detailed") ? 2 : caps.has("multi_ack") ? 1 : 0;
  const sideband = caps.has("side-band-64k")
    ? "side-band-64k"
    : caps.has("side-band")
      ? "side-band"
      : "";
  if (!sideband) throw new TransportError("The server does not support side-band");

  const wanted: string[] = [];
  if (multiAck === 2) wanted.push("multi_ack_detailed");
  else if (multiAck === 1) wanted.push("multi_ack");
  wanted.push(sideband);
  for (const cap of ["thin-pack", "ofs-delta"]) if (caps.has(cap)) wanted.push(cap);
  if (!request.onProgress && caps.has("no-progress")) wanted.push("no-progress");
  if (request.includeTag && caps.has("include-tag")) wanted.push("include-tag");
  if (shallow.length > 0 || deepen) wanted.push("shallow");
  if (request.deepenRelative) wanted.push("deepen-relative");
  // the filter capability asked for with the request's filter (find_common)
  if (request.filter) wanted.push("filter");
  if (caps.has("agent")) wanted.push(`agent=${CLIENT_AGENT}`);
  // transfer.advertiseSID: only to a server that advertises its own (find_common)
  if (request.sessionId !== undefined && caps.has("session-id")) {
    wanted.push(`session-id=${request.sessionId}`);
  }

  // the request's "state": wants (capabilities on the first), shallow and deepen lines, filter
  const state: Uint8Array[] = [];
  request.wants.forEach((oid, i) => {
    state.push(encodePacketLine(i === 0 ? `want ${oid} ${wanted.join(" ")}` : `want ${oid}`));
  });
  for (const line of shallowLines(request, shallow)) state.push(encodePacketLine(line));
  if (request.filter) state.push(encodePacketLine(`filter ${request.filter}`));
  state.push(encodeFlush());

  const stats: NegotiationStats = { rounds: 0, haves: 0 };
  // stateless: the commons found so far, replayed in every request after the state
  const replay: Uint8Array[] = [];
  let pending: Uint8Array[] = [];
  let stateSent = false;
  let shallowUpdate: ServerShallowUpdate = { shallow: [], unshallow: [] };
  let shallowListPending = deepen;
  const send = async (tail: Uint8Array[]): Promise<PktStream> => {
    const body = stateless || !stateSent ? [...state, ...replay, ...tail] : tail;
    stateSent = true;
    stats.rounds++;
    return connection.request(body);
  };
  /** git's consume_shallow_list / the first shallow list of a stateful exchange */
  const readShallowList = async (pkts: PktStream): Promise<void> => {
    if (!shallowListPending) return;
    if (!stateless) shallowListPending = false;
    const update: ServerShallowUpdate = { shallow: [], unshallow: [] };
    for (let line = await pkts.readLine(); line !== undefined; line = await pkts.readLine()) {
      if (line.startsWith("shallow ")) update.shallow.push(line.slice(8));
      else if (line.startsWith("unshallow ")) update.unshallow.push(line.slice(10));
      else throw new TransportError(`Expected shallow/unshallow, got ${line}`);
    }
    shallowUpdate = update;
  };

  let flushAt = INITIAL_FLUSH;
  let count = 0;
  let inVain = 0;
  let gotContinue = false;
  let gotReady = false;
  let plainAck = false;
  /** git's retval: whether any commit was acknowledged */
  let found = false;
  /** Batches whose answers are not read yet (git's flushes) */
  let flushes = 0;
  let pkts: PktStream | undefined;
  while (!plainAck) {
    const have = await negotiator.next();
    if (!have) break;
    pending.push(encodePacketLine(`have ${have}`));
    stats.haves++;
    inVain++;
    count++;
    if (count < flushAt) continue;
    pkts = await send([...pending, encodeFlush()]);
    pending = [];
    flushes++;
    flushAt = nextFlush(stateless, count);
    // a stateful exchange keeps one batch ahead: the first batch's answer is read once the
    // second is sent (find_common's "give another chance")
    if (!stateless && count === INITIAL_FLUSH) continue;
    await readShallowList(pkts);
    // the acknowledgments of one batch, up to the NAK that ends them
    while (true) {
      const line = await pkts.readLine();
      if (line === undefined) throw new TransportError("Expected ACK/NAK, got a flush");
      if (line === "NAK") break;
      const ack = parseAck(line);
      if (!ack) throw new TransportError(`Expected ACK/NAK, got ${line}`);
      found = true;
      if (!ack.status) {
        // plain ACK (no multi_ack): the server found a common commit and stops negotiating
        await negotiator.ack(ack.oid);
        plainAck = true;
        flushes = 0;
        break;
      }
      const wasCommon = await negotiator.ack(ack.oid);
      if (stateless && ack.status === "common" && !wasCommon) {
        // replay this have in the next requests, so the server knows it is common
        replay.push(encodePacketLine(`have ${ack.oid}`));
        inVain = 0;
      } else if (!stateless || ack.status !== "common") {
        inVain = 0;
      }
      gotContinue = true;
      if (ack.status === "ready") gotReady = true;
    }
    if (plainAck) break;
    flushes--;
    if (gotContinue && inVain > MAX_IN_VAIN) break;
    if (gotReady) break;
  }

  // done: the haves not sent yet go with it
  pkts = await send([...pending, encodePacketLine("done")]);
  await readShallowList(pkts);
  // the answers left: those of the batches not read yet and of "done", up to the final ACK
  // (multi_ack) or NAK before the pack (after a plain ACK, without multi_ack, the server
  // sends none: the pack follows "done")
  let multiAcking = !plainAck && multiAck > 0;
  if (!found) {
    multiAcking = false;
    flushes++;
  }
  while (flushes > 0 || multiAcking) {
    const p = await pkts.read();
    if (!p) throw new TransportError("The response ends before the pack");
    if (p.type === "flush") continue; // between acknowledgments
    if (p.type !== "data") throw new TransportError(`Unexpected ${p.type} packet`);
    const line = p.text;
    if (line.startsWith("ERR ")) throw new ServerError(line.slice(4));
    if (line === "NAK") {
      flushes--;
      continue;
    }
    const ack = parseAck(line);
    if (!ack) throw new TransportError(`Expected ACK/NAK, got ${line}`);
    if (!ack.status) break;
    multiAcking = true;
  }
  await request.onShallowUpdate?.(shallowUpdate);
  return receivePack(pkts, request, shallowUpdate, stats);
}

function parseAck(line: string): { oid: string; status?: string } | undefined {
  if (!line.startsWith("ACK ")) return undefined;
  // `ACK <oid>[ <status>]`, the id of the format the server speaks
  const rest = line.slice(4);
  const space = rest.indexOf(" ");
  const oid = space < 0 ? rest : rest.slice(0, space);
  const status = space < 0 ? undefined : rest.slice(space + 1) || undefined;
  return { oid, status };
}

// ─────────────────────────────────────────────────────────────────────────────
// Protocol v2 (do_fetch_pack_v2)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPackV2(
  connection: UploadPackConnection,
  negotiator: FetchNegotiator,
  request: FetchPackRequest,
  shallow: string[],
): Promise<FetchPackResult> {
  const head = fetchCommandHead(connection, request);
  head.push(encodePacketLine("thin-pack"));
  if (!request.onProgress) head.push(encodePacketLine("no-progress"));
  if (request.includeTag) head.push(encodePacketLine("include-tag"));
  head.push(encodePacketLine("ofs-delta"));
  // git's do_fetch_pack_v2: every packet of the answer on side band 1 when the server takes it
  // (uploadpack.allowSidebandAll), its progress on band 2 and its errors on band 3
  const sidebandAll = fetchFeatures(connection).has("sideband-all");
  if (sidebandAll) head.push(encodePacketLine("sideband-all"));
  for (const line of shallowLines(request, shallow)) head.push(encodePacketLine(line));
  if (request.filter) head.push(encodePacketLine(`filter ${request.filter}`));
  // fetch.uriProtocols: only http and https are asked for
  if (fetchFeatures(connection).has("packfile-uris")) {
    const protocols = (request.uriProtocols ?? []).filter((p) => p === "http" || p === "https");
    if (protocols.length > 0) head.push(encodePacketLine(`packfile-uris ${protocols.join(",")}`));
  }
  // add_wants: one line per sought entry in its order, `want-ref <name>` for a ref asked for
  // by name when the server takes them, `want <id>` otherwise
  const ordered = fetchFeatures(connection).has("ref-in-want") ? (request.wantRefs ?? []) : [];
  const covered = new Set<string>();
  // the names asked for (the wanted-refs answer may name only those)
  const asked = new Set<string>();
  const written = new Set<string>();
  for (const { name, oid } of ordered) {
    const line = name !== undefined ? `want-ref ${name}` : `want ${oid}`;
    covered.add(oid);
    if (name !== undefined) asked.add(name);
    if (written.has(line)) continue;
    written.add(line);
    head.push(encodePacketLine(line));
  }
  for (const oid of request.wants) {
    if (!covered.has(oid)) head.push(encodePacketLine(`want ${oid}`));
  }
  let wantedRefs: Map<string, string> | undefined;
  let packfileUris: PackfileUri[] | undefined;

  const stats: NegotiationStats = { rounds: 0, haves: 0 };
  const commons: string[] = [];
  let havesToSend = INITIAL_FLUSH;
  let inVain = 0;
  let seenAck = false;
  while (true) {
    const batch: string[] = [];
    while (batch.length < havesToSend) {
      const have = await negotiator.next();
      if (!have) break;
      batch.push(have);
    }
    havesToSend = nextFlush(true, havesToSend);
    inVain += batch.length;
    stats.haves += batch.length;
    const done = batch.length === 0 || (seenAck && inVain >= MAX_IN_VAIN);
    const body = [
      ...head,
      // every round repeats the commits found common so far: the server keeps no state
      ...commons.map((oid) => encodePacketLine(`have ${oid}`)),
      ...batch.map((oid) => encodePacketLine(`have ${oid}`)),
      ...(done ? [encodePacketLine("done")] : []),
      encodeFlush(),
    ];
    stats.rounds++;
    const pkts = await connection.request(body);
    const onProgress = request.onProgress;
    if (sidebandAll) pkts.demultiplex({ onProgress: onProgress && ((m) => onProgress(m.trim())) });
    let section = await pkts.readLine();
    if (section === undefined) throw new TransportError("Empty fetch response");
    if (section === "acknowledgments") {
      if (done) throw new TransportError("Acknowledgments after done");
      let ready = false;
      let end: "flush" | "delim" | undefined;
      while (!end) {
        const p = await pkts.read();
        if (!p) throw new TransportError("The fetch response ends early");
        if (p.type === "flush" || p.type === "delim") {
          end = p.type;
          break;
        }
        if (p.type !== "data") throw new TransportError(`Unexpected ${p.type} packet`);
        const line = p.text;
        if (line.startsWith("ERR ")) throw new ServerError(line.slice(4));
        if (line === "NAK") continue;
        if (line === "ready") {
          ready = true;
          continue;
        }
        if (!line.startsWith("ACK ")) throw new TransportError(`Unexpected ${line}`);
        const rest = line.slice(4);
        const oid = rest.includes(" ") ? rest.slice(0, rest.indexOf(" ")) : rest;
        if (!(await negotiator.ack(oid))) commons.push(oid);
        // git's do_fetch_pack_v2: any ACK (a re-sent common one too) resets the count
        seenAck = true;
        inVain = 0;
      }
      if (end === "flush") {
        if (ready) throw new TransportError("The server is ready but sent no pack");
        continue; // another round
      }
      if (!ready) throw new TransportError("Sections after acknowledgments without ready");
      section = await pkts.readLine();
      if (section === undefined) throw new TransportError("The fetch response ends early");
    }
    // the pack's sections: shallow-info, wanted-refs, packfile-uris, packfile
    const shallowUpdate: ServerShallowUpdate = { shallow: [], unshallow: [] };
    while (section !== "packfile") {
      if (section === undefined) throw new TransportError("The fetch response has no packfile");
      const lines: string[] = [];
      while (true) {
        const p = await pkts.read();
        if (!p) throw new TransportError("The fetch response ends early");
        if (p.type === "delim") break;
        if (p.type !== "data") throw new TransportError(`Unexpected ${p.type} in ${section}`);
        lines.push(p.text);
      }
      if (section === "shallow-info") {
        for (const line of lines) {
          if (line.startsWith("shallow ")) shallowUpdate.shallow.push(line.slice(8));
          else if (line.startsWith("unshallow ")) shallowUpdate.unshallow.push(line.slice(10));
          else throw new TransportError(`Unexpected ${line} in shallow-info`);
        }
      } else if (section === "wanted-refs") {
        // receive_wanted_refs: `<id> <name>` of a ref asked for
        wantedRefs = new Map();
        for (const line of lines) {
          const space = line.indexOf(" ");
          const name = space < 0 ? "" : line.slice(space + 1);
          if (space < 0 || !asked.has(name)) {
            throw new TransportError(
              space < 0 ? `expected wanted-ref, got '${line}'` : `unexpected wanted-ref: '${line}'`,
            );
          }
          wantedRefs.set(name, line.slice(0, space));
        }
      } else if (section === "packfile-uris") {
        // receive_packfile_uris: `<hash> <uri>`
        const hexLength = formatOf(request).hexLength;
        packfileUris = [];
        for (const line of lines) {
          if (line.length < hexLength || line[hexLength] !== " ") {
            throw new TransportError(`fatal: expected '<hash> <uri>', got: ${line}`);
          }
          packfileUris.push({ hash: line.slice(0, hexLength), uri: line.slice(hexLength + 1) });
        }
      } else {
        throw new TransportError(`Unexpected section ${section}`);
      }
      section = await pkts.readLine();
    }
    // the packfile section's packets are side-band packets of their own (get_pack's demuxer)
    pkts.demultiplex(false);
    await request.onShallowUpdate?.(shallowUpdate);
    const received = await receivePack(pkts, request, shallowUpdate, stats, {
      ...(packfileUris?.length ? { packfileUris: true } : {}),
    });
    return {
      ...received,
      ...(wantedRefs ? { wantedRefs } : {}),
      ...(packfileUris?.length ? { packfileUris } : {}),
    };
  }
}

/**
 * write_fetch_command_and_capabilities: `command=fetch`, the agent, the session id, the server
 * options, the client's object format (once checked against the server's), the delimiter.
 */
function fetchCommandHead(
  connection: UploadPackConnection,
  request: Pick<FetchPackRequest, "sessionId" | "serverOptions" | "objectFormat">,
): Uint8Array[] {
  const caps = connection.capabilities;
  const head: Uint8Array[] = [encodePacketLine("command=fetch")];
  if (caps.has("agent")) head.push(encodePacketLine(`agent=${CLIENT_AGENT}`));
  // transfer.advertiseSID (write_fetch_command_and_capabilities)
  if (request.sessionId !== undefined && caps.has("session-id")) {
    head.push(encodePacketLine(`session-id=${request.sessionId}`));
  }
  for (const line of serverOptionLines(connection, request.serverOptions)) head.push(line);
  if (caps.has("object-format")) {
    head.push(encodePacketLine(`object-format=${formatOf(request).name}`));
  }
  head.push(encodeDelim());
  return head;
}

// ─────────────────────────────────────────────────────────────────────────────
// --negotiate-only (negotiate_using_fetch)
// ─────────────────────────────────────────────────────────────────────────────

/** What `git fetch --negotiate-only` negotiates. */
export interface NegotiateOnlyRequest {
  /** The `--negotiation-tip` commits: the only tips the negotiator walks from */
  tips: readonly string[];
  /** `fetch.negotiationAlgorithm` (default `consecutive`) */
  negotiationAlgorithm?: NegotiationAlgorithm;
  /** The local shallow commits */
  shallow?: Iterable<string>;
  /** The commits git has parsed before negotiating (the skipping negotiator's dates) */
  parsedCommits?: Iterable<string>;
  objectFormat?: ObjectFormat;
  serverOptions?: readonly string[];
  sessionId?: string;
}

/**
 * Why `--negotiate-only` gave up before negotiating: transport.c's warnings
 * (`--negotiate-only requires protocol v2`, `server does not support wait-for-done`), after
 * which git exits 1.
 */
export class NegotiateOnlyUnsupportedError extends TransportError {
  constructor(readonly warning: string) {
    super(`warning: ${warning}`);
    this.name = "NegotiateOnlyUnsupportedError";
  }
}

/**
 * `git fetch --negotiate-only` (fetch-pack.c negotiate_using_fetch): protocol v2 `fetch`
 * requests with `wait-for-done` and no wants, the negotiator walking from the given tips
 * only, until every tip reaches a commit known to be common, nothing is left to offer, or
 * {@link MAX_IN_VAIN} haves went unacknowledged after an ACK. Returns the acknowledged
 * commits (git prints them in its object set's hash order: sort to compare).
 */
export async function negotiateUsingFetch(
  connection: UploadPackConnection,
  source: NegotiatorSource,
  request: NegotiateOnlyRequest,
): Promise<string[]> {
  if (connection.version !== 2) {
    throw new NegotiateOnlyUnsupportedError("--negotiate-only requires protocol v2");
  }
  if (!fetchFeatures(connection).has("wait-for-done")) {
    throw new NegotiateOnlyUnsupportedError("server does not support wait-for-done");
  }
  checkObjectFormat(connection, formatOf(request));
  const negotiator = createNegotiator(request.negotiationAlgorithm, source, {
    shallow: [...(request.shallow ?? [])],
    ...(request.parsedCommits ? { parsed: request.parsedCommits } : {}),
  });
  for (const tip of request.tips) await negotiator.addTip(tip);
  const head = fetchCommandHead(connection, request);
  const acked = new Set<string>();
  let havesToSend = INITIAL_FLUSH;
  let inVain = 0;
  let seenAck = false;
  let last = false;
  while (!last) {
    const batch: string[] = [];
    while (true) {
      const have = await negotiator.next();
      if (!have) break;
      batch.push(have);
      if (batch.length >= havesToSend) break;
    }
    havesToSend = nextFlush(true, havesToSend);
    inVain += batch.length;
    if (batch.length === 0 || (seenAck && inVain >= MAX_IN_VAIN)) last = true;
    const pkts = await connection.request([
      ...head,
      encodePacketLine("wait-for-done"),
      ...batch.map((oid) => encodePacketLine(`have ${oid}`)),
      encodeFlush(),
    ]);
    const section = await pkts.readLine();
    if (section !== "acknowledgments") {
      throw new TransportError(`expected 'acknowledgments', received '${section ?? ""}'`);
    }
    let ready = false;
    while (true) {
      const p = await pkts.read();
      if (!p) throw new TransportError("The fetch response ends early");
      if (p.type === "flush" || p.type === "delim") break;
      if (p.type !== "data") throw new TransportError(`Unexpected ${p.type} packet`);
      const line = p.text;
      if (line.startsWith("ERR ")) throw new ServerError(line.slice(4));
      if (line === "NAK") continue;
      if (line === "ready") {
        ready = true;
        continue;
      }
      if (!line.startsWith("ACK ")) {
        throw new TransportError(`unexpected acknowledgment line: '${line}'`);
      }
      const rest = line.slice(4);
      const oid = rest.includes(" ") ? rest.slice(0, rest.indexOf(" ")) : rest;
      await negotiator.ack(oid);
      acked.add(oid);
      inVain = 0;
      seenAck = true;
    }
    if (ready) throw new TransportError("unexpected 'ready' from remote");
    if (
      // fetch-pack.c's own COMMON bit: set on acknowledged commits only, never on the
      // ancestors the negotiator counts as common
      await allReachCommon(source, request.tips, (oid) => acked.has(oid))
    ) {
      last = true;
    }
  }
  return [...acked];
}

/**
 * can_all_from_reach_with_flag over fetch-pack's COMMON: whether every tip (tags peeled)
 * reaches a commit the server acknowledged.
 */
async function allReachCommon(
  source: NegotiatorSource,
  tips: readonly string[],
  common: (oid: string) => boolean,
): Promise<boolean> {
  const reaches = new Map<string, boolean>();
  for (const tip of tips) {
    let id = tip;
    for (let i = 0; i < 16; i++) {
      const target = await source.peelTag?.(id);
      if (!target || target === id) break;
      id = target;
    }
    const seen = new Set<string>([id]);
    const queue = [id];
    let found = false;
    while (queue.length > 0 && !found) {
      const oid = queue.pop() as string;
      if (common(oid) || reaches.get(oid)) {
        found = true;
        break;
      }
      const info = await source.getCommitInfo(oid);
      for (const parent of info?.parents ?? []) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    if (!found) return false;
    reaches.set(id, true);
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// The pack
// ─────────────────────────────────────────────────────────────────────────────

async function receivePack(
  pkts: PktStream,
  request: FetchPackRequest,
  shallowUpdate: ServerShallowUpdate,
  stats: NegotiationStats,
  info: PackInfo = {},
): Promise<FetchPackResult> {
  const onProgress = request.onProgress;
  const counted = { bytes: 0, objects: 0 };
  const pack = countPack(
    readSidebandPack(pkts, onProgress && ((m) => onProgress(m.trim()))),
    counted,
  );
  let imported: PackImportResult | undefined;
  try {
    imported = await request.importPack(pack, info);
    for await (const _ of pack) {
      // the rest of the pack section, after what the import read
    }
    // wants were sent, so a pack must follow (an empty one when every object is here)
    if (counted.bytes === 0)
      throw new TransportError("upload-pack sent no pack for the wanted objects");
    return {
      shallowUpdate,
      imported,
      packObjects: counted.objects,
      packBytes: counted.bytes,
      stats,
    };
  } catch (error) {
    // cancel the source first: a read may still be pending (a timeout), and only cancelling
    // the body ends it; the generator is closed once it is free
    await pkts.cancel();
    pack.return(undefined).catch(() => {});
    // objects imported aside before the response failed (a sideband error after the pack): not
    // published, and not left in the repository
    await imported?.quarantine?.discard().catch(() => {});
    throw error;
  }
}

/** Passes a pack through, counting its bytes and reading the object count of its header. */
async function* countPack(
  pack: AsyncIterable<Uint8Array>,
  out: { bytes: number; objects: number },
): AsyncGenerator<Uint8Array> {
  const header: number[] = [];
  for await (const chunk of pack) {
    for (let i = 0; i < chunk.length && header.length < 12; i++) header.push(chunk[i] as number);
    if (header.length === 12 && out.bytes < 12) {
      out.objects =
        (((header[8] as number) << 24) |
          ((header[9] as number) << 16) |
          ((header[10] as number) << 8) |
          (header[11] as number)) >>>
        0;
    }
    out.bytes += chunk.length;
    yield chunk;
  }
}

/**
 * connect.c's `server-option=<option>` lines (v2 `ls-refs` and `fetch`): none without options;
 * a server that does not advertise `server-option` refused as `ensure_server_supports_v2`.
 */
export function serverOptionLines(
  connection: UploadPackConnection,
  options: readonly string[] | undefined,
): Uint8Array[] {
  if (!options?.length) return [];
  if (!connection.capabilities.has("server-option")) {
    throw new TransportError("server doesn't support 'server-option'");
  }
  return options.map((option) => encodePacketLine(`server-option=${option}`));
}
