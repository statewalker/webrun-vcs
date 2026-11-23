/**
 * gc and repack under concurrent writers (statewalker-root#286), after JGit's GcConcurrentTest
 * and ConcurrentRepackTest and git's t6500-gc.sh and t5304-prune.sh. Every interleaving is
 * deterministic: a writer runs from a hook the test injects (a FilesApi proxy, an overlaid ref
 * listing or pack set), never from a timing race.
 *
 * - The gc lock: git's `lock_repo_for_gc` (`gc.pid` written as `<pid> <host>` under
 *   `gc.pid.lock`, held while young and of another host or a running process, `--force`).
 * - Objects written while gc runs (loose, in a pack installed meanwhile, an old object
 *   freshened by a write after gc judged it expired) are still there afterwards.
 */
import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FilesApi,
  joinPath,
  type ObjectId,
  type PackSet,
  writePack,
} from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend, FileGcStrategy, gc } from "../src/index.js";

const enc = new TextEncoder();
const DAY = 24 * 3600_000;
type Backend = Awaited<ReturnType<typeof createGitFilesBackend>>;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A repository on disk (file times matter here). */
async function repository(wrap: (files: FilesApi) => FilesApi = (f) => f) {
  const dir = mkdtempSync(join(tmpdir(), "gc-concurrency-"));
  dirs.push(dir);
  const files = wrap(createNodeFilesApi({ rootDir: dir }));
  const b = await createGitFilesBackend({ files, create: true });
  return { dir, files, b };
}

let clock = 1_700_000_000;
/** A commit on `branch` adding `name` with `content` to the branch's tree. */
async function commit(b: Backend, branch: string, name: string, content: string, update = true) {
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
  if (update) await history.refs.set(`refs/heads/${branch}`, id);
  return { commit: id, blob, tree };
}

/** Sets the mtime of a file of the repository `ms` ago. */
function age(dir: string, path: string, ms: number) {
  const t = new Date(Date.now() - ms);
  utimesSync(join(dir, path), t, t);
}
const loosePath = (id: string) => `.git/objects/${id.slice(0, 2)}/${id.slice(2)}`;

