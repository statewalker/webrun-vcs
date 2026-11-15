/**
 * Protocol v2 upload-pack against git's upload-pack.c, over raw pkt-line requests into
 * `serveOverDuplex` (real vcs-core repositories):
 *
 * - "not our ref" for wants that are no tip and not reachable from one,
 * - negotiation: "ready" only from ok_to_give_up, no acknowledgments after "done" or without
 *   haves, NAK when nothing is common, never "ready" with wait-for-done,
 * - shallow: deepen, unshallow, deepen-relative, deepen-since, deepen-not, and the pack cut at
 *   the boundary,
 * - no `filter` advertised, and a filter request refused.
 */

import { describe, expect, it } from "vitest";
import { createSimpleDuplex } from "../src/adapters/http/http-duplex.js";
import { fetchOverDuplex, serveOverDuplex } from "../src/index.js";
import { encodeDelim, encodeFlush, encodePacketLine } from "../src/protocol/pkt-line-codec.js";
import { createTransportRepo, type TransportRepo } from "./interop/helpers.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A commit with one file, at a given committer time. */
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

interface V2Response {
  /** Text pkt-lines before the pack, "DELIM"/"FLUSH" for the specials */
  lines: string[];
  /** Objects in the pack (undefined: no packfile section) */
  packObjects?: number;
  /** The capability advertisement */
  capabilities: string[];
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

function parseResponse(bytes: Uint8Array): V2Response {
  const capabilities: string[] = [];
  const lines: string[] = [];
  const pack: Uint8Array[] = [];
  let pos = 0;
  let inCaps = true;
  let inPack = false;
  while (pos + 4 <= bytes.length) {
    const len = Number.parseInt(decoder.decode(bytes.subarray(pos, pos + 4)), 16);
    if (len < 4) {
      pos += 4;
      const special = len === 0 ? "FLUSH" : "DELIM";
      if (inCaps) inCaps = false;
      else if (!inPack) lines.push(special);
      continue;
    }
    const payload = bytes.subarray(pos + 4, pos + len);
    pos += len;
    if (inPack) {
      if (payload[0] === 1) pack.push(payload.subarray(1));
      else if (payload[0] === 3) lines.push(`ERR ${decoder.decode(payload.subarray(1))}`);
      continue;
    }
    const text = decoder.decode(payload).replace(/\n$/, "");
    if (inCaps) capabilities.push(text);
    else {
      lines.push(text);
      if (text === "packfile") inPack = true;
    }
  }
  const packBytes = concat(pack);
  const packObjects =
    packBytes.length >= 12
      ? new DataView(packBytes.buffer, packBytes.byteOffset).getUint32(8)
      : undefined;
  return { lines, packObjects, capabilities };
}

/** Sends one v2 `fetch` command with these argument lines; returns the parsed response. */
async function fetchRaw(
  repo: TransportRepo,
  args: string[],
  options: { requestPolicy?: "ANY" } = {},
): Promise<V2Response> {
  const request = concat([
    encodePacketLine("command=fetch\n"),
    encodePacketLine("object-format=sha1\n"),
    encodeDelim(),
    ...args.map((a) => encodePacketLine(`${a}\n`)),
    encodeFlush(),
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
    protocolVersion: "2",
    requestPolicy: options.requestPolicy,
  });
  return parseResponse(concat(out));
}

/** main: c1 ← c2 ← c3 ← c4 (times 100..400); a dangling commit d off c2. */
async function linearRepo() {
  const repo = await createTransportRepo();
  const c1 = await commitAt(repo, "c1", 100);
  const c2 = await commitAt(repo, "c2", 200, [c1]);
  const c3 = await commitAt(repo, "c3", 300, [c2]);
  const c4 = await commitAt(repo, "c4", 400, [c3]);
  const dangling = await commitAt(repo, "d", 250, [c2]);
  await repo.refStore.update("refs/heads/main", c4);
  return { repo, c1, c2, c3, c4, dangling };
}

describe("protocol v2 upload-pack: not our ref", () => {
  it("refuses a commit no ref reaches", async () => {
    const { repo, dangling } = await linearRepo();
    const res = await fetchRaw(repo, [`want ${dangling}`, "done"]);
    expect(res.lines).toContain(`ERR upload-pack: not our ref ${dangling}`);
    expect(res.lines).not.toContain("packfile");
  });

  it("refuses an object the repository lacks", async () => {
    const { repo } = await linearRepo();
    const missing = "1".repeat(40);
    const res = await fetchRaw(repo, [`want ${missing}`, "done"]);
    expect(res.lines).toContain(`ERR upload-pack: not our ref ${missing}`);
  });

  it("serves a commit reachable from a tip that is no tip itself", async () => {
    const { repo, c2 } = await linearRepo();
    const res = await fetchRaw(repo, [`want ${c2}`, "done"]);
    expect(res.lines).toContain("packfile");
    expect(res.packObjects).toBe(6); // c1, c2: commit + tree + blob each
  });

  it("refuses a blob that is no tip (as allowReachableSHA1InWant), unless the policy is ANY", async () => {
    const { repo, c1 } = await linearRepo();
    const tree = await repo.history.commits.getTree(c1);
    const res = await fetchRaw(repo, [`want ${tree}`, "done"]);
    expect(res.lines).toContain(`ERR upload-pack: not our ref ${tree}`);

    const any = await fetchRaw(repo, [`want ${tree}`, "done"], { requestPolicy: "ANY" });
    expect(any.lines).toContain("packfile");
  });
});

describe("protocol v2 upload-pack: negotiation", () => {
  it("sends no acknowledgments section after done, or without haves", async () => {
    const { repo, c2, c4 } = await linearRepo();
    const done = await fetchRaw(repo, [`want ${c4}`, `have ${c2}`, "done"]);
    expect(done.lines[0]).toBe("packfile");
    expect(done.packObjects).toBe(6); // c3, c4

    const clone = await fetchRaw(repo, [`want ${c4}`]);
    expect(clone.lines[0]).toBe("packfile");
  });

  it("answers NAK and no pack when nothing is common", async () => {
    const { repo, c4 } = await linearRepo();
    const res = await fetchRaw(repo, [`want ${c4}`, `have ${"2".repeat(40)}`]);
    expect(res.lines).toEqual(["acknowledgments", "NAK", "FLUSH"]);
  });

  it("says ready once every want reaches a common commit", async () => {
    const { repo, c2, c4 } = await linearRepo();
    const res = await fetchRaw(repo, [`want ${c4}`, `have ${c2}`]);
    expect(res.lines.slice(0, 4)).toEqual(["acknowledgments", `ACK ${c2}`, "ready", "DELIM"]);
    expect(res.lines[4]).toBe("packfile");
    expect(res.packObjects).toBe(6);
  });

  it("is not ready while a want shares no history with the haves", async () => {
    const { repo, c2, c4 } = await linearRepo();
    const orphan = await commitAt(repo, "orphan", 500);
    await repo.refStore.update("refs/heads/orphan", orphan);
    const res = await fetchRaw(repo, [`want ${c4}`, `want ${orphan}`, `have ${c2}`]);
    expect(res.lines).toEqual(["acknowledgments", `ACK ${c2}`, "FLUSH"]);
  });

  it("never says ready with wait-for-done", async () => {
    const { repo, c2, c4 } = await linearRepo();
    const res = await fetchRaw(repo, [`want ${c4}`, `have ${c2}`, "wait-for-done"]);
    expect(res.lines).toEqual(["acknowledgments", `ACK ${c2}`, "FLUSH"]);
  });

  it("our v2 client ends negotiation with done when the server is never ready", async () => {
    const { repo: server, c2, c4 } = await linearRepo();
    const orphan = await commitAt(server, "orphan", 500);
    await server.refStore.update("refs/heads/orphan", orphan);

    // the client has c1 ← c2 (same oids), on main
    const client = await createTransportRepo();
    const k1 = await commitAt(client, "c1", 100);
    const k2 = await commitAt(client, "c2", 200, [k1]);
    expect(k2).toBe(c2);
    await client.refStore.update("refs/heads/main", k2);

    const handlerDuplex = loopback(server);
    const result = await fetchOverDuplex({
      duplex: handlerDuplex,
      repository: client.facade,
      refStore: client.refStore,
    });
    expect(result.success, result.error).toBe(true);
    expect(await client.facade.has(c4)).toBe(true);
    expect(await client.facade.has(orphan)).toBe(true);
  });
});

describe("protocol v2 upload-pack: shallow", () => {
  it("deepen 1: the wants are the shallow commits, the pack holds them alone", async () => {
    const { repo, c4 } = await linearRepo();
    const res = await fetchRaw(repo, [`want ${c4}`, "deepen 1", "done"]);
    expect(res.lines.slice(0, 4)).toEqual(["shallow-info", `shallow ${c4}`, "DELIM", "packfile"]);
    expect(res.packObjects).toBe(3);
  });

  it("deepen 2 from a client shallow at c4: unshallows c4, c3 is the new boundary", async () => {
    const { repo, c3, c4 } = await linearRepo();
    const res = await fetchRaw(repo, [
      `want ${c4}`,
      `have ${c4}`,
      `shallow ${c4}`,
      "deepen 2",
      "done",
    ]);
    expect(res.lines.slice(0, 5)).toEqual([
      "shallow-info",
      `shallow ${c3}`,
      `unshallow ${c4}`,
      "DELIM",
      "packfile",
    ]);
    expect(res.packObjects).toBe(3); // c3 alone: the client has c4
  });

  it("deepen 2147483647 (--unshallow) unshallows every client shallow commit", async () => {
    const { repo, c3, c4 } = await linearRepo();
    const res = await fetchRaw(repo, [
      `want ${c4}`,
      `have ${c4}`,
      `have ${c3}`,
      `shallow ${c3}`,
      "deepen 2147483647",
      "done",
    ]);
    expect(res.lines.slice(0, 4)).toEqual(["shallow-info", `unshallow ${c3}`, "DELIM", "packfile"]);
    expect(res.packObjects).toBe(6); // c1, c2
  });

  it("deepen-relative counts from the client's shallow commits", async () => {
    const { repo, c2, c3, c4 } = await linearRepo();
    const res = await fetchRaw(repo, [
      `want ${c4}`,
      `have ${c4}`,
      `have ${c3}`,
      `shallow ${c3}`,
      "deepen 1",
      "deepen-relative",
      "done",
    ]);
    expect(res.lines.slice(0, 5)).toEqual([
      "shallow-info",
      `shallow ${c2}`,
      `unshallow ${c3}`,
      "DELIM",
      "packfile",
    ]);
    expect(res.packObjects).toBe(3);
  });

  it("deepen-since cuts commits older than the cutoff", async () => {
    const { repo, c3, c4 } = await linearRepo();
    const res = await fetchRaw(repo, [`want ${c4}`, "deepen-since 300", "done"]);
    expect(res.lines.slice(0, 4)).toEqual(["shallow-info", `shallow ${c3}`, "DELIM", "packfile"]);
    expect(res.packObjects).toBe(6);
  });

  it("deepen-not cuts the history of a ref", async () => {
    const { repo, c2, c3, c4 } = await linearRepo();
    await repo.refStore.update("refs/tags/old", c2);
    const res = await fetchRaw(repo, [`want ${c4}`, "deepen-not old", "done"]);
    expect(res.lines.slice(0, 4)).toEqual(["shallow-info", `shallow ${c3}`, "DELIM", "packfile"]);
    expect(res.packObjects).toBe(6);
  });

  it("a shallow client without deepen gets an empty shallow-info, the pack stops at its boundary", async () => {
    const { repo, c3, c4 } = await linearRepo();
    const res = await fetchRaw(repo, [`want ${c4}`, `shallow ${c3}`, `have ${c3}`, "done"]);
    expect(res.lines.slice(0, 3)).toEqual(["shallow-info", "DELIM", "packfile"]);
    expect(res.packObjects).toBe(3);
  });

  it("refuses deepen together with deepen-since", async () => {
    const { repo, c4 } = await linearRepo();
    const res = await fetchRaw(repo, [`want ${c4}`, "deepen 1", "deepen-since 300", "done"]);
    expect(
      res.lines.some((l) => l.startsWith("ERR ") && l.includes("cannot be used together")),
    ).toBe(true);
  });

  it("our v2 client clones with depth 1 and gets one commit", async () => {
    const { repo: server, c3, c4 } = await linearRepo();
    const client = await createTransportRepo();
    const result = await fetchOverDuplex({
      duplex: loopback(server),
      repository: client.facade,
      refStore: client.refStore,
      depth: 1,
    });
    expect(result.success, result.error).toBe(true);
    expect(await client.facade.has(c4)).toBe(true);
    expect(await client.facade.has(c3)).toBe(false);
  });
});

describe("protocol v2 upload-pack: capabilities", () => {
  it("advertises no filter, and refuses a filter request", async () => {
    const { repo, c4 } = await linearRepo();
    const res = await fetchRaw(repo, [`want ${c4}`, "filter blob:none", "done"]);
    expect(res.capabilities.some((c) => c.includes("filter"))).toBe(false);
    expect(res.lines).toContain("ERR unexpected line: 'filter blob:none'");
  });
});

/** An in-process duplex pair: the client side, with the v2 server running on the other. */
function loopback(server: TransportRepo) {
  const toServer = channel();
  const toClient = channel();
  void serveOverDuplex({
    duplex: { [Symbol.asyncIterator]: () => toServer.iterator(), write: toClient.push },
    repository: server.facade,
    refStore: server.refStore,
    service: "git-upload-pack",
    protocolVersion: "2",
  }).finally(() => toClient.end());
  return {
    [Symbol.asyncIterator]: () => toClient.iterator(),
    write: toServer.push,
    close: async () => toServer.end(),
  };
}

function channel() {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    push: (data: Uint8Array) => {
      queue.push(data.slice());
      wake?.();
    },
    end: () => {
      ended = true;
      wake?.();
    },
    async *iterator(): AsyncGenerator<Uint8Array> {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
}

/** Serves raw v2 request bytes (any number of commands); returns the raw response. */
async function serveRaw(
  repository: TransportRepo["facade"],
  refStore: TransportRepo["refStore"],
  request: Uint8Array,
  capabilities?: string[],
): Promise<Uint8Array> {
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
    repository,
    refStore,
    service: "git-upload-pack",
    protocolVersion: "2",
    capabilities,
  });
  return concat(out);
}

