/**
 * Fifth-review regressions of the network sync (PR #78): paths that leave a skipped state (a
 * nested repository removed, an `ignore` that changed) come back by a three-way merge against
 * the version the folder last held. They are never taken for deletions and never lose remote
 * edits. A pending finish after a restart leaves nested repositories alone.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryWithOperations } from "@statewalker/vcs-core";
import { createMemoryHistoryWithOperations } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import type { FilesApi } from "@statewalker/webrun-files";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GitWorkspace,
  type IgnorePath,
  openGitWorkspace,
  readCommitTree,
  type SyncEvent,
  syncWorkspace,
} from "../src/net/index.js";
import { messageChannelRemote, serverRepo, tick, tmpDir } from "./net-helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function nodeDir(): string {
  const t = tmpDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

async function nodeWs(name: string, dir: string, ignore?: IgnorePath) {
  const history = createMemoryHistoryWithOperations();
  await history.initialize();
  return openGitWorkspace({
    folder: createNodeFilesApi({ rootDir: dir }) as unknown as FilesApi,
    history,
    identity: { name, email: `${name}@example.com` },
    now: tick,
    ignore,
  });
}

/** The same folder and repository, opened again (a restart), with other options. */
function reopen(
  ws: GitWorkspace,
  folder: FilesApi = ws.folder,
  ignore?: IgnorePath,
  commitUnignored?: boolean,
) {
  return openGitWorkspace({
    folder,
    history: ws.history,
    identity: ws.identity,
    now: ws.now,
    ignore,
    commitUnignored,
  });
}

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

const read = (dir: string, p: string) => readFileSync(join(dir, p), "utf8");

describe("S1/Q1. a nested repository removed again", () => {
  it("nothing under it is deleted when nothing changed", async () => {
    const { server, history } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const db = nodeDir();
    mkdirSync(join(db, "docs"));
    writeFileSync(join(db, "docs/a.md"), "A\n");
    const b = await nodeWs("Bob", db);
    await syncWorkspace(b, r());
    mkdirSync(join(db, "docs/.git"));
    writeFileSync(join(db, "docs/.git/HEAD"), "x\n");
    await syncWorkspace(b, r());
    rmSync(join(db, "docs/.git"), { recursive: true });
    const res = await syncWorkspace(b, r());
    expect(res.committed).toBe(false);
    expect(res.rejoined).toEqual(["docs/a.md"]);
    expect(await serverFiles(history)).toEqual({ "docs/a.md": "A\n" });
  });

  it("remote edits and additions made meanwhile survive; the folder's own edits are merged", async () => {
    const { server, history } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const da = nodeDir();
    const db = nodeDir();
    mkdirSync(join(da, "docs"));
    writeFileSync(join(da, "docs/a.md"), "A1\n");
    writeFileSync(join(da, "docs/b.md"), "B1\n");
    writeFileSync(join(da, "docs/d.md"), "1\n2\n3\n4\n5\n");
    writeFileSync(join(da, "docs/e.md"), "title\n");
    writeFileSync(join(da, "top.txt"), "t\n");
    const a = await nodeWs("Ann", da);
    await syncWorkspace(a, r());
    const b = await nodeWs("Bob", db);
    await syncWorkspace(b, r());
    // Bob makes docs/ a repository of its own and works in it
    mkdirSync(join(db, "docs/.git"));
    writeFileSync(join(db, "docs/.git/HEAD"), "x\n");
    await syncWorkspace(b, r());
    writeFileSync(join(db, "docs/b.md"), "B by Bob\n");
    writeFileSync(join(db, "docs/d.md"), "1\n2\n3\n4\n5 by Bob\n");
    writeFileSync(join(db, "docs/e.md"), "title by Bob\n");
    // meanwhile Ann changes and adds files there
    writeFileSync(join(da, "docs/a.md"), "A2 by Ann\n");
    writeFileSync(join(da, "docs/c.md"), "C new by Ann\n");
    writeFileSync(join(da, "docs/d.md"), "1 by Ann\n2\n3\n4\n5\n");
    writeFileSync(join(da, "docs/e.md"), "title by Ann\n");
    await syncWorkspace(a, r());
    const nested = await syncWorkspace(b, r());
    expect(nested.skipped).toEqual([{ path: "docs", reason: "nested-repository" }]);
    expect(read(db, "docs/a.md")).toBe("A1\n"); // left alone while nested
    expect(existsSync(join(db, "docs/c.md"))).toBe(false);
    // Bob removes docs/.git: the paths come back
    rmSync(join(db, "docs/.git"), { recursive: true });
    const events: SyncEvent[] = [];
    const res = await syncWorkspace(b, r(), { onEvent: (e) => events.push(e) });
    expect(res.rejoined).toEqual(["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md", "docs/e.md"]);
    expect(events.find((e) => e.type === "rejoined")).toBeDefined();
    expect(res.conflicts).toEqual(["docs/e.md"]);
    expect(read(db, "docs/a.md")).toBe("A2 by Ann\n");
    expect(read(db, "docs/c.md")).toBe("C new by Ann\n");
    const served = await serverFiles(history);
    expect(served["docs/a.md"]).toBe("A2 by Ann\n");
    expect(served["docs/b.md"]).toBe("B by Bob\n");
    expect(served["docs/c.md"]).toBe("C new by Ann\n");
    expect(served["docs/d.md"]).toBe("1 by Ann\n2\n3\n4\n5 by Bob\n");
    expect(served["docs/e.md"]).toContain("title by Ann");
    expect(served["docs/e.md"]).toContain("title by Bob");
    expect(served["top.txt"]).toBe("t\n");
  });
});

