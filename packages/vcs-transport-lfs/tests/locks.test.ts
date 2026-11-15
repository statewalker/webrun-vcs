import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  createFilesLfsStore,
  createFilesLockStore,
  createMemoryLockStore,
  type FetchLike,
  LfsLockError,
  type LfsLockStore,
  type LfsLocksOptions,
  type LfsServerOptions,
  lfsLocks,
  normalizeLockPath,
  serveLfs,
} from "../src/index.js";

const URL_BASE = "http://lfs.test/repo.git/info/lfs";
const basic = (user: string) => `Basic ${btoa(`${user}:pw`)}`;

function server(
  store: LfsLockStore,
  locks: Partial<LfsLocksOptions> = {},
  opts: LfsServerOptions = {},
) {
  return serveLfs(createFilesLfsStore(new MemFilesApi()), {
    ...opts,
    locks: { store, ...locks },
  });
}

const as = (handler: FetchLike, user: string) =>
  lfsLocks(URL_BASE, handler, { credentials: { username: user, password: "pw" } });

async function rejection(p: Promise<unknown>): Promise<LfsLockError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof LfsLockError) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

describe("normalizeLockPath", () => {
  it("normalises and refuses", () => {
    expect(normalizeLockPath("./a//b/./c.bin")).toBe("a/b/c.bin");
    expect(normalizeLockPath("/top.psd")).toBe("top.psd");
    expect(normalizeLockPath("a\\b")).toBe("a\\b");
    for (const bad of ["", "/", ".", "../x", "a/../b", "a\0b", "a\nb", 5, undefined])
      expect(normalizeLockPath(bad), String(bad)).toBeUndefined();
  });
});

