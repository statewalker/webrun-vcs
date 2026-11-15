/**
 * Drives the package's receive-pack (serveOverDuplex, handleReceivePack) with hand-built push
 * requests, and decodes its answers: the report lines, the side-band messages and the
 * keep-alive packets.
 */

import { writePack } from "@statewalker/vcs-core";

import { type ServeOverDuplexOptions, serveOverDuplex } from "../../src/index.js";
import { encodeFlush, encodePacketLine } from "../../src/protocol/pkt-line-codec.js";
import { commitInRepo, createTransportRepo, type TransportRepo } from "../interop/helpers.js";

export const ZERO = "0".repeat(40);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** A pack of exactly `ids` (whatever they reference), read from `repo`. */
export async function packOf(repo: TransportRepo, ids: string[]): Promise<Uint8Array> {
  const objects = repo.history.objects;
  if (!objects) throw new Error("no object store");
  const chunks: Uint8Array[] = [];
  for await (const chunk of writePack(objects, ids)) chunks.push(chunk);
  return concat(chunks);
}

/** A complete pack of what `wants` reach and `haves` do not, as a client builds it. */
export async function fullPackOf(
  repo: TransportRepo,
  wants: string[],
  haves: string[] = [],
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of repo.facade.exportPack(new Set(wants), new Set(haves))) {
    chunks.push(chunk);
  }
  return concat(chunks);
}

export interface PushRequest {
  /** `old new ref` lines */
  commands: string[];
  /** Capabilities on the first command (default "report-status side-band-64k") */
  caps?: string;
  /** The pack (omitted: none) */
  pack?: Uint8Array;
  /** `shallow <oid>` lines, before the commands */
  shallow?: string[];
  /** Push options (with the `push-options` capability) */
  pushOptions?: string[];
}

