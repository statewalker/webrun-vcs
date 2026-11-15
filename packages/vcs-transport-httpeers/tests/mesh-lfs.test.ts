import {
  createFilesLfsStore,
  createMemoryLockStore,
  type FetchLike,
  type LfsObjectStore,
  type LfsPointer,
  lfsDownload,
  lfsLocks,
  lfsUpload,
  sha256Hex,
} from "@statewalker/vcs-transport-lfs";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";
import { describe, expect, it } from "vitest";
import {
  gitRules,
  type LfsSource,
  lfsSwarmDownload,
  meshLfsHandler,
  meshRemoteFetch,
  RANGED_TRANSFER,
  servePeerConnection,
} from "../src/index.js";
import { collect, createHub, type Hub, prng } from "./helpers.js";

const lfsUrl = (peer: string) => `http://${peer}.mesh/repo.git/info/lfs`;
const SIZE = 1_300_000;
const CHUNK = 128 * 1024;

async function pointerOf(bytes: Uint8Array): Promise<LfsPointer> {
  return { oid: await sha256Hex(bytes), size: bytes.length };
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

/** A store whose reads flip one byte in every 64 KiB: it answers batches, but its bytes are wrong. */
function corrupting(store: LfsObjectStore): LfsObjectStore {
  return {
    ...store,
    async *read(oid, range) {
      let at = range?.offset ?? 0;
      for await (const chunk of store.read(oid, range)) {
        const copy = new Uint8Array(chunk);
        for (let i = 0; i < copy.length; i++)
          if ((at + i) % 65536 === 7) copy[i] = (copy[i] as number) ^ 0xff;
        at += copy.length;
        yield copy;
      }
    },
  };
}

/** A fetch whose response bodies end (with an error) once `budget` bytes went through. */
function cutAfter(fetchImpl: FetchLike, budget: { left: number }): FetchLike {
  return async (request) => {
    const res = await fetchImpl(request);
    if (!res.body || !request.headers.has("range")) return res;
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (budget.left <= 0) {
          await reader.cancel().catch(() => {});
          ctrl.error(new Error("connection lost"));
          return;
        }
        const r = await reader.read();
        if (r.done) return ctrl.close();
        const part = r.value.subarray(0, budget.left);
        budget.left -= part.length;
        ctrl.enqueue(part);
      },
      cancel: () => reader.cancel(),
    });
    return new Response(body, { status: res.status, headers: res.headers });
  };
}

/** Peers serving LFS, each with its own store; `source(peer, caller, roles)` reaches one. */
async function lfsMesh(hub: Hub, names: string[], opts: { contributors?: boolean } = {}) {
  const stores = new Map<string, LfsObjectStore>();
  const handlers = new Map<string, ReturnType<typeof meshLfsHandler>>();
  for (const name of names) {
    const store = createFilesLfsStore(new MemFilesApi());
    stores.set(name, store);
    handlers.set(
      name,
      meshLfsHandler({
        objects: name.startsWith("bad") ? corrupting(store) : store,
        access: { issuer: hub.issuer, now: hub.now, rules: gitRules(opts) },
        locks: { store: createMemoryLockStore() },
      }),
    );
  }
  const fetchFor = async (peer: string, caller: string, roles: string[]) => {
    const handler = handlers.get(peer);
    if (!handler) throw new Error(peer);
    return meshRemoteFetch({
      call: servePeerConnection(handler, { remotePeer: caller }),
      token: await hub.token(caller, roles),
    });
  };
  const source = async (peer: string, caller = "A", roles = ["member"]): Promise<LfsSource> => ({
    name: peer,
    url: lfsUrl(peer),
    fetchImpl: await fetchFor(peer, caller, roles),
  });
  return { stores, fetchFor, source };
}