describe("Q1. a path that is no longer ignored", () => {
  it("comes back with the remote's changes, not the folder's stale copy", async () => {
    const { server, history } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const da = nodeDir();
    const db = nodeDir();
    writeFileSync(join(da, "app.cfg"), "port=1\n");
    writeFileSync(join(da, "top.txt"), "t\n");
    const a = await nodeWs("Ann", da);
    await syncWorkspace(a, r());
    const cfg: IgnorePath = (p) => p.endsWith(".cfg");
    const b = await nodeWs("Bob", db, cfg);
    await syncWorkspace(b, r());
    expect(existsSync(join(db, "app.cfg"))).toBe(false); // ignored: never written
    writeFileSync(join(da, "app.cfg"), "port=2\n");
    writeFileSync(join(da, "new.cfg"), "new\n");
    await syncWorkspace(a, r());
    await syncWorkspace(b, r());
    expect(existsSync(join(db, "new.cfg"))).toBe(false);
    // Bob stops ignoring *.cfg (a restart with another `ignore`)
    const b2 = await reopen(b);
    const res = await syncWorkspace(b2, r());
    expect(res.rejoined).toEqual(["app.cfg", "new.cfg"]);
    expect(res.conflicts).toEqual([]);
    expect(read(db, "app.cfg")).toBe("port=2\n");
    expect(read(db, "new.cfg")).toBe("new\n");
    expect(await serverFiles(history)).toEqual({
      "app.cfg": "port=2\n",
      "new.cfg": "new\n",
      "top.txt": "t\n",
    });
  });

  it("a file ignored with a local copy: the copy is kept when only the folder changed it", async () => {
    const { server, history } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const db = nodeDir();
    writeFileSync(join(db, "app.cfg"), "port=1\n");
    const b = await nodeWs("Bob", db);
    await syncWorkspace(b, r());
    const b2 = await reopen(b, b.folder, (p) => p.endsWith(".cfg"));
    await syncWorkspace(b2, r()); // ignored from now on: recorded with the branch's version
    writeFileSync(join(db, "app.cfg"), "port=9 (local)\n");
    await syncWorkspace(b2, r());
    expect((await serverFiles(history))["app.cfg"]).toBe("port=1\n");
    // commitUnignored: the folder's copy is committed (by default it is held, see net-sync-conflicts)
    const b3 = await reopen(b2, b2.folder, undefined, true);
    const res = await syncWorkspace(b3, r());
    expect(res.rejoined).toEqual(["app.cfg"]);
    expect((await serverFiles(history))["app.cfg"]).toBe("port=9 (local)\n");
  });
});

describe("a pending finish after a restart", () => {
  it("does not write into a nested repository", async () => {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const da = nodeDir();
    const db = nodeDir();
    mkdirSync(join(da, "docs"));
    writeFileSync(join(da, "docs/a.md"), "A1\n");
    writeFileSync(join(da, "top.txt"), "t\n");
    const a = await nodeWs("Ann", da);
    await syncWorkspace(a, r());
    const plain = await nodeWs("Bob", db);
    await syncWorkspace(plain, r());
    mkdirSync(join(db, "docs/.git"));
    writeFileSync(join(db, "docs/.git/HEAD"), "x\n");
    await syncWorkspace(plain, r());
    writeFileSync(join(da, "docs/a.md"), "A2\n");
    writeFileSync(join(da, "top.txt"), "t2\n");
    await syncWorkspace(a, r());
    let fail = true;
    const folder: FilesApi = new Proxy(plain.folder, {
      get(target, prop, receiver) {
        if (prop === "write") {
          return async (path: string, c: Iterable<Uint8Array>) => {
            if (fail && path === "/top.txt") throw new Error("disk full");
            return target.write(path, c);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const b = await reopen(plain, folder);
    await expect(syncWorkspace(b, r(), { maxAttempts: 1 })).rejects.toThrow(/disk full/);
    fail = false;
    const restarted = await reopen(plain);
    await syncWorkspace(restarted, r());
    expect(read(db, "top.txt")).toBe("t2\n");
    expect(read(db, "docs/a.md")).toBe("A1\n"); // the nested repository's file, untouched
  });
});
