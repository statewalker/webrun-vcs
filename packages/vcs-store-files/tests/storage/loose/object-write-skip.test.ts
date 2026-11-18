/**
 * P4.36: writing an object that is already there writes nothing, as git's write_object_file
 * (odb_freshen_object before write_loose_object): no temporary, no rename; an old copy has
 * its mtime renewed in place (utime). Concurrent writers of one object are safe, and small
 * loose objects are the bytes native git writes (zlib level 1).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitObjects } from "@statewalker/vcs-core";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import { createInMemoryFilesApi } from "@statewalker/vcs-utils/files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend } from "../../../src/create-git-files-backend.js";
import { filesStagingStore } from "../../../src/storage/loose/index.js";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, { cwd, input, env: GIT_ENV, encoding: "utf8" }).trim();

const enc = new TextEncoder();
const HOUR = 3600_000;
const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Counts the files a FilesApi creates (`write` and `createExclusive`) and its moves. */
function counting(files: FilesApi) {
  const counts = { created: 0, moved: 0, touched: 0 };
  const write = files.write.bind(files);
  files.write = (p, c) => {
    counts.created++;
    return write(p, c);
  };
  const createExclusive = files.createExclusive?.bind(files);
  if (createExclusive) {
    files.createExclusive = (p, c) => {
      counts.created++;
      return createExclusive(p, c);
    };
  }
  const move = files.move.bind(files);
  files.move = (a, b) => {
    counts.moved++;
    return move(a, b);
  };
  const touch = files.touch?.bind(files);
  if (touch) {
    files.touch = (p, t) => {
      counts.touched++;
      return touch(p, t);
    };
  }
  return counts;
}

function nodeStore() {
  const dir = tempDir("objwrite-");
  git(dir, ["init", "-q"]);
  const files = createNodeFilesApi({ rootDir: dir });
  const counts = counting(files);
  const store = filesStagingStore(files, ".git/objects");
  const objects = createGitObjects(store);
  const pathOf = (id: string) => join(dir, ".git/objects", id.slice(0, 2), id.slice(2));
  const age = (id: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    utimesSync(pathOf(id), t, t);
    return t.getTime();
  };
  const leftovers = () =>
    readdirSync(join(dir, ".git/objects"), { recursive: true }).filter((n) =>
      String(n).includes("tmp_obj_"),
    );
  return { dir, files, counts, store, objects, pathOf, age, leftovers };
}

/** A one-shot source that records whether it was read. */
function tracked(chunks: Uint8Array[]) {
  const state = { read: false, closed: false };
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          state.read = true;
          return i < chunks.length
            ? { done: false, value: chunks[i++] as Uint8Array }
            : { done: true, value: undefined };
        },
        async return() {
          state.closed = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { source, state };
}

