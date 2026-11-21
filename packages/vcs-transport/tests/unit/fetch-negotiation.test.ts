/**
 * git's fetch negotiation (fetch-pack.c, negotiator/default.c) in the fetch client, against
 * a scripted upload-pack: batch sizes, common-commit propagation, MAX_IN_VAIN, and the
 * stateless re-sending of common commits, for protocol v2 and v0 (stateless and stateful).
 */

import { describe, expect, it } from "vitest";

import type { PackImportResult } from "../../src/api/repository-facade.js";
import {
  type FetchPackRequest,
  fetchPack,
  INITIAL_FLUSH,
  MAX_IN_VAIN,
  Negotiator,
  type NegotiatorCommit,
  type NegotiatorSource,
  nextFlush,
  PktStream,
  type UploadPackConnection,
} from "../../src/fetch-client/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A fake commit id: 40 hex digits naming the commit. */
const oid = (name: string) => Buffer.from(name).toString("hex").padEnd(40, "0").slice(0, 40);

/** A local history: chains of commits, each `parents` → `time`. */
class Graph implements NegotiatorSource {
  readonly commits = new Map<string, NegotiatorCommit>();
  readonly names = new Map<string, string>();
  add(name: string, time: number, parents: string[] = []): string {
    const id = oid(name);
    this.commits.set(id, { time, parents: parents.map(oid) });
    this.names.set(id, name);
    return id;
  }
  /** A linear chain `prefix0` ← … ← `prefix<n-1>`, times from `time`. */
  chain(prefix: string, n: number, time: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(this.add(`${prefix}${i}`, time + i, i > 0 ? [`${prefix}${i - 1}`] : []));
    }
    return ids;
  }
  async getCommitInfo(id: string) {
    return this.commits.get(id);
  }
  name(id: string) {
    return this.names.get(id) ?? id;
  }
}

describe("Negotiator (git's default negotiator)", () => {
  it("offers the commits of all tips newest first", async () => {
    const g = new Graph();
    g.chain("a", 3, 10); // a0 10, a1 11, a2 12
    g.chain("b", 3, 5); // b0 5, b1 6, b2 7
    g.add("m", 20, ["a2", "b2"]);
    const n = new Negotiator(g);
    await n.addTip(oid("m"));
    const order: string[] = [];
    for (let h = await n.next(); h; h = await n.next()) order.push(g.name(h));
    expect(order).toEqual(["m", "a2", "a1", "a0", "b2", "b1", "b0"]);
  });

  it("an acknowledged commit makes its ancestors common: they are never offered", async () => {
    const g = new Graph();
    g.chain("c", 10, 0);
    g.chain("x", 5, 100); // a newer unrelated branch
    const n = new Negotiator(g);
    await n.addTip(oid("c9"));
    await n.addTip(oid("x4"));
    const first = [await n.next(), await n.next(), await n.next()].map((h) => g.name(h ?? ""));
    expect(first).toEqual(["x4", "x3", "x2"]);
    // the server has c7 (not offered yet): c7 is common, and so is everything below it once
    // the walk reaches it (git marks the ancestors as they are popped)
    expect(await n.ack(oid("c7"))).toBe(false);
    expect(await n.ack(oid("c7"))).toBe(true);
    expect(n.isCommon(oid("c7"))).toBe(true);
    const rest: string[] = [];
    for (let h = await n.next(); h; h = await n.next()) rest.push(g.name(h));
    expect(rest).toEqual(["x1", "x0", "c9", "c8"]);
  });

  it("a known-common remote tip is offered once, its ancestors not", async () => {
    const g = new Graph();
    g.chain("c", 6, 0);
    const n = new Negotiator(g);
    await n.knownCommon(oid("c3"));
    await n.addTip(oid("c5"));
    const order: string[] = [];
    for (let h = await n.next(); h; h = await n.next()) order.push(g.name(h));
    expect(order).toEqual(["c5", "c4", "c3"]);
  });

  it("does not walk past shallow commits, and peels tags to commits", async () => {
    const g = new Graph();
    g.chain("c", 5, 0);
    const tag = oid("tag");
    const n = new Negotiator(
      {
        getCommitInfo: (id) => g.getCommitInfo(id),
        peelTag: async (id) => (id === tag ? oid("c4") : null),
      },
      { shallow: [oid("c2")] },
    );
    await n.addTip(tag);
    const order: string[] = [];
    for (let h = await n.next(); h; h = await n.next()) order.push(g.name(h));
    expect(order).toEqual(["c4", "c3", "c2"]);
  });
});