/** The bytes of a push request (after the advertisement). */
export function pushRequest(request: PushRequest): Uint8Array {
  const caps = request.caps ?? "report-status side-band-64k";
  const parts: Uint8Array[] = [];
  for (const oid of request.shallow ?? []) parts.push(encodePacketLine(`shallow ${oid}\n`));
  request.commands.forEach((line, i) => {
    parts.push(encodePacketLine(i === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(encodeFlush());
  if (request.pushOptions) {
    for (const option of request.pushOptions) parts.push(encodePacketLine(`${option}\n`));
    parts.push(encodeFlush());
  }
  if (request.pack) parts.push(request.pack);
  return concat(parts);
}

/** A decoded receive-pack answer. */
export interface ReceiveAnswer {
  /** The report-status lines (without newlines; "FLUSH" not included) */
  report: string[];
  /** Side-band channel 2 text */
  messages: string;
  /** Empty channel-1 packets (git's keep-alive) */
  keepAlives: number;
  /** Raw answer bytes */
  bytes: Uint8Array;
}

interface Pkt {
  type: "data" | "flush";
  payload: Uint8Array;
}

function readPkts(bytes: Uint8Array): { pkts: Pkt[]; rest: Uint8Array } {
  const pkts: Pkt[] = [];
  let pos = 0;
  while (pos + 4 <= bytes.length) {
    const n = Number.parseInt(decoder.decode(bytes.subarray(pos, pos + 4)), 16);
    if (Number.isNaN(n)) break;
    if (n === 0) {
      pkts.push({ type: "flush", payload: new Uint8Array(0) });
      pos += 4;
      continue;
    }
    if (pos + n > bytes.length) break;
    pkts.push({ type: "data", payload: bytes.subarray(pos + 4, pos + n) });
    pos += n;
  }
  return { pkts, rest: bytes.subarray(pos) };
}

/** Decodes a receive-pack answer (no advertisement), side-band or not. */
export function decodeAnswer(bytes: Uint8Array, sideband: boolean): ReceiveAnswer {
  const answer: ReceiveAnswer = { report: [], messages: "", keepAlives: 0, bytes };
  const { pkts } = readPkts(bytes);
  if (!sideband) {
    for (const p of pkts) {
      if (p.type === "data") answer.report.push(decoder.decode(p.payload).replace(/\n$/, ""));
    }
    return answer;
  }
  const band1: Uint8Array[] = [];
  for (const p of pkts) {
    if (p.type !== "data") continue;
    const channel = p.payload[0];
    const data = p.payload.subarray(1);
    if (channel === 1) {
      if (data.length === 0) answer.keepAlives++;
      else band1.push(data);
    } else if (channel === 2 || channel === 3) {
      answer.messages += decoder.decode(data);
    }
  }
  for (const p of readPkts(concat(band1)).pkts) {
    if (p.type === "data") answer.report.push(decoder.decode(p.payload).replace(/\n$/, ""));
  }
  return answer;
}

/** Skips the advertisement (pkt-lines up to the first flush). */
function afterAdvertisement(bytes: Uint8Array): Uint8Array {
  let pos = 0;
  while (pos + 4 <= bytes.length) {
    const n = Number.parseInt(decoder.decode(bytes.subarray(pos, pos + 4)), 16);
    if (n === 0) return bytes.subarray(pos + 4);
    pos += n;
  }
  return new Uint8Array(0);
}

export interface DuplexRun extends ReceiveAnswer {
  result: Awaited<ReturnType<typeof serveOverDuplex>>;
  /** Bytes of the request the server read */
  consumed: number;
  /** When the last answer byte was written (performance.now()) */
  lastWriteAt: number;
}

/**
 * Runs `serveOverDuplex` receive-pack on `repo` with `request` as the client's bytes (sent
 * in `chunkSize` pieces; `stallAfter`: stop sending, without ending, after that many bytes).
 */
export async function runReceivePack(
  repo: TransportRepo,
  request: PushRequest | Uint8Array,
  options: Partial<ServeOverDuplexOptions> & { chunkSize?: number; stallAfter?: number } = {},
): Promise<DuplexRun> {
  const bytes = request instanceof Uint8Array ? request : pushRequest(request);
  const sideband =
    request instanceof Uint8Array
      ? true
      : (request.caps ?? "report-status side-band-64k").split(" ").includes("side-band-64k");
  const chunkSize = options.chunkSize ?? 4096;
  const written: Uint8Array[] = [];
  let consumed = 0;
  let lastWriteAt = 0;
  const result = await serveOverDuplex({
    repository: repo.facade,
    refStore: repo.refStore,
    service: "git-receive-pack",
    ...options,
    duplex: {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          if (options.stallAfter !== undefined && i >= options.stallAfter) {
            await new Promise(() => {}); // never resolves: a stalled client
          }
          const chunk = bytes.subarray(i, i + chunkSize);
          consumed += chunk.length;
          yield chunk;
        }
      },
      write(data: Uint8Array) {
        written.push(data);
        lastWriteAt = performance.now();
      },
    },
  });
  const answer = decodeAnswer(afterAdvertisement(concat(written)), sideband);
  return { ...answer, result, consumed, lastWriteAt };
}

/** A server repository: c1 ← c2 on main, HEAD → main. */
export async function serverRepo(): Promise<{ repo: TransportRepo; c1: string; c2: string }> {
  const repo = await createTransportRepo();
  const c1 = await commitInRepo(repo, "c1", { "a.txt": "one\n" });
  const c2 = await commitInRepo(repo, "c2", { "a.txt": "one\n", "b.txt": "two\n" }, [c1]);
  await repo.refStore.update("refs/heads/main", c2);
  await repo.history.refs.setSymbolic("HEAD", "refs/heads/main");
  return { repo, c1, c2 };
}

/**
 * A client repository holding the server's commits (same ids: deterministic) plus `extra`
 * new commits on top of c2; returns their ids, newest last.
 */
export async function clientWithNewCommits(
  extra: number,
): Promise<{ client: TransportRepo; c1: string; c2: string; commits: string[] }> {
  const client = await createTransportRepo();
  const c1 = await commitInRepo(client, "c1", { "a.txt": "one\n" });
  const c2 = await commitInRepo(client, "c2", { "a.txt": "one\n", "b.txt": "two\n" }, [c1]);
  const commits: string[] = [];
  let parent = c2;
  for (let i = 0; i < extra; i++) {
    parent = await commitInRepo(
      client,
      `n${i}`,
      { "a.txt": "one\n", "b.txt": "two\n", [`n${i}.txt`]: `new ${i}\n` },
      [parent],
    );
    commits.push(parent);
  }
  return { client, c1, c2, commits };
}

export function text(value: string): Uint8Array {
  return encoder.encode(value);
}
