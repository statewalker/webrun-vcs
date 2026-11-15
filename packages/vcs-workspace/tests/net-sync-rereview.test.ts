/**
 * Second-review regressions of the network sync (PR #78): racily clean snapshot entries,
 * submodules turned into directories, unfinished checkouts that must finish once and never
 * wedge, executable bits on disk, NTFS/HFS spellings of `.git`, binary edits during a checkout,
 * the merge-base walk, directory case collisions, retry wording and temporary files.
 */

import { chmodSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryWithOperations } from "@statewalker/vcs-core";
import { createMemoryHistoryWithOperations } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitWorkspaceChanges,
  type FlatTree,
  findMergeBases,
  type GitWorkspaceOptions,
  isSafePath,
  MODE_GITLINK,
  openGitWorkspace,
  readCommitTree,
  SYNC_TEMP_MARK,
  type SyncRemote,
  storeFlatTree,
  syncWorkspace,
} from "../src/net/index.js";
import {
  folderFiles,
  messageChannelRemote,
  readFile,
  serverRepo,
  tick,
  tmpDir,
  workspace,
  writeFile,
} from "./net-helpers.js";

const enc = new TextEncoder();
const who = { name: "T", email: "t@example.com", timestamp: 1, tzOffset: "+0000" };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A folder whose clock ticks in steps of `granularity` ms: modification times are floored. */
function coarse(folder: FilesApi, granularity: number): FilesApi {
  const fix = <T>(info: T): T => {
    const i = info as { lastModified?: number };
    return typeof i?.lastModified === "number"
      ? ({ ...i, lastModified: Math.floor(i.lastModified / granularity) * granularity } as T)
      : info;
  };
  return new Proxy(folder, {
    get(target, prop, receiver) {
      if (prop === "list") {
        return async function* (path: string, options?: { recursive?: boolean }) {
          for await (const i of target.list(path, options)) yield fix(i);
        };
      }
      if (prop === "stats") return async (path: string) => fix(await target.stats(path));
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function ws(name: string, folder: FilesApi, options: Partial<GitWorkspaceOptions> = {}) {
  const history = createMemoryHistoryWithOperations();
  await history.initialize();
  return openGitWorkspace({
    folder,
    history,
    identity: { name, email: `${name}@example.com` },
    now: tick,
    ...options,
  });
}

/** The Node FilesApi (vcs-utils' FilesApi type is the same interface, declared apart) */
function nodeFolder(dir: string): FilesApi {
  return createNodeFilesApi({ rootDir: dir }) as unknown as FilesApi;
}

function nodeDir(): string {
  const t = tmpDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

async function commitOn(history: HistoryWithOperations, files: FlatTree, parents: string[] = []) {
  const tree = await storeFlatTree(history, files);
  return history.commits.store({ tree, parents, author: who, committer: who, message: "c\n" });
}

async function blob(history: HistoryWithOperations, text: string) {
  return history.blobs.store([enc.encode(text)]);
}

async function serverText(history: HistoryWithOperations, path: string): Promise<string> {
  const tip = (await history.refs.resolve("refs/heads/main"))?.objectId;
  const entry = (await readCommitTree(history, tip)).files.get(path);
  const parts: Uint8Array[] = [];
  for await (const c of (await history.blobs.load(entry?.id as string)) ?? []) parts.push(c);
  return Buffer.concat(parts).toString();
}

describe("H1. racily clean snapshot entries", () => {
  it("a same-size remote change checked out in the same clock tick is not reverted", async () => {
    const { server, history } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "v.txt": "version 1\n" });
    await syncWorkspace(a, r());
    const b = await ws("Bob", coarse(new MemFilesApi(), 60_000)); // every write in one tick
    await syncWorkspace(b, r());
    await syncWorkspace(b, r()); // the snapshot cache knows v.txt
    await writeFile(a, "v.txt", "version 2\n"); // same size
    await syncWorkspace(a, r());
    expect((await syncWorkspace(b, r())).integration).toBe("fast-forward");
    expect((await syncWorkspace(b, r())).committed).toBe(false);
    expect(await serverText(history, "v.txt")).toBe("version 2\n");
    expect(await readFile(b, "v.txt")).toBe("version 2\n");
  });

  for (const granularity of [1000, 2000]) {
    it(`a same-size edit within one ${granularity / 1000} s tick is committed`, async () => {
      const b = await ws(
        "Bob",
        coarse(new MemFilesApi({ initialFiles: { "/n.txt": "aaaa\n" } }), granularity),
      );
      await commitWorkspaceChanges(b);
      await b.folder.write("/n.txt", [enc.encode("bbbb\n")]);
      expect((await commitWorkspaceChanges(b)).changed).toBe(true);
    });
  }

  it("a coarser filesystem is covered by a larger racyWindowMs", async () => {
    const b = await ws(
      "Bob",
      coarse(new MemFilesApi({ initialFiles: { "/n.txt": "aaaa\n" } }), 60_000),
      {
        racyWindowMs: 60_000,
      },
    );
    await commitWorkspaceChanges(b);
    await b.folder.write("/n.txt", [enc.encode("bbbb\n")]);
    expect((await commitWorkspaceChanges(b)).changed).toBe(true);
  });
});

describe("H2. a submodule turned into a directory upstream", () => {
  it("its files are checked out and kept, not deleted by the next sync", async () => {
    const srv = await serverRepo();
    const h = srv.history;
    const readme = await blob(h, "r\n");
    const c1 = await commitOn(
      h,
      new Map([
        ["README", { id: readme, mode: 0o100644 }],
        ["sub", { id: "1".repeat(40), mode: MODE_GITLINK }],
      ]),
    );
    await h.refs.set("refs/heads/main", c1);
    const b = await ws("Bob", new MemFilesApi());
    await syncWorkspace(b, messageChannelRemote(srv.server));
    const c2 = await commitOn(
      h,
      new Map([
        ["README", { id: readme, mode: 0o100644 }],
        ["sub/lib.txt", { id: await blob(h, "library code\n"), mode: 0o100644 }],
      ]),
      [c1],
    );
    await h.refs.set("refs/heads/main", c2);
    await syncWorkspace(b, messageChannelRemote(srv.server));
    expect(await folderFiles(b)).toEqual({ README: "r\n", "sub/lib.txt": "library code\n" });
    expect((await syncWorkspace(b, messageChannelRemote(srv.server))).committed).toBe(false);
    const tip = (await h.refs.resolve("refs/heads/main"))?.objectId;
    expect([...(await readCommitTree(h, tip)).files.keys()].sort()).toEqual([
      "README",
      "sub/lib.txt",
    ]);
  });
});

describe("M1. unfinished checkouts finish once and never wedge", () => {
  const ignore = (p: string) => p.endsWith(".log");

  it("a directory that becomes a file, with an ignored file inside (memory folder)", async () => {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await ws("Ann", new MemFilesApi({ initialFiles: { "/a/x.txt": "x\n" } }), { ignore });
    await syncWorkspace(a, r());
    const b = await ws("Bob", new MemFilesApi(), { ignore });
    await syncWorkspace(b, r());
    await b.folder.write("/a/build.log", [enc.encode("log\n")]);
    await a.folder.remove("/a");
    await a.folder.write("/a", [enc.encode("now a file\n")]);
    await syncWorkspace(a, r());
    await syncWorkspace(b, r());
    expect(await folderFiles(b)).toEqual({ a: "now a file\n" });
    expect(await b.history.refs.resolve("refs/workspace/pending/main")).toBeUndefined();
    expect((await commitWorkspaceChanges(b)).changed).toBe(false);
  });

  it("the same on disk (Node FilesApi)", async () => {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const da = nodeDir();
    const db = nodeDir();
    mkdirSync(join(da, "a"));
    writeFileSync(join(da, "a/x.txt"), "x\n");
    const a = await ws("Ann", nodeFolder(da), { ignore });
    await syncWorkspace(a, r());
    const b = await ws("Bob", nodeFolder(db), { ignore });
    await syncWorkspace(b, r());
    writeFileSync(join(db, "a/build.log"), "log\n");
    await a.folder.remove("/a");
    writeFileSync(join(da, "a"), "file now\n");
    await syncWorkspace(a, r());
    await syncWorkspace(b, r());
    expect(readFileSync(join(db, "a"), "utf8")).toBe("file now\n");
    expect(await b.history.refs.resolve("refs/workspace/pending/main")).toBeUndefined();
  });

  it("retries of a failing finish never merge a merged file again", async () => {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "a.txt": "title\nbody\n", "z.txt": "z\n" });
    await syncWorkspace(a, r());
    const plain = await workspace("Bob");
    await syncWorkspace(plain, r());
    await writeFile(a, "a.txt", "title by Ann\nbody\n");
    await writeFile(a, "z.txt", "z by Ann\n");
    await syncWorkspace(a, r());
    // every write of z.txt fails until released; a.txt goes first (sorted)
    let failZ = true;
    const folder: FilesApi = new Proxy(plain.folder, {
      get(target, prop, receiver) {
        if (prop === "move" || prop === "write") {
          return async (path: string, arg: unknown) => {
            const dest = prop === "move" ? (arg as string) : path;
            if (failZ && dest === "/z.txt") throw new Error("disk full");
            return prop === "move"
              ? target.move(path, arg as string)
              : target.write(path, arg as Iterable<Uint8Array>);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const b = await openGitWorkspace({
      folder,
      history: plain.history,
      identity: plain.identity,
      now: plain.now,
    });
    await expect(syncWorkspace(b, r(), { maxAttempts: 1 })).rejects.toThrow(/disk full/);
    // the checkout wrote a.txt or not; Bob now edits it
    await writeFile(b, "a.txt", "title by Bob\nbody\n");
    for (let i = 0; i < 3; i++) {
      await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/);
      const text = await readFile(b, "a.txt");
      expect(text.match(/<<<<<<</g)).toHaveLength(1);
    }
    failZ = false;
    const done = await syncWorkspace(b, r());
    expect(done.conflicts).toContain("a.txt");
    const text = await readFile(b, "a.txt");
    expect(text.match(/<<<<<<</g)).toHaveLength(1);
    expect(text).toContain("title by Ann");
    expect(text).toContain("title by Bob");
    expect(await readFile(b, "z.txt")).toBe("z by Ann\n");
  });
});

describe("M2. executable bits on disk", () => {
  it.skipIf(process.platform === "win32")("an update keeps the file's permissions", async () => {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const da = nodeDir();
    const db = nodeDir();
    writeFileSync(join(da, "run.sh"), "#!/bin/sh\necho 1\n");
    const a = await ws("Ann", nodeFolder(da));
    await syncWorkspace(a, r());
    const b = await ws("Bob", nodeFolder(db));
    await syncWorkspace(b, r());
    chmodSync(join(db, "run.sh"), 0o755);
    writeFileSync(join(da, "run.sh"), "#!/bin/sh\necho 2\n");
    await syncWorkspace(a, r());
    await syncWorkspace(b, r());
    expect(readFileSync(join(db, "run.sh"), "utf8")).toBe("#!/bin/sh\necho 2\n");
    expect(statSync(join(db, "run.sh")).mode & 0o777).toBe(0o755);
  });
});

describe("M3. NTFS and HFS+ spellings of .git", () => {
  it("are refused", () => {
    for (const p of [
      ".git::$INDEX_ALLOCATION/hooks/post-checkout",
      ".git:x/config",
      ".g‌it/hooks/x",
      ".git‍/config",
      "﻿.git/config",
      ".gi‪t/x",
      "GIT~1/config",
      ".Git /config",
      ".git./x",
      ".git. . /x",
      `${SYNC_TEMP_MARK}x`,
      `dir/${SYNC_TEMP_MARK}1`,
    ]) {
      expect(isSafePath(p), JSON.stringify(p)).toBe(false);
    }
    for (const p of [".gitmodules", ".github/w.yml", "a/.gitx", "git~2/x", "x.git/y", "con/x"]) {
      expect(isSafePath(p), JSON.stringify(p)).toBe(true);
    }
  });
});

describe("M4. a binary file edited during an unfinished checkout", () => {
  it("keeps the edit and puts the checkout's version beside it, no text markers", async () => {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "img.bin": "\0\x01base\n", "z.txt": "z\n" });
    await syncWorkspace(a, r());
    const plain = await workspace("Bob");
    await syncWorkspace(plain, r());
    await a.folder.write("/img.bin", [new Uint8Array([0, 1, 65, 10])]);
    await a.folder.write("/z.txt", [enc.encode("z2\n")]);
    const pushed = await syncWorkspace(a, r());
    let armed = true;
    const folder: FilesApi = new Proxy(plain.folder, {
      get(target, prop, receiver) {
        if (prop === "move" || prop === "write") {
          return async (path: string, arg: unknown) => {
            const dest = prop === "move" ? (arg as string) : path;
            if (armed && dest === "/img.bin") throw new Error("crash");
            return prop === "move"
              ? target.move(path, arg as string)
              : target.write(path, arg as Iterable<Uint8Array>);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const b = await openGitWorkspace({
      folder,
      history: plain.history,
      identity: plain.identity,
      now: plain.now,
    });
    await expect(syncWorkspace(b, r())).rejects.toThrow(/crash/);
    armed = false;
    await b.folder.write("/img.bin", [new Uint8Array([0, 2, 66, 10])]); // the user's edit
    const res = await syncWorkspace(b, r());
    expect(res.conflicts).toContain("img.bin");
    const bytes = async (p: string) => {
      const parts: Uint8Array[] = [];
      for await (const c of b.folder.read(`/${p}`)) parts.push(c);
      return [...Buffer.concat(parts)];
    };
    expect(await bytes("img.bin")).toEqual([0, 2, 66, 10]);
    expect(await bytes(`img.bin.theirs-${(pushed.head as string).slice(0, 7)}`)).toEqual([
      0, 1, 65, 10,
    ]);
    expect(await readFile(b, "z.txt")).toBe("z2\n");
  });
});

describe("L1. the merge-base walk stops at the merge base", () => {
  it("reads a handful of commits on a 20 000-commit history", async () => {
    const history = createMemoryHistoryWithOperations();
    await history.initialize();
    const tree = await storeFlatTree(
      history,
      new Map([["f", { id: await blob(history, "x"), mode: 0o100644 }]]),
    );
    let tip: string | undefined;
    for (let i = 0; i < 20_000; i++) {
      const at = { ...who, timestamp: i };
      tip = await history.commits.store({
        tree,
        parents: tip ? [tip] : [],
        author: at,
        committer: at,
        message: `${i}\n`,
      });
    }
    const late = { ...who, timestamp: 30_000 };
    const mk = (m: string) =>
      history.commits.store({
        tree,
        parents: [tip as string],
        author: late,
        committer: late,
        message: m,
      });
    const a = await mk("a\n");
    const b = await mk("b\n");
    let reads = 0;
    const counted = new Proxy(history, {
      get(target, prop) {
        if (prop !== "commits") return Reflect.get(target, prop);
        return new Proxy(target.commits, {
          get(c, p) {
            const v = Reflect.get(c, p);
            if (typeof v !== "function") return v;
            return (...args: unknown[]) => {
              reads++;
              return (v as (...a: unknown[]) => unknown).apply(c, args);
            };
          },
        });
      },
    });
    expect(await findMergeBases(counted, [a], [b])).toEqual([tip]);
    expect(reads).toBeLessThan(20);
  }, 120_000);
});

describe("L2. directories differing only in case", () => {
  it("on a case-insensitive folder are spelled one way and reported", async () => {
    const srv = await serverRepo();
    const h = srv.history;
    const c = await commitOn(
      h,
      new Map([
        ["Docs/a.txt", { id: await blob(h, "x\n"), mode: 0o100644 }],
        ["docs/b.txt", { id: await blob(h, "y\n"), mode: 0o100644 }],
      ]),
    );
    await h.refs.set("refs/heads/main", c);
    // case-insensitive, case-preserving: the first spelling of a directory wins
    const mem = new MemFilesApi();
    const canon = new Map<string, string>();
    const fold = (p: string) => {
      let acc = "";
      return p
        .split("/")
        .map((part, i) => {
          if (i === 0) return part;
          acc += `/${part.toLowerCase()}`;
          if (!canon.has(acc)) canon.set(acc, part);
          return canon.get(acc) as string;
        })
        .join("/");
    };
    const folder = new Proxy(mem, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (typeof v !== "function") return v;
        return (path: unknown, ...rest: unknown[]) =>
          (v as (...a: unknown[]) => unknown).call(
            target,
            typeof path === "string" ? fold(path) : path,
            ...rest.map((x) => (typeof x === "string" && x.startsWith("/") ? fold(x) : x)),
          );
      },
    }) as FilesApi;
    const b = await ws("Bob", folder, { caseInsensitive: true });
    const first = await syncWorkspace(b, messageChannelRemote(srv.server));
    expect(first.conflicts).toEqual(["docs/b.txt"]);
    expect(await folderFiles(b)).toEqual({ "Docs/a.txt": "x\n", "Docs/b.txt": "y\n" });
    expect((await syncWorkspace(b, messageChannelRemote(srv.server))).committed).toBe(false);
    const tip = (await h.refs.resolve("refs/heads/main"))?.objectId;
    expect([...(await readCommitTree(h, tip)).files.keys()].sort()).toEqual([
      "Docs/a.txt",
      "Docs/b.txt",
    ]);
  });
});

describe("L3/L6. retry classification and wording", () => {
  it("'failed to lock' is a lost race", async () => {
    const { server } = await serverRepo();
    const base = messageChannelRemote(server);
    let pushes = 0;
    const losing: SyncRemote = {
      name: base.name,
      fetch: (o) => base.fetch(o),
      async push(o) {
        if (pushes++ > 0) return base.push(o);
        const result = await base.push({ ...o, refspecs: [] });
        return {
          ...result,
          ok: false,
          updates: [
            {
              remoteRef: "refs/heads/main",
              oldOid: "0".repeat(40),
              newOid: "0".repeat(40),
              force: false,
              forced: false,
              status: "remote-rejected",
              message: "failed to lock",
              summary: "[remote rejected] (failed to lock)",
            },
          ],
        };
      },
    };
    const a = await workspace("Ann", { "a.txt": "a\n" });
    expect(await syncWorkspace(a, losing)).toMatchObject({ attempts: 2, pushed: true });
  });

  it("a folder that keeps changing is reported as such", async () => {
    const { server } = await serverRepo();
    const a = await workspace("Ann", { "a.txt": "a\n" });
    await syncWorkspace(a, messageChannelRemote(server));
    const b = await workspace("Bob", { "b.txt": "b\n" });
    const base = messageChannelRemote(server);
    let n = 0;
    const editing: SyncRemote = {
      name: base.name,
      async fetch(o) {
        const result = await base.fetch(o);
        await writeFile(b, "b.txt", `edit ${n++}\n`);
        return result;
      },
      push: (o) => base.push(o),
    };
    await expect(syncWorkspace(b, editing, { maxAttempts: 2 })).rejects.toThrow(
      /the folder kept changing during the sync/,
    );
  });
});

describe("L4. temporary checkout files", () => {
  it("stale ones are swept, fresh ones and the reserved prefix stay out of history", async () => {
    const dir = nodeDir();
    writeFileSync(join(dir, `${SYNC_TEMP_MARK}old`), "left by a crash\n");
    writeFileSync(join(dir, `${SYNC_TEMP_MARK}fresh`), "being written\n");
    writeFileSync(join(dir, "a.txt"), "a\n");
    const hour = Date.now() / 1000 - 3600;
    utimesSync(join(dir, `${SYNC_TEMP_MARK}old`), hour, hour);
    const b = await ws("Bob", nodeFolder(dir));
    const res = await commitWorkspaceChanges(b);
    expect(res.changed).toBe(true);
    const files = (await readCommitTree(b.history, res.head)).files;
    expect([...files.keys()]).toEqual(["a.txt"]);
    expect(await b.folder.exists(`/${SYNC_TEMP_MARK}old`)).toBe(false);
    expect(await b.folder.exists(`/${SYNC_TEMP_MARK}fresh`)).toBe(true);
  });

  it("a fetched tree using the reserved prefix is refused", async () => {
    const srv = await serverRepo();
    const c = await commitOn(
      srv.history,
      new Map([[`${SYNC_TEMP_MARK}x`, { id: await blob(srv.history, "x\n"), mode: 0o100644 }]]),
    );
    await srv.history.refs.set("refs/heads/main", c);
    const b = await workspace("Bob");
    await expect(syncWorkspace(b, messageChannelRemote(srv.server))).rejects.toThrow(/unsafe path/);
  });
});
