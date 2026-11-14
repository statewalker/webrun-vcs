/**
 * repack (`git repack -a -d` / `-d`) and gc over the pack set: one streamed pack of everything
 * reachable, `.keep` packs honoured, loose-only mode, the prune grace period, install before
 * remove, and bounded memory for a large blob.
 */
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryFilesApi,
  type FilesApi,
  type GitObjects,
  joinPath,
  type ObjectId,
} from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend, gc, listReachableObjects, repack } from "../src/index.js";

const enc = new TextEncoder();
const PACK_DIR = joinPath(".git", "objects", "pack");

type Backend = Awaited<ReturnType<typeof createGitFilesBackend>>;

async function open(files: FilesApi = createInMemoryFilesApi(), create = true) {
  return createGitFilesBackend({ files, create });
}

let clock = 1_700_000_000;
/** A commit on `branch` adding `name` with `content` to the previous tree of that branch. */
async function commit(b: Backend, branch: string, name: string, content: string) {
  const { history } = b;
  const prev = await history.refs.resolve(`refs/heads/${branch}`);
  const parents = prev?.objectId ? [prev.objectId] : [];
  const entries: { name: string; mode: number; id: ObjectId }[] = [];
  if (prev?.objectId) {
    const c = await history.commits.load(prev.objectId);
    for await (const e of (await history.trees.load(c?.tree ?? "")) ?? []) entries.push(e);
  }
  const blob = await history.blobs.store([enc.encode(content)]);
  entries.push({ name, mode: 0o100644, id: blob });
  entries.sort((x, y) => (x.name < y.name ? -1 : 1));
  const tree = await history.trees.store(entries);
  const who = { name: "T", email: "t@t", timestamp: clock++, tzOffset: "+0000" };
  const id = await history.commits.store({
    tree,
    parents,
    author: who,
    committer: who,
    message: `${name}\n`,
  });
  await history.refs.set(`refs/heads/${branch}`, id);
  return { commit: id, blob, tree };
}

async function bytes(objects: GitObjects, id: ObjectId) {
  const o = await objects.get(id);
  if (!o) return undefined;
  const parts: Uint8Array[] = [];
  for await (const c of o.content) parts.push(c);
  return { type: o.type, data: Buffer.concat(parts).toString("hex") };
}

const packNames = async (files: FilesApi, ext: string) => {
  const out: string[] = [];
  if (!(await files.exists(PACK_DIR))) return out;
  for await (const e of files.list(PACK_DIR)) if (e.name.endsWith(ext)) out.push(e.name);
  return out.sort();
};

const reachableIds = async (b: Backend) =>
  (await listReachableObjects({ files: b.files, refs: b.history.refs, objects: b.objects }))
    .map((o) => o.id)
    .sort();