/** git's empty pack (no objects): what upload-pack sends when everything is there. */
const EMPTY_PACK = Uint8Array.from([
  ...enc.encode("PACK"),
  0,
  0,
  0,
  2,
  0,
  0,
  0,
  0,
  ...new Array(20).fill(0),
]);

function pkt(line: string): Uint8Array {
  const payload = enc.encode(line.endsWith("\n") ? line : `${line}\n`);
  const out = new Uint8Array(payload.length + 4);
  out.set(enc.encode((payload.length + 4).toString(16).padStart(4, "0")));
  out.set(payload, 4);
  return out;
}
function band(channel: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 5);
  out.set(enc.encode((data.length + 5).toString(16).padStart(4, "0")));
  out[4] = channel;
  out.set(data, 5);
  return out;
}
const FLUSH = enc.encode("0000");
const DELIM = enc.encode("0001");

/** The pkt-line texts of a request body (flush: "0000", delim: "0001"). */
function lines(body: Uint8Array[]): string[] {
  const all = Buffer.concat(body);
  const out: string[] = [];
  let at = 0;
  while (at < all.length) {
    const len = Number.parseInt(all.subarray(at, at + 4).toString(), 16);
    if (len < 4) {
      out.push(all.subarray(at, at + 4).toString());
      at += 4;
      continue;
    }
    out.push(dec.decode(all.subarray(at + 4, at + len)).replace(/\n$/, ""));
    at += len;
  }
  return out;
}

