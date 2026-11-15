/**
 * Protocol v0 upload-pack shallow requests, as git's upload-pack.c answers them, over raw
 * pkt-line requests into `serveOverDuplex`: deepening a shallow client (unshallow lines, the
 * pack continuing below the old boundary), `--unshallow`, `deepen-since`/`deepen-not`, and no
 * shallow section for a shallow client that does not deepen.
 */

import { describe, expect, it } from "vitest";
import { createSimpleDuplex } from "../src/adapters/http/http-duplex.js";
import { serveOverDuplex } from "../src/index.js";
import { encodeFlush, encodePacketLine } from "../src/protocol/pkt-line-codec.js";
import { createTransportRepo, type TransportRepo } from "./interop/helpers.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function commitAt(
  repo: TransportRepo,
  name: string,
  time: number,
  parents: string[] = [],
): Promise<string> {
  const blob = await repo.history.blobs.store([encoder.encode(`${name}\n`)]);
  const tree = await repo.history.trees.store([{ name: `${name}.txt`, mode: 0o100644, id: blob }]);
  const ident = { name: "T", email: "t@example.com", timestamp: time, tzOffset: "+0000" };
  return repo.history.commits.store({
    tree,
    parents,
    author: ident,
    committer: ident,
    message: `${name}\n`,
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** main: c1 ← c2 ← c3 ← c4 (times 100..400). */
async function linearRepo() {
  const repo = await createTransportRepo();
  const c1 = await commitAt(repo, "c1", 100);
  const c2 = await commitAt(repo, "c2", 200, [c1]);
  const c3 = await commitAt(repo, "c3", 300, [c2]);
  const c4 = await commitAt(repo, "c4", 400, [c3]);
  await repo.refStore.update("refs/heads/main", c4);
  return { repo, c1, c2, c3, c4 };
}

/**
 * Sends a v0 request: the first want carries the capabilities, then `lines` (shallow, deepen),
 * a flush, the haves and "done". Returns the text lines after the advertisement ("FLUSH" for a
 * flush) and the number of objects in the pack.
 */
async function fetchV0(
  repo: TransportRepo,
  wants: string[],
  lines: string[],
  haves: string[] = [],
): Promise<{ lines: string[]; packObjects?: number }> {
  const request = concat([
    ...wants.map((w, i) =>
      encodePacketLine(
        i === 0 ? `want ${w} multi_ack_detailed side-band-64k ofs-delta shallow\n` : `want ${w}\n`,
      ),
    ),
    ...lines.map((l) => encodePacketLine(`${l}\n`)),
    encodeFlush(),
    ...haves.map((h) => encodePacketLine(`have ${h}\n`)),
    encodePacketLine("done\n"),
  ]);
  const out: Uint8Array[] = [];
  await serveOverDuplex({
    duplex: createSimpleDuplex(
      (async function* () {
        yield request;
      })(),
      (data) => {
        out.push(data);
      },
    ),
    repository: repo.facade,
    refStore: repo.refStore,
    service: "git-upload-pack",
    protocolVersion: "1",
  });
  const bytes = concat(out);
  const result: string[] = [];
  const pack: Uint8Array[] = [];
  let pos = 0;
  let inAdvertisement = true;
  while (pos + 4 <= bytes.length) {
    const len = Number.parseInt(decoder.decode(bytes.subarray(pos, pos + 4)), 16);
    if (len < 4) {
      pos += 4;
      if (inAdvertisement) inAdvertisement = false;
      else if (pack.length === 0) result.push("FLUSH");
      continue;
    }
    const payload = bytes.subarray(pos + 4, pos + len);
    pos += len;
    if (inAdvertisement) continue;
    if (payload[0] === 1) pack.push(payload.subarray(1));
    else if (payload[0] === 2) continue;
    else if (payload[0] === 3) result.push(`ERR ${decoder.decode(payload.subarray(1))}`);
    else result.push(decoder.decode(payload).replace(/\n$/, ""));
  }
  const packBytes = concat(pack);
  const packObjects =
    packBytes.length >= 12
      ? new DataView(packBytes.buffer, packBytes.byteOffset).getUint32(8)
      : undefined;
  return { lines: result, packObjects };
}

describe("protocol v0 upload-pack: shallow", () => {
  it("deepen 2 from a client shallow at c4: unshallows c4, c3 is the new boundary", async () => {
    const { repo, c3, c4 } = await linearRepo();
    const res = await fetchV0(repo, [c4], [`shallow ${c4}`, "deepen 2"], [c4]);
    expect(res.lines.slice(0, 3)).toEqual([`shallow ${c3}`, `unshallow ${c4}`, "FLUSH"]);
    expect(res.packObjects).toBe(3); // c3, its tree and blob
  });

  it("deepen 2147483647 (--unshallow) sends the history below the client's boundary", async () => {
    const { repo, c3, c4 } = await linearRepo();
    const res = await fetchV0(repo, [c4], [`shallow ${c3}`, "deepen 2147483647"], [c4]);
    expect(res.lines.slice(0, 2)).toEqual([`unshallow ${c3}`, "FLUSH"]);
    expect(res.packObjects).toBe(6); // c1, c2 with their trees and blobs
  });

  it("deepen-since and deepen-not cut the history", async () => {
    const { repo, c2, c3, c4 } = await linearRepo();
    const since = await fetchV0(repo, [c4], ["deepen-since 300"]);
    expect(since.lines.slice(0, 2)).toEqual([`shallow ${c3}`, "FLUSH"]);
    expect(since.packObjects).toBe(6);

    await repo.refStore.update("refs/tags/old", c2);
    const not = await fetchV0(repo, [c4], ["deepen-not old"]);
    expect(not.lines.slice(0, 2)).toEqual([`shallow ${c3}`, "FLUSH"]);
    expect(not.packObjects).toBe(6);
  });

  it("a shallow client that does not deepen gets no shallow section; the pack stops at it", async () => {
    const { repo, c3, c4 } = await linearRepo();
    const res = await fetchV0(repo, [c4], [`shallow ${c3}`], [c3]);
    expect(res.lines[0]).toBe(`ACK ${c3}`);
    expect(res.lines).not.toContain(`unshallow ${c3}`);
    expect(res.packObjects).toBe(3); // c4 alone
  });

  it("refuses deepen-since 0, and an ambiguous deepen-not", async () => {
    const { repo, c2, c4 } = await linearRepo();
    const zero = await fetchV0(repo, [c4], ["deepen-since 0"]);
    expect(zero.lines).toContain("ERR Invalid deepen-since: deepen-since 0");
    expect(zero.packObjects).toBeUndefined();

    await repo.refStore.update("refs/heads/dup", c2);
    await repo.refStore.update("refs/tags/dup", c2);
    const dup = await fetchV0(repo, [c4], ["deepen-not dup"]);
    expect(dup.lines.some((l) => l.startsWith("ERR ") && l.includes("ambiguous deepen-not"))).toBe(
      true,
    );
    expect(dup.packObjects).toBeUndefined();
  });
});