describe("LFS swarm download", () => {
  it("downloads one object from three peers at once and verifies it", async () => {
    const hub = await createHub();
    const m = await lfsMesh(hub, ["b", "c", "d"]);
    const bytes = prng(SIZE, 1);
    const p = await pointerOf(bytes);
    for (const s of m.stores.values()) expect((await s.put(bytes, p)).ok).toBe(true);

    const local = createFilesLfsStore(new MemFilesApi());
    const sources = await Promise.all(["b", "c", "d"].map((n) => m.source(n)));
    const r = await lfsSwarmDownload([p], sources, local, { chunkSize: CHUNK });
    expect(r).toMatchObject({ downloaded: [p.oid], failed: [], bad: [] });
    expect(same(await collect(local.read(p.oid)), bytes)).toBe(true);
    // every peer served a share, and no byte came twice
    for (const n of ["b", "c", "d"]) expect(r.received[n]).toBeGreaterThan(0);
    expect(Object.values(r.received).reduce((a, b) => a + b, 0)).toBe(SIZE);

    // held already: nothing is asked for
    const again = await lfsSwarmDownload([p], sources, local, { chunkSize: CHUNK });
    expect(again.downloaded).toEqual([]);
  });

  it("a peer serving wrong bytes fails verification, the others are fallen back on, it is blamed", async () => {
    const hub = await createHub();
    const m = await lfsMesh(hub, ["b", "c", "bad"]);
    const bytes = prng(SIZE, 2);
    const p = await pointerOf(bytes);
    for (const s of m.stores.values()) expect((await s.put(bytes, p)).ok).toBe(true);

    const local = createFilesLfsStore(new MemFilesApi());
    // the faulty peer first, so the fallback tries it before a good one
    const sources = await Promise.all(["bad", "b", "c"].map((n) => m.source(n)));
    const r = await lfsSwarmDownload([p], sources, local, { chunkSize: CHUNK });
    expect(r.downloaded).toEqual([p.oid]);
    expect(r.failed).toEqual([]);
    expect(r.bad).toEqual(["bad"]);
    expect(same(await collect(local.read(p.oid)), bytes)).toBe(true);
  });

  it("only faulty peers: nothing becomes visible", async () => {
    const hub = await createHub();
    const m = await lfsMesh(hub, ["bad1", "bad2"]);
    const bytes = prng(300_000, 3);
    const p = await pointerOf(bytes);
    for (const s of m.stores.values()) await s.put(bytes, p);
    const local = createFilesLfsStore(new MemFilesApi());
    const r = await lfsSwarmDownload(
      [p],
      await Promise.all(["bad1", "bad2"].map((n) => m.source(n))),
      local,
      { chunkSize: CHUNK },
    );
    expect(r.downloaded).toEqual([]);
    expect(r.failed[0]?.reason).toMatch(/verified/);
    expect(r.bad.sort()).toEqual(["bad1", "bad2"]);
    expect(await local.size(p.oid)).toBeUndefined();
  });

  it("resumes: what arrived before every source broke stays, the next call fetches only the rest", async () => {
    const hub = await createHub();
    const m = await lfsMesh(hub, ["b", "c"]);
    const bytes = prng(SIZE, 4);
    const p = await pointerOf(bytes);
    for (const s of m.stores.values()) await s.put(bytes, p);
    const local = createFilesLfsStore(new MemFilesApi());

    const budget = { left: 500_000 };
    const broken = await Promise.all(
      ["b", "c"].map(async (n) => {
        const s = await m.source(n);
        return { ...s, fetchImpl: cutAfter(s.fetchImpl as FetchLike, budget) };
      }),
    );
    const first = await lfsSwarmDownload([p], broken, local, { chunkSize: CHUNK });
    expect(first.downloaded).toEqual([]);
    expect(first.failed).toHaveLength(1);
    const held = (await local.partial?.size(p.oid)) ?? 0;
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThanOrEqual(500_000);

    const healthy = await Promise.all(["b", "c"].map((n) => m.source(n)));
    const second = await lfsSwarmDownload([p], healthy, local, { chunkSize: CHUNK });
    expect(second.downloaded).toEqual([p.oid]);
    expect(Object.values(second.received).reduce((a, b) => a + b, 0)).toBe(SIZE - held);
    expect(same(await collect(local.read(p.oid)), bytes)).toBe(true);
  });

  it("reads a source that ignores Range from the chunk's start; a peer without the object is skipped", async () => {
    const hub = await createHub();
    const m = await lfsMesh(hub, ["b", "empty"]);
    const bytes = prng(400_000, 5);
    const p = await pointerOf(bytes);
    await m.stores.get("b")?.put(bytes, p);
    const b = await m.source("b");
    const inner = b.fetchImpl as FetchLike;
    const noRange: FetchLike = (request) => {
      const headers = new Headers(request.headers);
      headers.delete("range");
      return inner(new Request(request, { headers }));
    };
    const local = createFilesLfsStore(new MemFilesApi());
    const r = await lfsSwarmDownload(
      [p],
      [{ ...b, fetchImpl: noRange }, await m.source("empty")],
      local,
      { chunkSize: CHUNK },
    );
    expect(r.downloaded).toEqual([p.oid]);
    expect(same(await collect(local.read(p.oid)), bytes)).toBe(true);
  });

  it("downloads into a store without partials (put, verified)", async () => {
    const hub = await createHub();
    const m = await lfsMesh(hub, ["b", "c"]);
    const bytes = prng(500_000, 6);
    const p = await pointerOf(bytes);
    for (const s of m.stores.values()) await s.put(bytes, p);
    const files = createFilesLfsStore(new MemFilesApi());
    const local: LfsObjectStore = { size: files.size, read: files.read, put: files.put };
    const r = await lfsSwarmDownload(
      [p],
      await Promise.all(["b", "c"].map((n) => m.source(n))),
      local,
      { chunkSize: CHUNK },
    );
    expect(r.downloaded).toEqual([p.oid]);
    expect(same(await collect(local.read(p.oid)), bytes)).toBe(true);
  });
});