describe("repack -a -d", () => {
  it("writes one pack holding every reachable object, byte-exact, and removes old packs and loose objects", async () => {
    const b = await open();
    await commit(b, "main", "a.txt", "first\n".repeat(50));
    await repack({ ...b, all: false }); // pack A
    await commit(b, "main", "b.txt", "second\n".repeat(50));
    await repack({ ...b, all: false }); // pack B
    await commit(b, "topic", "c.txt", "third\n"); // loose
    const orphan = await b.history.blobs.store([enc.encode("unreachable\n")]);
    expect((await packNames(b.files, ".pack")).length).toBe(2);

    const ids = await reachableIds(b);
    const before = new Map<string, unknown>();
    for (const id of ids) before.set(id, await bytes(b.objects, id));

    const result = await repack(b);

    expect(result?.objectCount).toBe(ids.length);
    expect(result?.packsRemoved.length).toBe(2);
    expect(await packNames(b.files, ".pack")).toEqual([`${result?.packName}.pack`]);
    expect(await packNames(b.files, ".idx")).toEqual([`${result?.packName}.idx`]);
    const [pack] = await b.packs.packs();
    expect([...(pack?.ids() ?? [])].sort()).toEqual(ids);
    // every reachable object reads back with the same type and bytes, from a fresh backend
    const fresh = await open(b.files, false);
    for (const id of ids) expect(await bytes(fresh.objects, id)).toEqual(before.get(id));
    // reachable loose copies are gone; the unreachable one is left for gc
    for (const id of ids) expect(await b.looseStorage.has(id)).toBe(false);
    expect(await b.looseStorage.has(orphan)).toBe(true);
  });

  it("keeps .keep packs and leaves their objects out of the new pack", async () => {
    const b = await open();
    await commit(b, "main", "a.txt", "kept\n".repeat(40));
    const kept = await repack({ ...b, all: false });
    const keepFile = joinPath(PACK_DIR, `${kept?.packName}.keep`);
    await b.files.write(keepFile, [enc.encode("keep\n")]);
    const keptIds = new Set((await b.packs.packs())[0]?.ids());
    await commit(b, "main", "b.txt", "more\n".repeat(40));
    await repack({ ...b, all: false }); // a second, removable pack
    await commit(b, "main", "c.txt", "loose\n"); // so the new pack differs from the second

    const result = await repack(b);

    expect(result?.keptPacks).toEqual([kept?.packName]);
    expect(result?.packsRemoved.length).toBe(1);
    expect(await b.files.exists(keepFile)).toBe(true);
    expect(await packNames(b.files, ".pack")).toEqual(
      [`${kept?.packName}.pack`, `${result?.packName}.pack`].sort(),
    );
    const newPack = (await b.packs.packs()).find((p) => `pack-${p.packId}` === result?.packName);
    for (const id of newPack?.ids() ?? []) expect(keptIds.has(id)).toBe(false);
    const fresh = await open(b.files, false);
    for (const id of await reachableIds(b)) expect(await fresh.objects.has(id)).toBe(true);
  });
});

describe("repack -d (loose only)", () => {
  it("packs only the reachable loose objects and leaves existing packs alone", async () => {
    const b = await open();
    await commit(b, "main", "a.txt", "packed\n");
    const first = await repack({ ...b, all: false });
    const second = await commit(b, "main", "b.txt", "loose\n");
    const orphan = await b.history.blobs.store([enc.encode("orphan\n")]);

    const result = await repack({ ...b, all: false });

    // the new commit, its tree and its blob; nothing already packed
    expect(result?.objectCount).toBe(3);
    expect(result?.packsRemoved).toEqual([]);
    expect(await packNames(b.files, ".pack")).toEqual(
      [`${first?.packName}.pack`, `${result?.packName}.pack`].sort(),
    );
    for (const id of [second.commit, second.tree, second.blob])
      expect(await b.looseStorage.has(id)).toBe(false);
    expect(await b.looseStorage.has(orphan)).toBe(true);
    // nothing loose and reachable left: nothing to do
    expect(await repack({ ...b, all: false })).toBeNull();
  });
});

describe("gc", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("prunes unreachable loose objects older than the grace period, keeps younger ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-prune-"));
    dirs.push(dir);
    const files = createNodeFilesApi({ rootDir: dir });
    const b = await open(files);
    await commit(b, "main", "a.txt", "reachable\n");
    const old = await b.history.blobs.store([enc.encode("old garbage\n")]);
    const young = await b.history.blobs.store([enc.encode("young garbage\n")]);
    const t = new Date(Date.now() - 15 * 24 * 3600_000);
    utimesSync(join(dir, ".git/objects", old.slice(0, 2), old.slice(2)), t, t);

    const result = await gc({ history: b.history, files });

    expect(result.removedObjects).toBe(1);
    expect(result.keptRecentObjects).toBe(1);
    expect(await b.looseStorage.has(old)).toBe(false);
    expect(await b.looseStorage.has(young)).toBe(true);
    // the reachable objects are in one pack now
    expect(result.repack?.objectCount).toBe(3);
    expect(await packNames(files, ".pack")).toEqual([`${result.repack?.packName}.pack`]);
    // a shorter grace period removes the young one too
    const now = await gc({ history: b.history, files, pruneExpireMs: 0 });
    expect(now.removedObjects).toBe(1);
    expect(await b.looseStorage.has(young)).toBe(false);
  });

  it("keeps objects reachable only from a reflog or the index", async () => {
    const b = await open();
    const { commit: dropped } = await commit(b, "main", "a.txt", "in the reflog\n");
    await b.files.mkdir(".git/logs/refs/heads");
    await b.files.write(".git/logs/refs/heads/main", [
      enc.encode(`${"0".repeat(40)} ${dropped} T <t@t> 1700000000 +0000\tcommit: a\n`),
    ]);
    await b.history.refs.remove("refs/heads/main");
    const result = await gc({ history: b.history, files: b.files, pruneExpireMs: 0 });
    expect(result.removedObjects).toBe(0);
    expect(await b.objects.has(dropped)).toBe(true);
  });
});