for (const [name, makeStore] of [
  ["memory", () => createMemoryLockStore()],
  ["files", () => createFilesLockStore(new MemFilesApi(), "repo.git")],
] as const) {
  describe(`locks over the ${name} store`, () => {
    it("create, conflict 409 with the existing lock, list, verify, unlock", async () => {
      const handler = server(makeStore());
      const ada = as(handler, "ada");
      const bob = as(handler, "bob");

      const lock = await ada.createLock("./assets//logo.psd", "refs/heads/main");
      expect(lock).toMatchObject({ path: "assets/logo.psd", owner: { name: "ada" } });
      expect(Number.isNaN(Date.parse(lock.locked_at))).toBe(false);

      const conflict = await rejection(bob.createLock("assets/logo.psd"));
      expect(conflict.status).toBe(409);
      expect(conflict.lock).toEqual(lock);
      expect(conflict.message).toMatch(/already created lock/);

      const other = await bob.createLock("b.bin");
      expect((await ada.listLocks()).locks.map((l) => l.path)).toEqual([
        "assets/logo.psd",
        "b.bin",
      ]);
      expect((await ada.listLocks({ path: "/assets/logo.psd" })).locks).toEqual([lock]);
      expect((await ada.listLocks({ id: other.id })).locks).toEqual([other]);
      expect((await ada.listLocks({ path: "../x" })).locks).toEqual([]);

      expect(await ada.verifyLocks({ ref: "refs/heads/main" })).toEqual({
        ours: [lock],
        theirs: [other],
      });
      expect(await bob.verifyLocks()).toEqual({ ours: [other], theirs: [lock] });

      // not the owner: 403, with or without force (no admin predicate)
      expect((await rejection(bob.unlock(lock.id))).status).toBe(403);
      expect((await rejection(bob.unlock(lock.id, { force: true }))).status).toBe(403);
      expect(await ada.unlock(lock.id)).toEqual(lock);
      expect((await rejection(ada.unlock(lock.id))).status).toBe(404);
      expect((await ada.listLocks()).locks).toEqual([other]);
      // locked again: a new id
      const again = await ada.createLock("assets/logo.psd");
      expect(again.id).not.toBe(lock.id);
    });

    it("force unlock needs the admin predicate", async () => {
      const handler = server(makeStore(), {
        admin: (request) => request.headers.get("authorization") === basic("root"),
      });
      const lock = await as(handler, "ada").createLock("x.bin");
      expect((await rejection(as(handler, "bob").unlock(lock.id, { force: true }))).status).toBe(
        403,
      );
      // the admin without force: still 403 (force says "I mean it")
      expect((await rejection(as(handler, "root").unlock(lock.id))).status).toBe(403);
      expect(await as(handler, "root").unlock(lock.id, { force: true })).toEqual(lock);
    });

    it("pages with opaque cursors: list and verify", async () => {
      const handler = server(makeStore(), { pageSize: 2 });
      const ada = as(handler, "ada");
      const bob = as(handler, "bob");
      const paths = ["e", "a", "d", "c", "b"];
      for (const [i, p] of paths.entries()) await (i % 2 ? bob : ada).createLock(`${p}.bin`);

      const first = await ada.listLocks({ limit: 50 }); // capped at the page size
      expect(first.locks.map((l) => l.path)).toEqual(["a.bin", "b.bin"]);
      expect(first.nextCursor).toBeTruthy();
      const second = await ada.listLocks({ cursor: first.nextCursor });
      expect(second.locks.map((l) => l.path)).toEqual(["c.bin", "d.bin"]);
      const third = await ada.listLocks({ cursor: second.nextCursor, limit: 1 });
      expect(third.locks.map((l) => l.path)).toEqual(["e.bin"]);
      expect(third.nextCursor).toBeUndefined();

      const all: string[] = [];
      for await (const l of ada.allLocks({ limit: 1 })) all.push(l.path);
      expect(all).toEqual(["a.bin", "b.bin", "c.bin", "d.bin", "e.bin"]);

      const ours: string[] = [];
      const theirs: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await ada.verifyLocks({ cursor, limit: 2 });
        ours.push(...page.ours.map((l) => l.path));
        theirs.push(...page.theirs.map((l) => l.path));
        cursor = page.nextCursor;
      } while (cursor);
      expect(ours.sort()).toEqual(["b.bin", "d.bin", "e.bin"]);
      expect(theirs.sort()).toEqual(["a.bin", "c.bin"]);
    });

    it("per ref: one lock per path and ref; refspec and ref select", async () => {
      const handler = server(makeStore(), { perRef: true });
      const ada = as(handler, "ada");
      const main = await ada.createLock("x.bin", "refs/heads/main");
      const dev = await ada.createLock("x.bin", "refs/heads/dev");
      expect(main.id).not.toBe(dev.id);
      expect((await rejection(ada.createLock("x.bin", "refs/heads/main"))).lock).toEqual(main);
      expect((await ada.listLocks({ refspec: "refs/heads/dev" })).locks).toEqual([dev]);
      expect((await ada.listLocks({ path: "x.bin" })).locks).toHaveLength(2);
      expect((await ada.listLocks({ path: "x.bin", refspec: "refs/heads/main" })).locks).toEqual([
        main,
      ]);
      expect((await ada.verifyLocks({ ref: "refs/heads/main" })).ours).toEqual([main]);
    });

    it("without perRef, refs are ignored", async () => {
      const handler = server(makeStore());
      const ada = as(handler, "ada");
      const lock = await ada.createLock("x.bin", "refs/heads/main");
      expect((await rejection(ada.createLock("x.bin", "refs/heads/dev"))).status).toBe(409);
      expect((await ada.listLocks({ refspec: "refs/heads/dev" })).locks).toEqual([lock]);
    });
  });
}