/** A byte stream fed by the fake server (one stream for a stateful connection). */
class Pipe implements AsyncIterable<Uint8Array> {
  private chunks: Uint8Array[] = [];
  private wake?: () => void;
  push(...chunks: Uint8Array[]) {
    this.chunks.push(...chunks);
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.chunks.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

interface Round {
  /** The have lines of the request, in order */
  haves: string[];
  done: boolean;
  wants: number;
}

/**
 * A scripted upload-pack that has the commits in `has` (and their ancestry, as far as the
 * test cares), acknowledges every have it has, and is never ready unless `ready` says so.
 */
function fakeServer(options: {
  version: 0 | 2;
  stateless: boolean;
  has: Set<string>;
  ready?: (round: number) => boolean;
  shallowInfo?: string[];
  /** Acknowledge each commit once only (git's upload-pack re-ACKs every common have) */
  ackOnce?: boolean;
  /** The pack section's packets (default: an empty pack on band 1, then a flush) */
  packSection?: Uint8Array[];
}): { connection: UploadPackConnection; rounds: Round[] } {
  const rounds: Round[] = [];
  const acked = new Set<string>();
  const pipe = new Pipe();
  const stateful = new PktStream(pipe);
  const caps =
    options.version === 2
      ? new Map([
          ["agent", "fake/1"],
          ["fetch", "shallow"],
        ])
      : new Map(
          [
            "multi_ack_detailed",
            "side-band-64k",
            "thin-pack",
            "ofs-delta",
            "shallow",
            "no-progress",
          ].map((c) => [c, ""]),
        );
  const pack = options.packSection ?? [band(1, EMPTY_PACK), FLUSH];
  const respond = (chunks: Uint8Array[]): PktStream => {
    if (!options.stateless) {
      pipe.push(...chunks);
      return stateful;
    }
    return new PktStream(
      (async function* () {
        yield* chunks;
      })(),
    );
  };
  const connection: UploadPackConnection = {
    version: options.version,
    stateless: options.stateless,
    capabilities: caps,
    async request(body) {
      const text = lines(body);
      const haves = text.filter((l) => l.startsWith("have ")).map((l) => l.slice(5));
      const done = text.includes("done");
      const wants = text.filter((l) => l.startsWith("want ")).length;
      rounds.push({ haves, done, wants });
      const common = haves.filter((h) => options.has.has(h) && !(options.ackOnce && acked.has(h)));
      for (const c of common) acked.add(c);
      const ready = options.ready?.(rounds.length) ?? false;
      if (options.version === 2) {
        if (done) {
          const shallow = options.shallowInfo
            ? [pkt("shallow-info"), ...options.shallowInfo.map((l) => pkt(l)), DELIM]
            : [];
          return respond([...shallow, pkt("packfile"), ...pack]);
        }
        const acks = common.length ? common.map((c) => pkt(`ACK ${c}`)) : [pkt("NAK")];
        if (ready && common.length) {
          return respond([
            pkt("acknowledgments"),
            ...acks,
            pkt("ready"),
            DELIM,
            pkt("packfile"),
            ...pack,
          ]);
        }
        return respond([pkt("acknowledgments"), ...acks, FLUSH]);
      }
      const out: Uint8Array[] = common.map((c) => pkt(`ACK ${c} common`));
      if (done) {
        out.push(common.length ? pkt(`ACK ${common.at(-1)}`) : pkt("NAK"));
        out.push(...pack);
      } else {
        out.push(pkt("NAK"));
      }
      return respond(out);
    },
    async close() {},
  };
  return { connection, rounds };
}

function request(tips: string[], extra: Partial<FetchPackRequest> = {}): FetchPackRequest {
  return {
    wants: [oid("wanted")],
    localTips: tips,
    importPack: async (pack): Promise<PackImportResult> => {
      for await (const _ of pack) {
        // read
      }
      return {
        objectsImported: 0,
        blobsWithDelta: 0,
        treesImported: 0,
        commitsImported: 0,
        tagsImported: 0,
      };
    },
    ...extra,
  };
}

describe("fetchPack negotiation against a scripted server", () => {
  it("git's flush schedule: v2 batches double; v0 stateless flushes double; v0 stateful adds 32", () => {
    expect(INITIAL_FLUSH).toBe(16);
    expect([16, 32, 64].map((n) => nextFlush(true, n))).toEqual([32, 64, 128]);
    expect(nextFlush(true, 16384)).toBe(18022);
    expect([16, 32, 64, 96].map((n) => nextFlush(false, n))).toEqual([32, 64, 96, 128]);
  });

  it("v2: batches of 16, 32, 64, …; with no common commit every have is sent, then done", async () => {
    const g = new Graph();
    const tips = [g.chain("o", 600, 0).at(-1) as string];
    const { connection, rounds } = fakeServer({ version: 2, stateless: true, has: new Set() });
    const result = await fetchPack(connection, g, request(tips));
    expect(rounds.map((r) => r.haves.length)).toEqual([16, 32, 64, 128, 256, 104, 0]);
    expect(rounds.map((r) => r.done)).toEqual([false, false, false, false, false, false, true]);
    expect(rounds.every((r) => r.wants === 1)).toBe(true);
    expect(result.stats).toEqual({ rounds: 7, haves: 600 });
  });

  it("v2: any ACK resets the in-vain count (git), so the first round of 256 haves after one ends it", async () => {
    const g = new Graph();
    const main = g.chain("m", 10, 1000);
    const other = g.chain("o", 600, 0);
    // git's upload-pack ACKs the re-sent m9 in every round, and is never ready here
    const { connection, rounds } = fakeServer({ version: 2, stateless: true, has: new Set(main) });
    const result = await fetchPack(
      connection,
      g,
      request([main[9] as string, other[599] as string]),
    );
    const fresh = rounds.map((r, i) => r.haves.filter((h) => i === 0 || h !== main[9]).length);
    // every response ACKs m9 again (in_vain back to 0); the request adding 256 haves reaches
    // MAX_IN_VAIN by itself and says done, as git's send_fetch_request decides
    expect(fresh).toEqual([16, 32, 64, 128, 256]);
    expect(rounds.map((r) => r.done)).toEqual([false, false, false, false, true]);
    expect(result.stats.haves).toBe(496);
  });

  it("v2: after the last ACK, done once MAX_IN_VAIN haves found nothing; commons re-sent each round", async () => {
    const g = new Graph();
    const main = g.chain("m", 10, 1000);
    const other = g.chain("o", 600, 0);
    // a server that acknowledges m9..m0 once, never says ready
    const { connection, rounds } = fakeServer({
      version: 2,
      stateless: true,
      has: new Set(main),
      ackOnce: true,
    });
    const result = await fetchPack(
      connection,
      g,
      request([main[9] as string, other[599] as string]),
    );
    expect(MAX_IN_VAIN).toBe(256);
    const fresh = rounds.map((r, i) => r.haves.filter((h) => i === 0 || h !== main[9]).length);
    expect(fresh).toEqual([16, 32, 64, 128, 256]);
    expect(rounds.at(-1)?.done).toBe(true);
    expect(result.stats.haves).toBe(16 + 32 + 64 + 128 + 256);
    // the first round found m9 (and with it m8..m0, never offered again); later rounds repeat it
    expect(rounds[0]?.haves.slice(0, 10)).toEqual([...main].reverse());
    for (const r of rounds.slice(1)) expect(r.haves[0]).toBe(main[9]);
    expect(rounds.slice(1).every((r) => !r.haves.includes(main[8] as string))).toBe(true);
  });

  it("v2: the server's ready ends negotiation without done", async () => {
    const g = new Graph();
    const main = g.chain("m", 100, 0);
    const { connection, rounds } = fakeServer({
      version: 2,
      stateless: true,
      has: new Set(main),
      ready: () => true,
    });
    const result = await fetchPack(connection, g, request([main[99] as string]));
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.done).toBe(false);
    expect(result.packObjects).toBe(0);
  });

  it("v2: the shallow-info section reaches onShallowUpdate before the pack", async () => {
    const g = new Graph();
    const { connection } = fakeServer({
      version: 2,
      stateless: true,
      has: new Set(),
      shallowInfo: [`shallow ${oid("s1")}`, `unshallow ${oid("s0")}`],
    });
    let seen: unknown;
    const result = await fetchPack(
      connection,
      g,
      request([], {
        depth: 1,
        onShallowUpdate: (u) => {
          seen = u;
        },
      }),
    );
    expect(seen).toEqual({ shallow: [oid("s1")], unshallow: [oid("s0")] });
    expect(result.shallowUpdate).toEqual(seen);
  });

  it("v0 stateless: flushes at 16, 32, 64, …; every request repeats the wants and the commons", async () => {
    const g = new Graph();
    const tips = [g.chain("o", 600, 0).at(-1) as string];
    const { connection, rounds } = fakeServer({ version: 0, stateless: true, has: new Set() });
    await fetchPack(connection, g, request(tips));
    expect(rounds.map((r) => r.haves.length)).toEqual([16, 16, 32, 64, 128, 256, 88]);
    expect(rounds.every((r) => r.wants === 1)).toBe(true);
    expect(rounds.at(-1)?.done).toBe(true);

    const h = new Graph();
    const main = h.chain("m", 10, 1000);
    const other = h.chain("o", 600, 0);
    const second = fakeServer({ version: 0, stateless: true, has: new Set(main) });
    const result = await fetchPack(
      second.connection,
      h,
      request([main[9] as string, other[599] as string]),
    );
    // in vain from the last new common (m9, replayed in each later request): more than 256
    // in vain after a flush gives up
    const fresh = second.rounds.map(
      (r, i) => r.haves.filter((x) => i === 0 || x !== main[9]).length,
    );
    expect(fresh).toEqual([16, 16, 32, 64, 128, 256, 0]);
    for (const r of second.rounds.slice(1)) expect(r.haves[0]).toBe(main[9]);
    expect(second.rounds.at(-1)?.done).toBe(true);
    expect(result.stats.haves).toBe(512);
  });

  it("v0 stateful (a duplex): the wants once, then flushes at 16, 32, 64, 96, 128, …", async () => {
    const g = new Graph();
    const tips = [g.chain("o", 200, 0).at(-1) as string];
    const { connection, rounds } = fakeServer({ version: 0, stateless: false, has: new Set() });
    await fetchPack(connection, g, request(tips));
    expect(rounds.map((r) => r.haves.length)).toEqual([16, 16, 32, 32, 32, 32, 32, 8]);
    expect(rounds.map((r) => r.wants)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(rounds.at(-1)?.done).toBe(true);
  });
});

describe("fetchPack: a failure after the import leaves no quarantine", () => {
  /** An import that reads the first chunk only (as a pack import stops at the pack's end) */
  const quarantinedImport = () => {
    const discarded: number[] = [];
    const importPack = async (pack: AsyncIterable<Uint8Array>): Promise<PackImportResult> => {
      await pack[Symbol.asyncIterator]().next(); // not closed: the rest is the response's
      return {
        objectsImported: 0,
        blobsWithDelta: 0,
        treesImported: 0,
        commitsImported: 0,
        tagsImported: 0,
        quarantine: {
          repository: {} as never,
          commit: async () => {},
          discard: async () => {
            discarded.push(1);
          },
        },
      };
    };
    return { importPack, discarded };
  };

  it("a sideband error after the pack started: the import's quarantine is discarded", async () => {
    const g = new Graph();
    const { connection } = fakeServer({
      version: 2,
      stateless: true,
      has: new Set(),
      packSection: [band(1, EMPTY_PACK.subarray(0, 12)), band(3, enc.encode("broken\n")), FLUSH],
    });
    const { importPack, discarded } = quarantinedImport();
    await expect(fetchPack(connection, g, request([], { importPack }))).rejects.toThrow(/broken/);
    expect(discarded).toEqual([1]);
  });

  it("no pack at all: the import's quarantine is discarded", async () => {
    const g = new Graph();
    const { connection } = fakeServer({
      version: 2,
      stateless: true,
      has: new Set(),
      packSection: [FLUSH],
    });
    const { importPack, discarded } = quarantinedImport();
    await expect(fetchPack(connection, g, request([], { importPack }))).rejects.toThrow(
      "upload-pack sent no pack for the wanted objects",
    );
    expect(discarded).toEqual([1]);
  });
});