describe("repack is safe for concurrent readers", () => {
  it("installs the new pack before it removes anything", async () => {
    const files = createInMemoryFilesApi();
    const b = await open(files);
    await commit(b, "main", "a.txt", "one\n");
    await repack({ ...b, all: false });
    await commit(b, "main", "b.txt", "two\n");
    await repack({ ...b, all: false });
    await commit(b, "main", "c.txt", "three\n"); // loose
    const ids = await reachableIds(b);
    // a reader opened before the repack, holding the old packs
    const early = await open(files, false);
    for (const id of ids) expect(await early.objects.has(id)).toBe(true);

    let checks = 0;
    const missing: string[] = [];
    const remove = files.remove.bind(files);
    files.remove = async (path) => {
      if (
        /pack-[0-9a-f]{40}\.idx$/.test(path) ||
        /objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(path)
      ) {
        checks++;
        // what any reader opening now finds on storage
        const reader = await open(files, false);
        for (const id of ids) if (!(await reader.objects.get(id))) missing.push(id);
      }
      return remove(path);
    };
    await repack(b);
    files.remove = remove;

    expect(checks).toBeGreaterThan(0);
    expect(missing).toEqual([]);
    for (const id of ids) expect(await bytes(early.objects, id)).toBeDefined();
  });
});

describe("repack memory is bounded", () => {
  /** xorshift bytes, generated chunk by chunk: deterministic and incompressible */
  async function* noise(total: number, chunk = 1 << 20) {
    let x = 0x2545f491;
    for (let at = 0; at < total; at += chunk) {
      const out = new Uint8Array(Math.min(chunk, total - at));
      const words = new Uint32Array(out.buffer, 0, out.length >>> 2);
      for (let i = 0; i < words.length; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        words[i] = x >>> 0;
      }
      yield out;
    }
  }

  it("streams a 60 MiB blob through repack without holding the pack", async () => {
    const SIZE = 60 * 2 ** 20;
    const files = createInMemoryFilesApi();
    const b = await open(files);
    const blob = await b.objects.put("blob", SIZE, noise(SIZE));
    const tree = await b.history.trees.store([{ name: "big.bin", mode: 0o100644, id: blob }]);
    const who = { name: "T", email: "t@t", timestamp: 1, tzOffset: "+0000" };
    const c = await b.history.commits.store({
      tree,
      parents: [],
      author: who,
      committer: who,
      message: "big\n",
    });
    await b.history.refs.set("refs/heads/main", c);

    // the largest chunk written into the pack directory, and the bytes written there
    let largest = 0;
    let packBytes = 0;
    const write = files.write.bind(files);
    files.write = (path, content) => {
      if (!path.startsWith(PACK_DIR)) return write(path, content);
      return write(
        path,
        (async function* () {
          for await (const chunk of content) {
            largest = Math.max(largest, chunk.length);
            packBytes += chunk.length;
            yield chunk;
          }
        })(),
      );
    };
    const result = await repack(b);
    files.write = write;

    expect(result?.objectCount).toBe(3);
    expect(packBytes).toBeGreaterThan(SIZE);
    expect(largest).toBeLessThan(4 * 2 ** 20);
    expect((await bytes(b.objects, blob))?.data.length).toBe(SIZE * 2);
  }, 120_000);
});