describe("lock routes: authorization, identity, errors", () => {
  it("authorize runs first, as download for a listing and upload for the rest", async () => {
    const calls: string[] = [];
    const handler = server(
      createMemoryLockStore(),
      {},
      {
        authorize: (request, op, lock) => {
          calls.push(`${op}:${lock}`);
          return request.headers.get("authorization") === basic("ada");
        },
      },
    );
    const anon = lfsLocks(URL_BASE, handler);
    const e = await rejection(anon.createLock("../bad"));
    expect(e.status).toBe(401); // not 422: nothing is answered before authorize
    expect(e.authenticate).toBe('Basic realm="Git LFS"');
    expect((await rejection(as(handler, "bob").listLocks())).status).toBe(403);
    const ada = as(handler, "ada");
    const lock = await ada.createLock("a.bin");
    await ada.listLocks();
    await ada.verifyLocks();
    await ada.unlock(lock.id);
    expect(calls).toEqual([
      "upload:create",
      "download:list",
      "upload:create",
      "download:list",
      "upload:verify",
      "upload:unlock",
    ]);
  });

  it("no identity is 401 with a challenge; identify picks the owner", async () => {
    const plain = server(createMemoryLockStore());
    const e = await rejection(lfsLocks(URL_BASE, plain).createLock("a.bin"));
    expect(e.status).toBe(401);
    expect(e.authenticate).toMatch(/^Basic/);
    // a listing needs no identity
    expect((await lfsLocks(URL_BASE, plain).listLocks()).locks).toEqual([]);

    const tokens = server(createMemoryLockStore(), {
      identify: (r) => (r.headers.get("x-token") === "t1" ? "carol" : undefined),
    });
    const carol = lfsLocks(URL_BASE, tokens, { headers: { "x-token": "t1" } });
    expect((await carol.createLock("a.bin")).owner).toEqual({ name: "carol" });
  });

  it("without the locks option every lock route is 404", async () => {
    const handler = serveLfs(createFilesLfsStore(new MemFilesApi()));
    const client = as(handler, "ada");
    expect((await rejection(client.createLock("a"))).status).toBe(404);
    expect((await rejection(client.listLocks())).status).toBe(404);
    expect((await rejection(client.verifyLocks())).status).toBe(404);
    expect((await rejection(client.unlock("1"))).status).toBe(404);
  });

  it("refuses malformed requests: 422 body or path, 400 limit, 406 accept, 405 method", async () => {
    const handler = server(createMemoryLockStore());
    const auth = { authorization: basic("ada"), "content-type": "application/vnd.git-lfs+json" };
    const post = (path: string, body: string, headers: Record<string, string> = auth) =>
      handler(new Request(`${URL_BASE}${path}`, { method: "POST", headers, body }));
    expect((await post("/locks", "not json")).status).toBe(422);
    expect((await post("/locks", JSON.stringify({ path: "a/../../b" }))).status).toBe(422);
    expect((await post("/locks", "x".repeat(20_000))).status).toBe(422);
    expect((await post("/locks/verify", JSON.stringify({ limit: -1 }))).status).toBe(422);
    const list = await handler(new Request(`${URL_BASE}/locks?limit=x`, { headers: auth }));
    expect(list.status).toBe(400);
    const res = await post("/locks", JSON.stringify({ path: "a" }), {
      ...auth,
      accept: "text/html",
    });
    expect(res.status).toBe(406);
    expect((await handler(new Request(`${URL_BASE}/locks`, { method: "PUT" }))).status).toBe(405);
    const ok = await post("/locks", JSON.stringify({ path: "a" }), {
      ...auth,
      "x-request-id": "r-1",
    });
    expect(ok.status).toBe(201);
    expect(ok.headers.get("content-type")).toBe("application/vnd.git-lfs+json");
    const dup = await post("/locks", JSON.stringify({ path: "a" }), {
      ...auth,
      "x-request-id": "r-2",
    });
    const body = (await dup.json()) as Record<string, unknown>;
    expect(dup.status).toBe(409);
    expect(body).toMatchObject({ message: "already created lock", request_id: "r-2" });
    expect(body.lock).toMatchObject({ path: "a", owner: { name: "ada" } });
  });

  it("the client sends credentials only to the endpoint's origin, also across redirects", async () => {
    const seen: { url: string; authorization: string | null; method: string }[] = [];
    const inner = server(createMemoryLockStore());
    const fetchImpl: FetchLike = async (request) => {
      seen.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        method: request.method,
      });
      const url = new URL(request.url);
      if (url.host === "lfs.test" && url.pathname.endsWith("/locks/verify"))
        return new Response(null, {
          status: 307,
          headers: { location: "http://elsewhere.test/v" },
        });
      if (url.host === "elsewhere.test")
        return new Response(null, {
          status: 308,
          headers: { location: `${URL_BASE}/locks/verify?back=1` },
        });
      return inner(request);
    };
    const client = lfsLocks(URL_BASE, fetchImpl, {
      credentials: { username: "ada", password: "pw" },
      headersFor: (href) =>
        href.startsWith("http://elsewhere.test") ? { "x-cdn": "1" } : undefined,
    });
    // the redirect back to the endpoint is not followed again (verify keeps redirecting)
    await expect(client.verifyLocks()).rejects.toThrow(/too many redirects/);
    const away = seen.filter((s) => s.url.startsWith("http://elsewhere.test"));
    expect(away.length).toBeGreaterThan(0);
    for (const s of away) expect(s.authorization).toBeNull();
    for (const s of seen.filter((x) => x.url.startsWith(URL_BASE)))
      expect(s.authorization).toBe(basic("ada"));
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["POST"]));
  });

  it("a non-JSON or malformed answer is an error, not a lock", async () => {
    const client = lfsLocks(URL_BASE, async () => new Response("<html>", { status: 200 }));
    await expect(client.listLocks()).rejects.toThrow(/not a JSON object/);
    const bad = lfsLocks(URL_BASE, async () => Response.json({ locks: [{ id: 1 }] }));
    await expect(bad.listLocks()).rejects.toThrow(/malformed locks/);
    const failing = lfsLocks(URL_BASE, async () => new Response("boom", { status: 500 }));
    const e = await rejection(failing.listLocks());
    expect(e.status).toBe(500);
    expect(e.message).toMatch(/500 boom/);
  });

  it("a store error is a generic 500", async () => {
    const store = createMemoryLockStore();
    store.list = async () => {
      throw new Error("db down: secret");
    };
    const e = await rejection(as(server(store), "ada").listLocks());
    expect(e.status).toBe(500);
    expect(e.message).not.toMatch(/secret/);
  });
});

