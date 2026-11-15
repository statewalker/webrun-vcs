/**
 * Fourth-review regressions of the network sync (PR #78). Covered: nested repositories (only
 * a `.git` directory or a `gitdir:` file makes one, the branch keeps their tracked files, and
 * they are reported); hand resolutions during a stuck finish; leftover temporary files when
 * a directory is cleared; a directory that empties while the finish looks at it; and the
 * exact temporary-file name.
 */

import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryWithOperations } from "@statewalker/vcs-core";
import { createMemoryHistoryWithOperations } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitWorkspaceChanges,
  type GitWorkspace,
  isCheckoutTempFile,
  openGitWorkspace,
  readCommitTree,
  type SyncEvent,
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

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function nodeDir(): string {
  const t = tmpDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

async function ws(name: string, folder: FilesApi) {
  const history = createMemoryHistoryWithOperations();
  await history.initialize();
  return openGitWorkspace({
    folder,
    history,
    identity: { name, email: `${name}@example.com` },
    now: tick,
  });
}

const nodeWs = (name: string, dir: string) =>
  ws(name, createNodeFilesApi({ rootDir: dir }) as unknown as FilesApi);

async function serverFiles(history: HistoryWithOperations): Promise<Record<string, string>> {
  const tip = (await history.refs.resolve("refs/heads/main"))?.objectId;
  const out: Record<string, string> = {};
  for (const [path, entry] of (await readCommitTree(history, tip)).files) {
    const parts: Uint8Array[] = [];
    for await (const c of (await history.blobs.load(entry.id)) ?? []) parts.push(c);
    out[path] = Buffer.concat(parts).toString();
  }
  return out;
}

function proxied(plain: GitWorkspace, hook: (target: FilesApi, prop: string | symbol) => unknown) {
  const folder: FilesApi = new Proxy(plain.folder, {
    get(target, prop, receiver) {
      const hooked = hook(target, prop);
      if (hooked) return hooked;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return openGitWorkspace({
    folder,
    history: plain.history,
    identity: plain.identity,
    now: plain.now,
  });
}

describe("R1. nested repositories", () => {
  it("git init in a tracked directory keeps history and peers unchanged, and is reported", async () => {
    const { server, history } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const da = nodeDir();
    const db = nodeDir();
    mkdirSync(join(da, "docs"));
    writeFileSync(join(da, "docs/a.md"), "A\n");
    writeFileSync(join(da, "docs/b.md"), "B\n");
    writeFileSync(join(da, "top.txt"), "t\n");
    const a = await nodeWs("Ann", da);
    await syncWorkspace(a, r());
    const b = await nodeWs("Bob", db);
    await syncWorkspace(b, r());
    mkdirSync(join(da, "docs/.git"));
    writeFileSync(join(da, "docs/.git/HEAD"), "ref: refs/heads/master\n");
    const events: SyncEvent[] = [];
    const res = await syncWorkspace(a, r(), { onEvent: (e) => events.push(e) });
    expect(res.committed).toBe(false);
    expect(res.skipped).toEqual([{ path: "docs", reason: "nested-repository" }]);
    expect(events.find((e) => e.type === "skipped")).toMatchObject({
      paths: [{ path: "docs", reason: "nested-repository" }],
    });
    expect(Object.keys(await serverFiles(history)).sort()).toEqual([
      "docs/a.md",
      "docs/b.md",
      "top.txt",
    ]);
    await syncWorkspace(b, r());
    expect(readFileSync(join(db, "docs/a.md"), "utf8")).toBe("A\n");
    expect(readFileSync(join(db, "docs/b.md"), "utf8")).toBe("B\n");
  });

  it("a plain file named .git is not a repository: its siblings are committed", async () => {
    const { server, history } = await serverRepo();
    const da = nodeDir();
    mkdirSync(join(da, "notes"));
    writeFileSync(join(da, "notes/.git"), "remember to commit\n");
    writeFileSync(join(da, "notes/todo.txt"), "todo\n");
    const a = await nodeWs("Ann", da);
    const res = await syncWorkspace(a, messageChannelRemote(server));
    expect(Object.keys(await serverFiles(history))).toEqual(["notes/todo.txt"]);
    expect(res.skipped).toEqual([{ path: "notes/.git", reason: "reserved-name" }]);
  });

  it("a gitdir: file (a git worktree or submodule) makes a nested repository", async () => {
    const { server, history } = await serverRepo();
    const da = nodeDir();
    writeFileSync(join(da, "top.txt"), "t\n");
    mkdirSync(join(da, "wt"));
    writeFileSync(join(da, "wt/.git"), "gitdir: ../elsewhere/.git/worktrees/wt\n");
    writeFileSync(join(da, "wt/code.c"), "c\n");
    const a = await nodeWs("Ann", da);
    const res = await syncWorkspace(a, messageChannelRemote(server));
    expect(Object.keys(await serverFiles(history))).toEqual(["top.txt"]);
    expect(res.skipped).toEqual([{ path: "wt", reason: "nested-repository" }]);
  });

  it("an untracked clone is reported, not silently left out (R2)", async () => {
    const { server, history } = await serverRepo();
    const da = nodeDir();
    writeFileSync(join(da, "top.txt"), "t\n");
    mkdirSync(join(da, "vendor/lib/.git"), { recursive: true });
    writeFileSync(join(da, "vendor/lib/.git/HEAD"), "x\n");
    writeFileSync(join(da, "vendor/lib/code.c"), "c\n");
    const a = await nodeWs("Ann", da);
    const res = await syncWorkspace(a, messageChannelRemote(server));
    expect(res.skipped).toEqual([{ path: "vendor/lib", reason: "nested-repository" }]);
    expect(Object.keys(await serverFiles(history))).toEqual(["top.txt"]);
    expect((await commitWorkspaceChanges(a)).skipped).toEqual([
      { path: "vendor/lib", reason: "nested-repository" },
    ]);
  });
});

describe("R3. a hand resolution during a stuck finish", () => {
  it("is kept as the user's edit, never merged again", async () => {
    const { server, history } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "p.txt": "title\nbody\n", "q.txt": "q\n" });
    await syncWorkspace(a, r());
    const plain = await workspace("Bob");
    await syncWorkspace(plain, r());
    await writeFile(a, "p.txt", "title by Ann\nbody\n");
    await writeFile(a, "q.txt", "q2\n");
    await syncWorkspace(a, r());
    const state = { fail: (_p: string) => false };
    const b = await proxied(plain, (target, prop) => {
      if (prop !== "write") return undefined;
      return async (path: string, c: Iterable<Uint8Array>) => {
        if (state.fail(path)) throw new Error("disk full");
        return target.write(path, c);
      };
    });
    await writeFile(plain, "p.txt", "title by Bob\nbody\n");
    state.fail = (p) => p === "/q.txt";
    // committed conflicts (onConflict: "commit"); the default is covered in net-sync-conflicts
    const commit = { maxAttempts: 1, onConflict: "commit" } as const;
    await expect(syncWorkspace(b, r(), commit)).rejects.toThrow(/disk full/);
    await expect(syncWorkspace(b, r(), commit)).rejects.toThrow(/disk full/);
    expect((await readFile(b, "p.txt")).match(/<<<<<<</g)).toHaveLength(1);
    await writeFile(plain, "p.txt", "title by Ann and Bob\nbody\n"); // resolved by hand
    state.fail = () => false;
    const res = await syncWorkspace(b, r(), { onConflict: "commit" });
    expect(await readFile(b, "p.txt")).toBe("title by Ann and Bob\nbody\n");
    expect((await serverFiles(history))["p.txt"]).toBe("title by Ann and Bob\nbody\n");
    expect(res.pushed).toBe(true);
  });
});

describe("R4. leftover temporary files when a directory is cleared", () => {
  it("are expendable: the directory becomes the target's file", async () => {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await ws("Ann", new MemFilesApi({ initialFiles: { "/z/x.txt": "x\n" } }));
    await syncWorkspace(a, r());
    const b = await ws("Bob", new MemFilesApi());
    await syncWorkspace(b, r());
    await b.folder.write("/z/.vcs-sync-tmp-018c2f6a9b10-0001-1a2b3c4d", [new Uint8Array([1])]);
    await a.folder.remove("/z");
    await a.folder.write("/z", [new TextEncoder().encode("now a file\n")]);
    await syncWorkspace(a, r());
    const res = await syncWorkspace(b, r());
    expect(res.conflicts).toEqual([]);
    expect(await folderFiles(b)).toEqual({ z: "now a file\n" });
  });
});

describe("R5. a directory that empties while the finish looks at it", () => {
  it("gets the target's file, not nothing", async () => {
    const { server, history } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "b.txt": "b\n", "z/x.txt": "x\n" });
    await syncWorkspace(a, r());
    const plain = await workspace("Bob");
    await syncWorkspace(plain, r());
    await a.folder.remove("/z");
    await writeFile(a, "z", "Ann's z\n");
    await writeFile(a, "b.txt", "b2\n");
    await syncWorkspace(a, r());
    let failB = true;
    let raced = false;
    const b = await proxied(plain, (target, prop) => {
      if (prop === "write") {
        return async (path: string, c: Iterable<Uint8Array>) => {
          if (failB && path === "/b.txt") throw new Error("disk full");
          return target.write(path, c);
        };
      }
      if (prop === "list") {
        return async function* (path: string, o?: { recursive?: boolean }) {
          const items = [];
          for await (const item of target.list(path, o)) items.push(item);
          // the first look into z/ during the finish sees the user's file, which then goes
          if (!raced && path === "/z" && items.some((i) => i.path === "/z/new.txt")) {
            raced = true;
            await target.remove("/z/new.txt"); // the directory stays, empty
          }
          yield* items;
        };
      }
      return undefined;
    });
    await expect(syncWorkspace(b, r(), { maxAttempts: 1 })).rejects.toThrow(/disk full/);
    failB = false;
    await plain.folder.write("/z/new.txt", [new TextEncoder().encode("tmp\n")]);
    const res = await syncWorkspace(b, r());
    expect(raced).toBe(true);
    expect(await readFile(b, "z")).toBe("Ann's z\n");
    expect((await serverFiles(history)).z).toBe("Ann's z\n");
    expect(res.pushed).toBe(false);
    expect(res.conflicts).toEqual([]);
  });
});