/** Every object a fresh backend over the same files can read. */
async function readable(files: FilesApi, ids: readonly ObjectId[]) {
  const fresh = await createGitFilesBackend({ files });
  const out: Record<string, boolean> = {};
  for (const id of ids) out[id] = await fresh.objects.has(id);
  return out;
}
/** `target` with some members replaced (bound methods otherwise). */
function overlay<T extends object>(target: T, override: Partial<T>): T {
  return new Proxy(target, {
    get(t, k) {
      if (k in override) return (override as Record<PropertyKey, unknown>)[k];
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

const all = (ids: readonly ObjectId[]) => Object.fromEntries(ids.map((id) => [id, true]));

/** A host environment whose `gcProcess` is given (pid, host, which pids run). */
function host(pid: number, hostName: string, running: (pid: number) => boolean) {
  return {
    readFile: async () => undefined,
    gcProcess: { pid, hostName, isRunning: running },
  } satisfies GitHostEnvironment;
}

async function text(files: FilesApi, path: string) {
  const parts: Uint8Array[] = [];
  for await (const c of files.read(path)) parts.push(c);
  return Buffer.concat(parts).toString();
}

describe("t6500-gc: the gc lock (lock_repo_for_gc)", () => {
  it("writes `<pid> <host>` into gc.pid while it runs, through gc.pid.lock, and removes it", async () => {
    const { files, b } = await repository();
    await commit(b, "main", "a.txt", "a\n");
    let during: { pid?: string; lock: boolean } | undefined;
    const result = await gc({
      history: b.history,
      files,
      environment: host(4321, "here", () => true),
      packRefsStep: async () => {
        during = {
          pid: await text(files, ".git/gc.pid"),
          lock: await files.exists(".git/gc.pid.lock"),
        };
      },
    });
    expect(result.skipped).toBe(false);
    // git writes "%"PRIuMAX" %s" without a newline
    expect(during).toEqual({ pid: "4321 here", lock: false });
    expect(await files.exists(".git/gc.pid")).toBe(false);
    expect(await files.exists(".git/gc.pid.lock")).toBe(false);
  });

  it("is skipped while a young gc.pid names another host, whatever its pid", async () => {
    const { files, b } = await repository();
    await commit(b, "main", "a.txt", "a\n");
    await files.write(".git/gc.pid", [enc.encode("12345 elsewhere")]);
    const result = await gc({
      history: b.history,
      files,
      environment: host(1, "here", () => false),
    });
    expect(result).toMatchObject({
      skipped: true,
      lockHolder: { machine: "elsewhere", pid: 12345 },
    });
    expect(await text(files, ".git/gc.pid")).toBe("12345 elsewhere");
    expect(await files.exists(".git/gc.pid.lock")).toBe(false);
  });

  it("is skipped while a gc.pid of this host names a running process, takes over a dead one's", async () => {
    const { files, b } = await repository();
    await commit(b, "main", "a.txt", "a\n");
    await files.write(".git/gc.pid", [enc.encode("777 here\n")]);
    const alive = await gc({ history: b.history, files, environment: host(1, "here", () => true) });
    expect(alive).toMatchObject({ skipped: true, lockHolder: { machine: "here", pid: 777 } });
    const checked: number[] = [];
    const dead = await gc({
      history: b.history,
      files,
      environment: host(1, "here", (pid) => {
        checked.push(pid);
        return false;
      }),
    });
    expect(dead.skipped).toBe(false);
    expect(checked).toEqual([777]);
    expect(await files.exists(".git/gc.pid")).toBe(false);
  });

  it("without the process's identity, a young gc.pid of any host is held", async () => {
    const { files, b } = await repository();
    await commit(b, "main", "a.txt", "a\n");
    await files.write(".git/gc.pid", [enc.encode("0 unknown")]);
    expect((await gc({ history: b.history, files })).skipped).toBe(true);
  });

  it("takes over a gc.pid that does not read `<pid> <host>` (fscanf fails), and one older than 12 hours", async () => {
    const { dir, files, b } = await repository();
    await commit(b, "main", "a.txt", "a\n");
    await files.write(".git/gc.pid", [enc.encode("garbage\n")]);
    expect((await gc({ history: b.history, files })).skipped).toBe(false);
    await files.write(".git/gc.pid", [enc.encode("12345 elsewhere")]);
    age(dir, ".git/gc.pid", 12 * 3600_000 + 60_000);
    expect((await gc({ history: b.history, files })).skipped).toBe(false);
    expect(await files.exists(".git/gc.pid")).toBe(false);
  });

  it("--force runs while another gc holds gc.pid", async () => {
    const { files, b } = await repository();
    await commit(b, "main", "a.txt", "a\n");
    await files.write(".git/gc.pid", [enc.encode("12345 elsewhere")]);
    const result = await gc({ history: b.history, files, force: true });
    expect(result.skipped).toBe(false);
    expect(result.repack).not.toBeNull();
  });

  it("is skipped while gc.pid.lock exists (git dies on it), --force too, and leaves it", async () => {
    const { files, b } = await repository();
    await commit(b, "main", "a.txt", "a\n");
    await files.write(".git/gc.pid.lock", [enc.encode("")]);
    for (const force of [false, true]) {
      const result = await gc({ history: b.history, files, force });
      expect(result).toMatchObject({ skipped: true, lockFileExists: true });
    }
    expect(await files.exists(".git/gc.pid.lock")).toBe(true);
    expect(await files.exists(".git/gc.pid")).toBe(false);
  });

  it("JGit GcConcurrentTest.concurrentRepack: a gc started inside another is skipped, nothing is lost", async () => {
    const { files, b } = await repository();
    const ids: ObjectId[] = [];
    for (const n of ["a", "b", "c"]) {
      const c = await commit(b, "main", `${n}.txt`, `${n}\n`);
      ids.push(c.commit, c.tree, c.blob);
    }
    let inner: Awaited<ReturnType<typeof gc>> | undefined;
    const outer = await gc({
      history: b.history,
      files,
      beforeObjects: async () => {
        inner = await gc({ history: b.history, files });
      },
    });
    expect(outer.skipped).toBe(false);
    expect(inner?.skipped).toBe(true);
    expect(await readable(files, ids)).toEqual(all(ids));
  });
});

describe("objects written while gc runs survive it (JGit ConcurrentRepackTest, t5304-prune)", () => {
  it("ConcurrentRepackTest: a commit written loose during the walk, its ref moved after, is kept and packed by the next gc", async () => {
    const { files, b } = await repository();
    await commit(b, "main", "a.txt", "a\n");
    const refs = b.history.refs;
    let written: Awaited<ReturnType<typeof commit>> | undefined;
    const list = async function* (prefix?: string) {
      for await (const r of refs.list(prefix)) yield r;
      if (written) return;
      // another process commits now: its objects land loose, its ref after the walk
      const other = await createGitFilesBackend({ files });
      written = await commit(other, "main", "b.txt", "written during gc\n", false);
    };
    const history = overlay(b.history, { refs: overlay(refs, { list }) });
    const first = await gc({ history, files, packs: b.packs, expireReflogs: false });
    expect(first.skipped).toBe(false);
    const ids = [written?.commit, written?.tree, written?.blob] as ObjectId[];
    expect(await readable(files, ids)).toEqual(all(ids));
    // the writer's ref update lands; the next gc packs what it reaches
    await refs.set("refs/heads/main", written?.commit as ObjectId);
    await gc({ history: b.history, files });
    expect(await readable(files, ids)).toEqual(all(ids));
    for (const id of ids) expect(await files.exists(loosePath(id))).toBe(false);
  });

  it("t5304-prune: an expired loose object written again between prune's check and its unlink stays", async () => {
    // the prune stats each loose object, walks, then unlinks: a write in between freshens
    // the file (odb_freshen_object), and the unlink must see it
    let armed = false;
    let fired = false;
    let blobPath = "";
    let writer: (() => Promise<void>) | undefined;
    const { dir, files, b } = await repository((base) => {
      return new Proxy(base, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === "move")
            return async (source: string, path: string) => {
              const moved = await target.move(source, path);
              // update-server-info: the repack is over, the prune comes next
              if (path.endsWith("objects/info/packs")) armed = true;
              return moved;
            };
          if (prop === "stats")
            return async (path: string) => {
              const st = await target.stats(path);
              if (armed && !fired && path.replace(/^\//, "") === blobPath && writer) {
                fired = true;
                await writer();
              }
              return st;
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    await commit(b, "main", "a.txt", "a\n");
    const old = await b.history.blobs.store([enc.encode("old and unreachable\n")]);
    blobPath = loosePath(old);
    age(dir, blobPath, 30 * DAY);
    writer = async () => {
      // a commit naming the old blob again: its write finds the blob stored, renews it
      const other = await createGitFilesBackend({ files });
      await other.history.blobs.store([enc.encode("old and unreachable\n")]);
      const tree = await other.history.trees.store([{ name: "old.txt", mode: 0o100644, id: old }]);
      const who = { name: "T", email: "t@t", timestamp: clock++, tzOffset: "+0000" };
      const id = await other.history.commits.store({
        tree,
        parents: [],
        author: who,
        committer: who,
        message: "names the old blob\n",
      });
      await other.history.refs.set("refs/heads/revived", id);
    };
    const result = await gc({ history: b.history, files, cruftPacks: false });
    expect(fired).toBe(true);
    expect(result.removedObjects).toBe(0);
    expect(await readable(files, [old])).toEqual(all([old]));
    expect(statSync(join(dir, blobPath)).mtimeMs).toBeGreaterThan(Date.now() - DAY);
  });

  it("t6501-freshen-objects: an old pack whose object is written again after the repack listed it is not removed", async () => {
    const { dir, files, b } = await repository();
    await commit(b, "main", "a.txt", "a\n");
    // an old pack holding an unreachable blob, past every expiry
    const gone = await b.history.blobs.store([enc.encode("unreachable, in an old pack\n")]);
    const packed = await b.packs.install(writePack(b.objects, [{ id: gone, type: "blob" }]));
    await b.looseStorage.remove(gone);
    for (const ext of [".pack", ".idx", ".rev"]) {
      const p = `.git/objects/pack/pack-${packed.packId}${ext}`;
      if (await files.exists(p)) age(dir, p, 30 * DAY);
    }
    // a young unreachable object: the gc writes a cruft pack, after the packs to remove are
    // chosen
    await b.history.blobs.store([enc.encode("young and unreachable\n")]);
    let installs = 0;
    let revived = false;
    const packs: PackSet = overlay(b.packs, {
      install: async (...args: Parameters<PackSet["install"]>) => {
        const installed = await b.packs.install(...args);
        // the second install is the cruft pack: a writer stores the old blob now, which
        // freshens its pack (freshen_packed_object)
        if (++installs === 2) {
          const other = await createGitFilesBackend({ files });
          await other.history.blobs.store([enc.encode("unreachable, in an old pack\n")]);
          revived = true;
        }
        return installed;
      },
    });
    const result = await gc({ history: b.history, files, packs, expireReflogs: false });
    expect(revived).toBe(true);
    expect(result.repack?.cruftPacks?.length).toBe(1);
    expect(result.repack?.packsRemoved).not.toContain(`pack-${packed.packId}`);
    expect(await readable(files, [gone])).toEqual(all([gone]));
  });

  it("t5304-prune: a pack installed during gc (a fetch) keeps the old loose objects it names", async () => {
    let armed = false;
    let fetch: (() => Promise<void>) | undefined;
    const { dir, files, b } = await repository((base) => {
      return new Proxy(base, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === "move")
            return async (source: string, path: string) => {
              const moved = await target.move(source, path);
              // update-server-info: the repack is over; a fetch lands before the prune
              if (path.endsWith("objects/info/packs") && !armed && fetch) {
                armed = true;
                await fetch();
              }
              return moved;
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    await commit(b, "main", "a.txt", "a\n");
    const old = await b.history.blobs.store([enc.encode("old, named by the fetched commit\n")]);
    age(dir, loosePath(old), 30 * DAY);
    const fetched: ObjectId[] = [];
    fetch = async () => {
      // the fetched pack holds a commit and its tree, the tree naming the local old blob
      const other = await createGitFilesBackend({ files });
      const tree = await other.history.trees.store([{ name: "o.txt", mode: 0o100644, id: old }]);
      const who = { name: "T", email: "t@t", timestamp: clock++, tzOffset: "+0000" };
      const id = await other.history.commits.store({
        tree,
        parents: [],
        author: who,
        committer: who,
        message: "fetched\n",
      });
      await other.packs.install(
        writePack(other.objects, [
          { id, type: "commit" },
          { id: tree, type: "tree" },
        ]),
      );
      for (const o of [id, tree]) await other.looseStorage.remove(o);
      fetched.push(id, tree);
    };
    const result = await gc({ history: b.history, files });
    expect(armed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(await readable(files, [...fetched, old])).toEqual(all([...fetched, old]));
    expect(await files.exists(joinPath(".git", loosePath(old).slice(5)))).toBe(true);
  });

  it("t5304-prune: a ref moved during gc to an old unreachable commit (no write freshens it) keeps that commit", async () => {
    // git's prune runs after the repack as a process of its own, walking the refs again
    let armed = false;
    let recover: (() => Promise<void>) | undefined;
    const { dir, files, b } = await repository((base) => {
      return new Proxy(base, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === "move")
            return async (source: string, path: string) => {
              const moved = await target.move(source, path);
              if (path.endsWith("objects/info/packs") && !armed && recover) {
                armed = true;
                await recover();
              }
              return moved;
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    await commit(b, "main", "a.txt", "a\n");
    const lost = await commit(b, "main", "l.txt", "on a branch deleted long ago\n", false);
    const ids = [lost.commit, lost.tree, lost.blob];
    for (const id of ids) age(dir, loosePath(id), 30 * DAY);
    recover = async () => {
      // `git branch recovered <id>`: a ref update, no object written
      await b.history.refs.set("refs/heads/recovered", lost.commit);
    };
    const result = await gc({ history: b.history, files, cruftPacks: false });
    expect(armed).toBe(true);
    expect(result.removedObjects).toBe(0);
    expect(await readable(files, ids)).toEqual(all(ids));
  });

  it("FileGcStrategy: an object renewed between recentObjects and prune is not removed", async () => {
    const { dir, files, b } = await repository();
    await commit(b, "main", "a.txt", "a\n");
    const old = await b.history.blobs.store([enc.encode("old\n")]);
    const other = await b.history.blobs.store([enc.encode("old too, never renewed\n")]);
    for (const id of [old, other]) age(dir, loosePath(id), 30 * DAY);
    const strategy = new FileGcStrategy(b);
    const ids = new Set([old, other]);
    expect((await strategy.recentObjects(ids, 14 * DAY)).size).toBe(0);
    await b.history.blobs.store([enc.encode("old\n")]); // a write freshens it
    expect(await strategy.prune(ids)).toBe(1);
    expect(await readable(files, [old, other])).toEqual({ [old]: true, [other]: false });
  });
});
