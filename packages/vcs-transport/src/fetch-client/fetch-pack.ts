/**
 * The negotiation and pack transfer of a fetch (git's fetch-pack.c), over any
 * {@link UploadPackConnection}: protocol v0 (stateful or stateless) and v2.
 */

import type { PackImportResult } from "../api/repository-facade.js";
import {
  encodeDelim,
  encodeFlush,
  encodePacketLine,
  ServerError,
  TransportError,
} from "../protocol/index.js";
import type { UploadPackConnection } from "./connection.js";
import { Negotiator, type NegotiatorSource } from "./negotiator.js";
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

/** What to fetch, and what the client has. */
export interface FetchPackRequest {
  /** Object ids to fetch (ref tips) */
  wants: string[];
  /** Local ref tips: the negotiator walks the local history from them */
  localTips: Iterable<string>;
  /** Remote ref tips already here: offered once, their ancestors never */
  knownCommon?: Iterable<string>;
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
  /** Partial clone filter (`blob:none`) */
  filter?: string;
  /** Ask the server for the annotated tags of the objects it sends (`include-tag`) */
  includeTag?: boolean;
  /** Progress messages (side-band channel 2); without it the client asks for `no-progress` */
  onProgress?: (message: string) => void;
  /** Stores the pack as it arrives (never buffered whole) */
  importPack(pack: AsyncIterable<Uint8Array>): Promise<PackImportResult>;
  /**
   * Called with the server's shallow update before the pack is imported (it may refuse it by
   * throwing: a repository that cannot record shallow commits).
   */
  onShallowUpdate?(update: ServerShallowUpdate): Promise<void> | void;
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
  const shallow = [...(request.shallow ?? [])];
  const negotiator = new Negotiator(source, { shallow });
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
    if (request.filter && !features.has("filter")) {
      throw new TransportError("The server does not support filters");
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
  if (request.filter && !caps.has("filter")) {
    throw new TransportError("The server does not support filters");
  }
}

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
  negotiator: Negotiator,
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
  if (caps.has("agent")) wanted.push(`agent=${CLIENT_AGENT}`);

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
  while (!plainAck) {
    const have = await negotiator.next();
    if (!have) break;
    pending.push(encodePacketLine(`have ${have}`));
    stats.haves++;
    inVain++;
    count++;
    if (count < flushAt) continue;
    const pkts = await send([...pending, encodeFlush()]);
    pending = [];
    flushAt = nextFlush(stateless, count);
    await readShallowList(pkts);
    // the acknowledgments of this batch, up to the NAK that ends them
    while (true) {
      const line = await pkts.readLine();
      if (line === undefined) throw new TransportError("Expected ACK/NAK, got a flush");
      if (line === "NAK") break;
      const ack = parseAck(line);
      if (!ack) throw new TransportError(`Expected ACK/NAK, got ${line}`);
      if (!ack.status) {
        // plain ACK (no multi_ack): the server found a common commit and stops negotiating
        await negotiator.ack(ack.oid);
        plainAck = true;
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
    if (gotContinue && inVain > MAX_IN_VAIN) break;
    if (gotReady) break;
  }

  // done: the haves not sent yet go with it
  const pkts = await send([...pending, encodePacketLine("done")]);
  await readShallowList(pkts);
  // the last acknowledgments: up to the final ACK or NAK before the pack (after a plain ACK,
  // without multi_ack, the server sends none: the pack follows "done")
  while (!plainAck) {
    const p = await pkts.read();
    if (!p) throw new TransportError("The response ends before the pack");
    if (p.type === "flush") continue; // between acknowledgments
    if (p.type !== "data") throw new TransportError(`Unexpected ${p.type} packet`);
    const line = p.text;
    if (line.startsWith("ERR ")) throw new ServerError(line.slice(4));
    if (line === "NAK") break;
    const ack = parseAck(line);
    if (!ack) throw new TransportError(`Expected ACK/NAK, got ${line}`);
    if (!ack.status) break;
  }
  await request.onShallowUpdate?.(shallowUpdate);
  return receivePack(pkts, request, shallowUpdate, stats);
}

function parseAck(line: string): { oid: string; status?: string } | undefined {
  if (!line.startsWith("ACK ")) return undefined;
  const oid = line.slice(4, 44);
  const status = line.slice(45) || undefined;
  return { oid, status };
}

// ─────────────────────────────────────────────────────────────────────────────
// Protocol v2 (do_fetch_pack_v2)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPackV2(
  connection: UploadPackConnection,
  negotiator: Negotiator,
  request: FetchPackRequest,
  shallow: string[],
): Promise<FetchPackResult> {
  const caps = connection.capabilities;
  const head: Uint8Array[] = [encodePacketLine("command=fetch")];
  if (caps.has("agent")) head.push(encodePacketLine(`agent=${CLIENT_AGENT}`));
  if (caps.get("object-format") === "sha1") head.push(encodePacketLine("object-format=sha1"));
  head.push(encodeDelim());
  head.push(encodePacketLine("thin-pack"));
  if (!request.onProgress) head.push(encodePacketLine("no-progress"));
  if (request.includeTag) head.push(encodePacketLine("include-tag"));
  head.push(encodePacketLine("ofs-delta"));
  for (const line of shallowLines(request, shallow)) head.push(encodePacketLine(line));
  if (request.filter) head.push(encodePacketLine(`filter ${request.filter}`));
  for (const oid of request.wants) head.push(encodePacketLine(`want ${oid}`));

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
        const oid = line.slice(4, 44);
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
      } else if (section !== "wanted-refs") {
        throw new TransportError(`Unexpected section ${section}`);
      }
      section = await pkts.readLine();
    }
    await request.onShallowUpdate?.(shallowUpdate);
    return receivePack(pkts, request, shallowUpdate, stats);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The pack
// ─────────────────────────────────────────────────────────────────────────────

async function receivePack(
  pkts: PktStream,
  request: FetchPackRequest,
  shallowUpdate: ServerShallowUpdate,
  stats: NegotiationStats,
): Promise<FetchPackResult> {
  const onProgress = request.onProgress;
  const counted = { bytes: 0, objects: 0 };
  const pack = countPack(
    readSidebandPack(pkts, onProgress && ((m) => onProgress(m.trim()))),
    counted,
  );
  try {
    const imported = await request.importPack(pack);
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