describe("files lock store", () => {
  it("keeps one JSON file per lock under lfs/locks, readable by a second store", async () => {
    const files = new MemFilesApi();
    const a = createFilesLockStore(files, "repo.git");
    const { lock } = await a.create({ path: "x.bin", owner: { name: "ada" } });
    const names: string[] = [];
    for await (const info of files.list("repo.git/lfs/locks")) names.push(info.name);
    expect(names).toEqual([`${lock.id.slice(0, 24)}.json`]);
    const b = createFilesLockStore(files, "repo.git");
    expect(await b.get(lock.id)).toEqual(lock);
    expect(await b.get("nope")).toBeUndefined();
    expect((await b.create({ path: "x.bin", owner: { name: "bob" } })).created).toBe(false);
    expect(await b.remove(lock.id)).toEqual(lock);
    expect(await a.get(lock.id)).toBeUndefined();
  });

  it("concurrent creates of one path: exactly one wins", async () => {
    const files = new MemFilesApi();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createFilesLockStore(files).create({ path: "same.bin", owner: { name: `u${i}` } }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const winner = results.find((r) => r.created)?.lock;
    for (const r of results) expect(r.lock).toEqual(winner);
  });

  it("concurrent unlocks of one lock: exactly one removes it", async () => {
    const store = createFilesLockStore(new MemFilesApi());
    const { lock } = await store.create({ path: "x", owner: { name: "ada" } });
    const removed = await Promise.all(Array.from({ length: 5 }, () => store.remove(lock.id)));
    expect(removed.filter(Boolean)).toHaveLength(1);
  });
});