function fetchCommand(args: string[]): Uint8Array[] {
  return [
    encodePacketLine("command=fetch\n"),
    encodePacketLine("object-format=sha1\n"),
    encodeDelim(),
    ...args.map((a) => encodePacketLine(`${a}\n`)),
    encodeFlush(),
  ];
}

describe("protocol v2 upload-pack: review fixes", () => {
  it("says ready for a want older than the common commit it is a child of (start is walked)", async () => {
    const { repo, c4 } = await linearRepo();
    const old = await commitAt(repo, "old", 10, [c4]);
    await repo.refStore.update("refs/heads/old", old);
    const res = await fetchRaw(repo, [`want ${old}`, `have ${c4}`]);
    expect(res.lines.slice(0, 4)).toEqual(["acknowledgments", `ACK ${c4}`, "ready", "DELIM"]);
  });

  it("lists only the current command's want-refs in wanted-refs", async () => {
    const { repo, c3, c4 } = await linearRepo();
    await repo.refStore.update("refs/heads/other", c3);
    const response = await serveRaw(
      repo.facade,
      repo.refStore,
      concat([
        ...fetchCommand(["want-ref refs/heads/main", "done"]),
        ...fetchCommand(["want-ref refs/heads/other", "done"]),
      ]),
    );
    const text = new TextDecoder("latin1").decode(response);
    expect(text.split(`${c4} refs/heads/main`).length - 1).toBe(1);
    expect(text.split(`${c3} refs/heads/other`).length - 1).toBe(1);
  });

  it("refuses a deepen-not that names several refs as ambiguous", async () => {
    const { repo, c2, c4 } = await linearRepo();
    await repo.refStore.update("refs/heads/dup", c2);
    await repo.refStore.update("refs/tags/dup", c2);
    const res = await fetchRaw(repo, [`want ${c4}`, "deepen-not dup", "done"]);
    expect(res.lines.some((l) => l.startsWith("ERR ") && l.includes("ambiguous deepen-not"))).toBe(
      true,
    );
    expect(res.lines).not.toContain("packfile");
  });

  it("refuses deepen-since 0 or a negative time", async () => {
    const { repo, c4 } = await linearRepo();
    for (const since of ["0", "-5"]) {
      const res = await fetchRaw(repo, [`want ${c4}`, `deepen-since ${since}`, "done"]);
      expect(res.lines).toContain(`ERR Invalid deepen-since: deepen-since ${since}`);
      expect(res.lines).not.toContain("packfile");
    }
  });

  it("passes an advertised filter on to exportPack", async () => {
    const { repo, c4 } = await linearRepo();
    const seen: (string | undefined)[] = [];
    const facade = Object.create(repo.facade) as TransportRepo["facade"];
    facade.exportPack = (wants, exclude, options) => {
      seen.push(options?.filterSpec);
      return repo.facade.exportPack(wants, exclude, options);
    };
    await serveRaw(
      facade,
      repo.refStore,
      concat(fetchCommand([`want ${c4}`, "filter blob:none", "done"])),
      ["agent=test", "ls-refs", "fetch=shallow filter", "object-format=sha1"],
    );
    expect(seen).toEqual(["blob:none"]);
  });
});