describe("P4.36: a write of an object already stored writes nothing", () => {
  it("a young loose copy: no temporary, no rename, its mtime renewed as git's utime does on every write", async () => {
    const s = nodeStore();
    const bytes = enc.encode("written twice\n");
    const id = await s.objects.put("blob", bytes.length, [bytes]);
    s.age(id, 10 * 60_000);
    const ino = statSync(s.pathOf(id)).ino;
    const before = { ...s.counts };
    expect(await s.objects.put("blob", bytes.length, [bytes])).toBe(id);
    expect(s.counts).toEqual({ ...before, touched: before.touched + 1 });
    expect(statSync(s.pathOf(id)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    expect(statSync(s.pathOf(id)).ino).toBe(ino);
  });

  it("an old loose copy is touched in place (git's freshen_loose_object), not rewritten", async () => {
    const s = nodeStore();
    const bytes = enc.encode("written long ago\n");
    const id = await s.objects.put("blob", bytes.length, [bytes]);
    s.age(id, 21 * 24 * HOUR);
    const ino = statSync(s.pathOf(id)).ino;
    const stored = readFileSync(s.pathOf(id));
    const before = { ...s.counts };
    expect(await s.objects.put("blob", bytes.length, [bytes])).toBe(id);
    expect(s.counts.created).toBe(before.created);
    expect(s.counts.moved).toBe(before.moved);
    expect(s.counts.touched).toBe(before.touched + 1);
    expect(statSync(s.pathOf(id)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    expect(statSync(s.pathOf(id)).ino).toBe(ino);
    expect(readFileSync(s.pathOf(id)).equals(stored)).toBe(true);
  });

  it("putRaw of a stored object reads nothing of its source and writes nothing", async () => {
    const s = nodeStore();
    const body = enc.encode("unpacked again\n");
    const raw = [enc.encode(`blob ${body.length}\0`), body];
    const id = await s.objects.put("blob", body.length, [body]);
    const before = { ...s.counts };
    const { source, state } = tracked(raw);
    await s.objects.putRaw(id, source);
    expect(state.read).toBe(false);
    expect(state.closed).toBe(true);
    expect(s.counts).toEqual({ ...before, touched: before.touched + 1 });
  });

  it("a streamed write of a stored object leaves the stored file and no temporary behind", async () => {
    const s = nodeStore();
    const body = enc.encode("streamed twice\n");
    const id = await s.objects.put("blob", body.length, [body]);
    const ino = statSync(s.pathOf(id)).ino;
    const before = { ...s.counts };
    // a stream (not an array): its id is known only once hashed, so it is staged, then dropped
    const again = await s.objects.put(
      "blob",
      body.length,
      (async function* () {
        yield body;
      })(),
    );
    expect(again).toBe(id);
    expect(s.counts.moved).toBe(before.moved);
    expect(statSync(s.pathOf(id)).ino).toBe(ino);
    expect(s.leftovers()).toEqual([]);
  });

  it("the in-memory FilesApi: a stored copy is touched, young or old", async () => {
    const files = createInMemoryFilesApi();
    const counts = counting(files);
    const objects = createGitObjects(filesStagingStore(files, "/repo/.git/objects"));
    const bytes = enc.encode("in memory\n");
    const id = await objects.put("blob", bytes.length, [bytes]);
    const path = `/repo/.git/objects/${id.slice(0, 2)}/${id.slice(2)}`;
    const before = { ...counts };
    await objects.put("blob", bytes.length, [bytes]);
    expect(counts).toEqual({ ...before, touched: before.touched + 1 });
    const old = Date.now() - 2 * HOUR;
    expect(await files.touch?.(path, old)).toBe(true);
    expect((await files.stats(path))?.lastModified).toBe(old);
    await objects.put("blob", bytes.length, [bytes]);
    expect(counts.created).toBe(before.created);
    expect(counts.touched).toBe(before.touched + 3);
    expect((await files.stats(path))?.lastModified).toBeGreaterThan(Date.now() - 60_000);
  });

  it("where the FilesApi cannot set times, an old copy is replaced by the same bytes", async () => {
    const s = nodeStore();
    (s.files as { touch?: unknown }).touch = undefined;
    const objects = createGitObjects(filesStagingStore(s.files, ".git/objects"));
    const bytes = enc.encode("no utime here\n");
    const id = await objects.put("blob", bytes.length, [bytes]);
    s.age(id, 21 * 24 * HOUR);
    await objects.put("blob", bytes.length, [bytes]);
    expect(statSync(s.pathOf(id)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    expect(s.leftovers()).toEqual([]);
    expect(git(s.dir, ["cat-file", "-p", id])).toBe("no utime here");
  });
});

describe("P4.36: concurrent writers of one object", () => {
  it("in memory and streamed, all land on one sound object and leave no temporary", async () => {
    const s = nodeStore();
    const body = enc.encode("raced\n".repeat(1000));
    const writes: Promise<string>[] = [];
    for (let i = 0; i < 16; i++) {
      writes.push(s.objects.put("blob", body.length, [body]));
      writes.push(
        s.objects.put(
          "blob",
          body.length,
          (async function* () {
            yield body.subarray(0, 100);
            yield body.subarray(100);
          })(),
        ),
      );
      const id = blobId(body);
      writes.push(s.objects.putRaw(id, [enc.encode(`blob ${body.length}\0`), body]).then(() => id));
    }
    const ids = new Set(await Promise.all(writes));
    expect(ids.size).toBe(1);
    const [id] = [...ids] as [string];
    expect(s.leftovers()).toEqual([]);
    expect(git(s.dir, ["cat-file", "-t", id])).toBe("blob");
    git(s.dir, ["fsck", "--strict", "--no-dangling"]);
    expect((await s.objects.get(id, { verify: true }))?.size).toBe(body.length);
  });

  it("two stores over one directory (two processes) race safely", async () => {
    const s = nodeStore();
    const other = createGitObjects(
      filesStagingStore(createNodeFilesApi({ rootDir: s.dir }), ".git/objects", {
        cacheDirectoryChecks: true,
      }),
    );
    const bodies = Array.from({ length: 50 }, (_, i) => enc.encode(`shared ${i}\n`));
    const a = Promise.all(bodies.map((b) => s.objects.put("blob", b.length, [b])));
    const b = Promise.all(bodies.map((x) => other.put("blob", x.length, [x])));
    const [ia, ib] = await Promise.all([a, b]);
    expect(ia).toEqual(ib);
    expect(s.leftovers()).toEqual([]);
    git(s.dir, ["fsck", "--strict", "--no-dangling"]);
  });
});

describe("P4.36: loose objects as native git writes them", () => {
  it("a small object is byte for byte git's loose file (zlib level 1)", async () => {
    const s = nodeStore();
    const native = tempDir("objwrite-native-");
    git(native, ["init", "-q"]);
    for (const text of ["hello\n", "", "x".repeat(5000), "line\n".repeat(3000)]) {
      const bytes = enc.encode(text);
      const id = await s.objects.put("blob", bytes.length, [bytes]);
      expect(git(native, ["hash-object", "-w", "--stdin"], text)).toBe(id);
      const theirs = readFileSync(join(native, ".git/objects", id.slice(0, 2), id.slice(2)));
      expect(readFileSync(s.pathOf(id)).equals(theirs)).toBe(true);
    }
  });
});

describe("P4.36: the files backend's cached directory checks", () => {
  it("a fan-out directory removed behind its back (a prune) is made again", async () => {
    const dir = tempDir("objwrite-backend-");
    git(dir, ["init", "-q"]);
    const files = createNodeFilesApi({ rootDir: dir });
    const { history } = await createGitFilesBackend({ files });
    const first = await history.blobs.store([enc.encode("first\n")]);
    const fanout = join(dir, ".git/objects", first.slice(0, 2));
    rmSync(join(fanout, first.slice(2)));
    rmdirSync(fanout);
    expect(await history.blobs.store([enc.encode("first\n")])).toBe(first);
    expect(git(dir, ["cat-file", "-p", first])).toBe("first");
    // and objects/ itself
    rmSync(join(dir, ".git/objects"), { recursive: true, force: true });
    const second = await history.blobs.store([enc.encode("second\n")]);
    expect(git(dir, ["cat-file", "-p", second])).toBe("second");
  });
});

/** git's id of a blob. */
function blobId(body: Uint8Array): string {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
    .digest("hex");
}

describe("P4.36: an object held only by a cruft pack", () => {
  const IDENT = {
    GIT_AUTHOR_NAME: "A",
    GIT_AUTHOR_EMAIL: "a@example.com",
    GIT_COMMITTER_NAME: "A",
    GIT_COMMITTER_EMAIL: "a@example.com",
  };
  // git's freshen_packed_object refuses cruft packs (`is_cruft`): their objects expire by
  // `.mtimes`, which touching the pack does not renew, so the write must land loose
  for (const packAge of [2 * HOUR, 0]) {
    it(`is written loose and survives gc --cruft (pack ${packAge ? "old" : "young"})`, async () => {
      const dir = tempDir("objwrite-cruft-");
      git(dir, ["init", "-q"]);
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "base"], {
        cwd: dir,
        env: { ...GIT_ENV, ...IDENT },
      });
      const text = "unreachable, then written again\n";
      const id = git(dir, ["hash-object", "-w", "--stdin"], text);
      const loose = join(dir, ".git/objects", id.slice(0, 2), id.slice(2));
      const old = new Date(Date.now() - 21 * 24 * HOUR);
      utimesSync(loose, old, old);
      git(dir, ["repack", "--cruft", "-d", "--cruft-expiration=never"]);
      git(dir, ["prune-packed"]);
      const packDir = join(dir, ".git/objects/pack");
      expect(readdirSync(packDir).some((n) => n.endsWith(".mtimes"))).toBe(true);
      expect(() => statSync(loose)).toThrow();
      if (packAge) {
        const t = new Date(Date.now() - packAge);
        for (const n of readdirSync(packDir)) utimesSync(join(packDir, n), t, t);
      }
      const { history } = await createGitFilesBackend({
        files: createNodeFilesApi({ rootDir: dir }),
      });
      expect(await history.blobs.store([enc.encode(text)])).toBe(id);
      expect(statSync(loose).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
      git(dir, ["gc", "--cruft", "--prune=1.week.ago"]);
      expect(git(dir, ["cat-file", "-p", id])).toBe(text.trim());
    });
  }
});