describe("R6. the exact temporary-file name", () => {
  it("only names a checkout writes match; others are kept and never committed", async () => {
    expect(isCheckoutTempFile(".vcs-sync-tmp-018c2f6a9b10-0001-1a2b3c4d")).toBe(true);
    expect(isCheckoutTempFile("dir/.vcs-sync-tmp-018c2f6a9b10-ffff-00000000")).toBe(true);
    for (const name of [
      ".vcs-sync-tmp-my-notes-v2",
      ".vcs-sync-tmp-notes.txt",
      ".vcs-sync-tmp-018c2f6a9b1-0001-1a2b3c4d",
      ".vcs-sync-tmp-018c2f6a9b10-0001-1a2b3c4dx",
      ".vcs-sync-tmp-018C2F6A9B10-0001-1A2B3C4D",
    ]) {
      expect(isCheckoutTempFile(name), name).toBe(false);
    }
    const d = nodeDir();
    writeFileSync(join(d, ".vcs-sync-tmp-my-notes-v2"), "mine\n");
    utimesSync(join(d, ".vcs-sync-tmp-my-notes-v2"), 1_600_000_000, 1_600_000_000);
    writeFileSync(join(d, "a.txt"), "a\n");
    const b = await nodeWs("Bob", d);
    const res = await commitWorkspaceChanges(b);
    expect(existsSync(join(d, ".vcs-sync-tmp-my-notes-v2"))).toBe(true);
    expect([...(await readCommitTree(b.history, res.head)).files.keys()]).toEqual(["a.txt"]);
  });
});