describe("meshLfsHandler", () => {
  it("negotiates ranged only when offered; the standard client (basic) works against it", async () => {
    const hub = await createHub();
    const m = await lfsMesh(hub, ["b"]);
    const bytes = prng(200_000, 7);
    const p = await pointerOf(bytes);
    await m.stores.get("b")?.put(bytes, p);
    const f = await m.fetchFor("b", "A", ["member"]);
    const batch = async (transfers: string[]) => {
      const res = await f(
        new Request(`${lfsUrl("b")}/objects/batch`, {
          method: "POST",
          headers: { "content-type": "application/vnd.git-lfs+json" },
          body: JSON.stringify({ operation: "download", transfers, objects: [p] }),
        }),
      );
      return ((await res.json()) as { transfer: string }).transfer;
    };
    expect(await batch([RANGED_TRANSFER, "basic"])).toBe(RANGED_TRANSFER);
    expect(await batch(["basic"])).toBe("basic");

    const local = createFilesLfsStore(new MemFilesApi());
    const events = [];
    for await (const e of lfsDownload(local, lfsUrl("b"), [p], f)) events.push(e);
    expect(events.at(-1)).toEqual({ type: "object-downloaded", oid: p.oid });
    expect(same(await collect(local.read(p.oid)), bytes)).toBe(true);
  });

  it("downloads need git:read, uploads git:write (or write-own); no token is 401", async () => {
    const hub = await createHub();
    const m = await lfsMesh(hub, ["b", "c"], { contributors: false });
    const bytes = prng(100_000, 8);
    const p = await pointerOf(bytes);
    const src = createFilesLfsStore(new MemFilesApi());
    await src.put(bytes, p);

    const upload = async (f: FetchLike) => {
      const events = [];
      for await (const e of lfsUpload(src, lfsUrl("b"), [p], f)) events.push(e);
      return events;
    };
    await expect(upload(await m.fetchFor("b", "R", ["member"]))).rejects.toThrow(/403/);
    await expect(upload(await m.fetchFor("b", "S", ["stranger"]))).rejects.toThrow(/403/);
    expect(await upload(await m.fetchFor("b", "T", ["admin"]))).toContainEqual({
      type: "object-uploaded",
      oid: p.oid,
    });
    expect(await m.stores.get("b")?.size(p.oid)).toBe(p.size);

    // a member reads; a stranger's token derives nothing (403); no token is 401
    const reader = await m.source("b", "R", ["member"]);
    const ok = await lfsSwarmDownload([p], [reader], createFilesLfsStore(new MemFilesApi()));
    expect(ok.downloaded).toEqual([p.oid]);
    const stranger = await m.source("b", "S", ["stranger"]);
    const no = await lfsSwarmDownload([p], [stranger], createFilesLfsStore(new MemFilesApi()));
    expect(no.failed[0]?.reason).toMatch(/403/);
    const res = await fetchOverDuplex(
      servePeerConnection(
        meshLfsHandler({
          objects: m.stores.get("b") as LfsObjectStore,
          access: { issuer: hub.issuer },
        }),
        { remotePeer: "R" },
      ),
      new Request(`${lfsUrl("b")}/objects/${p.oid}`),
    );
    await res.body?.cancel();
    expect(res.status).toBe(401);
  });

  it("contributors may upload; lock owners are proven peer ids", async () => {
    const hub = await createHub();
    const m = await lfsMesh(hub, ["b"], { contributors: true });
    const bytes = prng(50_000, 9);
    const p = await pointerOf(bytes);
    const src = createFilesLfsStore(new MemFilesApi());
    await src.put(bytes, p);
    const f = await m.fetchFor("b", "M", ["member"]);
    const events = [];
    for await (const e of lfsUpload(src, lfsUrl("b"), [p], f)) events.push(e);
    expect(events).toContainEqual({ type: "object-uploaded", oid: p.oid });

    const lock = await lfsLocks(lfsUrl("b"), f).createLock("assets/a.psd");
    expect(lock.owner?.name).toBe("M");
    const other = lfsLocks(lfsUrl("b"), await m.fetchFor("b", "N", ["member"]));
    await expect(other.unlock(lock.id)).rejects.toThrow();
    const admin = lfsLocks(lfsUrl("b"), await m.fetchFor("b", "T", ["admin"]));
    await admin.unlock(lock.id, { force: true });
    expect(await lfsLocks(lfsUrl("b"), f).listLocks()).toMatchObject({ locks: [] });
  });
});
