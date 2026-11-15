/**
 * Conflicts found while recovering stop like a merge conflict (the default,
 * `onConflict: "stop"`): finishing a checkout that was cut short, and bringing back paths that
 * were left out. The result goes into the folder, nothing of it is committed or pushed, and
 * `concludeMerge` or `abortMerge` ends it. Aborting never loses the folder's edits nor the
 * incoming content. `onConflict: "commit"` keeps the former behaviour.
 */

import type { HistoryWithOperations } from "@statewalker/vcs-core";
import { createMemoryHistoryWithOperations } from "@statewalker/vcs-core";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  abortMerge,
  commitWorkspaceChanges,
  concludeMerge,
  defaultIgnore,
  type GitWorkspace,
  type GitWorkspaceOptions,
  MergeAbortRefusedError,
  openGitWorkspace,
  readCommitTree,
  readMergeState,
  type SyncEvent,
  syncWorkspace,
  UnresolvedConflictsError,
} from "../src/net/index.js";
import {
  folderFiles,
  headOf,
  messageChannelRemote,
  readFile,
  serverRepo,
  tick,
  workspace,
  writeFile,
} from "./net-helpers.js";

const PENDING = "refs/workspace/pending/main";
const PLAN = "refs/workspace/plan/main";
const MERGE = "refs/workspace/merge/main";
const SKIP = "refs/workspace/skip/main";

async function treeFiles(
  history: HistoryWithOperations,
  commit: string | undefined,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [path, entry] of (await readCommitTree(history, commit)).files) {
    const parts: Uint8Array[] = [];
    for await (const c of (await history.blobs.load(entry.id)) ?? []) parts.push(c);
    out[path] = Buffer.concat(parts).toString();
  }
  return out;
}

async function serverFiles(history: HistoryWithOperations): Promise<Record<string, string>> {
  return treeFiles(history, (await history.refs.resolve("refs/heads/main"))?.objectId);
}

const markers = (text: string) => (text.match(/<<<<<<</g) ?? []).length;

/**
 * `plain` opened again over a folder whose writes to `failOn` paths fail while armed, and a
 * repository whose ref updates `crashOn` may fail once.
 */
function faulty(plain: GitWorkspace, failOn: (path: string) => boolean) {
  const state = {
    armed: true,
    crash: undefined as undefined | { method: "set" | "remove" | "compareAndSwap"; ref: string },
  };
  const folder: FilesApi = new Proxy(plain.folder, {
    get(target, prop, receiver) {
      if (prop === "move" || prop === "write") {
        return async (path: string, arg: unknown) => {
          const dest = prop === "move" ? (arg as string) : path;
          if (state.armed && failOn(dest)) throw new Error("disk full");
          return prop === "move"
            ? target.move(path, arg as string)
            : target.write(path, arg as Iterable<Uint8Array>);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const refs = new Proxy(plain.history.refs, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop !== "set" && prop !== "remove" && prop !== "compareAndSwap") {
        return value.bind(target);
      }
      return async (name: string, ...rest: unknown[]) => {
        if (state.crash && state.crash.method === prop && state.crash.ref === name) {
          state.crash = undefined;
          throw new Error("crash");
        }
        return (value as (...a: unknown[]) => unknown).call(target, name, ...rest);
      };
    },
  });
  const history = new Proxy(plain.history, {
    get(target, prop, receiver) {
      if (prop === "refs") return refs;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    state,
    open: (options: Partial<GitWorkspaceOptions> = {}) =>
      openGitWorkspace({
        folder,
        history,
        identity: plain.identity,
        now: tick,
        ...options,
      }),
  };
}

/** The same folder and repository, opened again (a restart). */
function reopen(ws: GitWorkspace, options: Partial<GitWorkspaceOptions> = {}) {
  return openGitWorkspace({
    folder: ws.folder,
    history: ws.history,
    identity: ws.identity,
    now: tick,
    ...options,
  });
}

/**
 * Ann and Bob share a.txt, b.txt, c.txt; Ann changes all three and pushes. Bob's checkout of
 * Ann's commit is cut short at `failOn` (a.txt and b.txt are written first, in order).
 */
async function cutShort(failOn = "/c.txt", options: Partial<GitWorkspaceOptions> = {}) {
  const { server, history } = await serverRepo();
  const r = () => messageChannelRemote(server);
  const a = await workspace("Ann", { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
  await syncWorkspace(a, r());
  const plain = await workspace("Bob");
  await syncWorkspace(plain, r());
  const start = (await headOf(plain)) as string;
  await writeFile(a, "a.txt", "a2\n");
  await writeFile(a, "b.txt", "b2\n");
  await writeFile(a, "c.txt", "c from Ann\n");
  const pushed = await syncWorkspace(a, r());
  const f = faulty(plain, (p) => p === failOn);
  const b = await f.open(options);
  await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/);
  expect(await plain.history.refs.resolve(PENDING)).toBeDefined();
  return { r, history, plain, b, f, start, target: pushed.head as string };
}

describe("finishing a cut-short checkout that meets a folder edit stops like a merge", () => {
  it("writes the markers, commits and pushes nothing of them; conclude commits, the next sync pushes", async () => {
    const { r, history, plain, b, f, start, target } = await cutShort();
    f.state.armed = false;
    const served = await serverFiles(history);
    await writeFile(plain, "c.txt", "c from Bob\n"); // the checkout had not reached c.txt
    const events: SyncEvent[] = [];
    const res = await syncWorkspace(b, r(), { onEvent: (e) => events.push(e) });
    expect(res).toMatchObject({ integration: "conflicted", pushed: false, conflicts: ["c.txt"] });
    expect(res.merge).toMatchObject({ kind: "recovery", theirs: target, conflicts: ["c.txt"] });
    expect(events.find((e) => e.type === "conflicted")).toMatchObject({ started: true });
    expect(events.some((e) => e.type === "fetch" || e.type === "push")).toBe(false);
    const c = await readFile(plain, "c.txt");
    expect(markers(c)).toBe(1);
    expect(c).toContain("c from Bob");
    expect(c).toContain("c from Ann");
    expect(await readFile(plain, "b.txt")).toBe("b2\n");
    expect(await serverFiles(history)).toEqual(served);
    // the branch holds Bob's edit on its own, on the commit the checkout started from
    const head = (await headOf(plain)) as string;
    expect(head).toBe(res.merge?.head);
    expect((await plain.history.commits.load(head))?.parents).toEqual([start]);
    expect(await treeFiles(plain.history, head)).toEqual({
      "a.txt": "a\n",
      "b.txt": "b\n",
      "c.txt": "c from Bob\n",
    });
    for (const ref of [PENDING, PLAN]) {
      expect(await plain.history.refs.resolve(ref)).toBeUndefined();
    }
    // later syncs and commits do nothing while the merge is in progress
    const again = await syncWorkspace(b, r(), { onEvent: (e) => events.push(e) });
    expect(again).toMatchObject({ integration: "conflicted", pushed: false, committed: false });
    expect(events.filter((e) => e.type === "conflicted").at(-1)).toMatchObject({ started: false });
    const commit = await commitWorkspaceChanges(b);
    expect(commit.changed).toBe(false);
    expect(commit.merge?.kind).toBe("recovery");
    expect(await headOf(plain)).toBe(head);
    expect((await readMergeState(b))?.kind).toBe("recovery");
    // conclude: refused with markers, then the merge commit with both parents
    await expect(concludeMerge(b)).rejects.toThrow(UnresolvedConflictsError);
    await writeFile(plain, "c.txt", "c from Ann and Bob\n");
    const done = await concludeMerge(b);
    expect((await plain.history.commits.load(done.head as string))?.parents).toEqual([
      head,
      target,
    ]);
    const pushed = await syncWorkspace(b, r());
    expect(pushed.pushed).toBe(true);
    expect(await serverFiles(history)).toEqual({
      "a.txt": "a2\n",
      "b.txt": "b2\n",
      "c.txt": "c from Ann and Bob\n",
    });
  });

  it("abort gives every folder edit back and leaves the target for the next sync", async () => {
    const { r, history, plain, b, f, start } = await cutShort();
    f.state.armed = false;
    const served = await serverFiles(history);
    // a.txt was written by the checkout, then edited; c.txt was not reached
    expect(await readFile(plain, "a.txt")).toBe("a2\n");
    await writeFile(plain, "a.txt", "a2 by Bob\n");
    await writeFile(plain, "c.txt", "c from Bob\n");
    await writeFile(plain, "d.txt", "Bob's new file\n"); // an unrelated edit
    const res = await syncWorkspace(b, r());
    expect(res).toMatchObject({ integration: "conflicted", conflicts: ["c.txt"] });
    const head = res.merge?.head as string;
    const aborted = await abortMerge(b);
    expect(aborted.head).toBe(head);
    // the folder holds Bob's edits and the start's content, never Ann's: nothing of Bob's lost
    expect(await folderFiles(plain)).toEqual({
      "a.txt": "a2 by Bob\n",
      "b.txt": "b\n",
      "c.txt": "c from Bob\n",
      "d.txt": "Bob's new file\n",
    });
    expect(await headOf(plain)).toBe(head);
    expect((await plain.history.commits.load(head))?.parents).toEqual([start]);
    for (const ref of [PENDING, PLAN, MERGE]) {
      expect(await plain.history.refs.resolve(ref)).toBeUndefined();
    }
    expect(await serverFiles(history)).toEqual(served);
    // Ann's commit is not lost: the next sync merges it again (and stops on the same file)
    const next = await syncWorkspace(b, r());
    expect(next.integration).toBe("conflicted");
    expect(next.merge?.kind).toBe("merge");
    expect(next.conflicts).toContain("c.txt");
    expect(await readFile(plain, "b.txt")).toBe("b2\n");
    expect(await readFile(plain, "c.txt")).toContain("c from Ann");
    expect(await readFile(plain, "c.txt")).toContain("c from Bob");
    expect(await serverFiles(history)).toEqual(served);
  });

  it("a binary edit stops with the target beside it; conclude takes the folder", async () => {
    const { server, history } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "a.txt": "a\n", "b.bin": "\0B\n" });
    await syncWorkspace(a, r());
    const plain = await workspace("Bob");
    await syncWorkspace(plain, r());
    await writeFile(a, "a.txt", "a2\n");
    await writeFile(a, "b.bin", "\0B by Ann\n");
    const target = (await syncWorkspace(a, r())).head as string;
    const f = faulty(plain, (p) => p === "/b.bin");
    const b = await f.open();
    await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/);
    f.state.armed = false;
    await writeFile(plain, "b.bin", "\0B by Bob\n");
    const res = await syncWorkspace(b, r());
    expect(res).toMatchObject({ integration: "conflicted", pushed: false, conflicts: ["b.bin"] });
    const aside = `b.bin.theirs-${target.slice(0, 7)}`;
    expect(await folderFiles(plain)).toEqual({
      "a.txt": "a2\n",
      "b.bin": "\0B by Bob\n",
      [aside]: "\0B by Ann\n",
    });
    expect((await serverFiles(history))["b.bin"]).toBe("\0B by Ann\n");
    // binary conflicts are not checked for markers: Bob keeps his, without the copy
    await plain.folder.remove(`/${aside}`);
    await concludeMerge(b);
    await syncWorkspace(b, r());
    expect(await serverFiles(history)).toEqual({ "a.txt": "a2\n", "b.bin": "\0B by Bob\n" });
  });

  it("an abort of a binary stop removes the copy and keeps the folder's version", async () => {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "a.txt": "a\n", "b.bin": "\0B\n" });
    await syncWorkspace(a, r());
    const plain = await workspace("Bob");
    await syncWorkspace(plain, r());
    await writeFile(a, "a.txt", "a2\n");
    await writeFile(a, "b.bin", "\0B by Ann\n");
    await syncWorkspace(a, r());
    const f = faulty(plain, (p) => p === "/b.bin");
    const b = await f.open();
    await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/);
    f.state.armed = false;
    await writeFile(plain, "b.bin", "\0B by Bob\n");
    await syncWorkspace(b, r());
    await abortMerge(b);
    expect(await folderFiles(plain)).toEqual({ "a.txt": "a\n", "b.bin": "\0B by Bob\n" });
    expect((await treeFiles(plain.history, await headOf(plain)))["b.bin"]).toBe("\0B by Bob\n");
  });

  it("with onConflict: commit, the conflict is committed and pushed as before", async () => {
    const { r, history, plain, b, f } = await cutShort("/c.txt", { onConflict: "commit" });
    f.state.armed = false;
    await writeFile(plain, "c.txt", "c from Bob\n");
    const res = await syncWorkspace(b, r());
    expect(res).toMatchObject({ pushed: true, conflicts: ["c.txt"] });
    expect(res.integration).not.toBe("conflicted");
    const c = (await serverFiles(history))["c.txt"];
    expect(markers(c)).toBe(1);
    expect(c).toContain("c from Bob");
    expect(await plain.history.refs.resolve(MERGE)).toBeUndefined();
  });

  it("a per-call onConflict: commit overrides the workspace's stop", async () => {
    const { r, history, plain, b, f } = await cutShort();
    f.state.armed = false;
    await writeFile(plain, "c.txt", "c from Bob\n");
    const res = await syncWorkspace(b, r(), { onConflict: "commit" });
    expect(res.pushed).toBe(true);
    expect(markers((await serverFiles(history))["c.txt"])).toBe(1);
  });
});

describe("a recovery stop cut short", () => {
  it("is recorded before the conflicted file is written; the next call finishes it", async () => {
    const { r, history, plain, b, f, start, target } = await cutShort();
    const served = await serverFiles(history);
    await writeFile(plain, "c.txt", "c from Bob\n");
    // still failing: the stop is recorded, then writing the markers fails
    await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/);
    expect(await readFile(plain, "c.txt")).toBe("c from Bob\n");
    expect(await plain.history.refs.resolve(PENDING)).toBeUndefined();
    expect(await plain.history.refs.resolve(MERGE)).toBeDefined();
    expect(await headOf(plain)).toBe(start);
    expect((await readMergeState(b))?.kind).toBe("recovery");
    f.state.armed = false;
    const restarted = await f.open({ onConflict: "commit" }); // the stop is already decided
    const events: SyncEvent[] = [];
    const res = await syncWorkspace(restarted, r(), { onEvent: (e) => events.push(e) });
    expect(res).toMatchObject({ integration: "conflicted", pushed: false, conflicts: ["c.txt"] });
    expect(events.find((e) => e.type === "conflicted")).toMatchObject({ started: true });
    expect(markers(await readFile(plain, "c.txt"))).toBe(1);
    expect(await serverFiles(history)).toEqual(served);
    expect((await plain.history.commits.load((await headOf(plain)) as string))?.parents).toEqual([
      start,
    ]);
    await writeFile(plain, "c.txt", "resolved\n");
    const done = await concludeMerge(restarted);
    expect((await plain.history.commits.load(done.head as string))?.parents[1]).toBe(target);
    await syncWorkspace(restarted, r());
    expect((await serverFiles(history))["c.txt"]).toBe("resolved\n");
  });

  it("a crash between recording the stop and moving the branch is finished by the next call", async () => {
    const { r, history, plain, b, f } = await cutShort();
    f.state.armed = false;
    const served = await serverFiles(history);
    await writeFile(plain, "c.txt", "c from Bob\n");
    f.state.crash = { method: "compareAndSwap", ref: "refs/heads/main" };
    await expect(syncWorkspace(b, r())).rejects.toThrow(/crash/);
    const state = await readMergeState(b);
    expect(state?.kind).toBe("recovery");
    expect(await headOf(plain)).not.toBe(state?.head);
    const res = await syncWorkspace(await f.open(), r());
    expect(res.integration).toBe("conflicted");
    expect(await headOf(plain)).toBe(state?.head);
    expect(markers(await readFile(plain, "c.txt"))).toBe(1);
    await writeFile(plain, "c.txt", "resolved\n");
    await concludeMerge(b);
    await syncWorkspace(b, r());
    expect(await serverFiles(history)).toEqual({ ...served, "c.txt": "resolved\n" });
  });

  it("an abort of a stop whose writing was cut short finishes it first, then gives the edits back", async () => {
    const { r, plain, b, f, start } = await cutShort();
    await writeFile(plain, "c.txt", "c from Bob\n");
    await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/);
    f.state.armed = false;
    await abortMerge(b);
    expect(await folderFiles(plain)).toEqual({
      "a.txt": "a\n",
      "b.txt": "b\n",
      "c.txt": "c from Bob\n",
    });
    const head = (await headOf(plain)) as string;
    expect((await plain.history.commits.load(head))?.parents).toEqual([start]);
    for (const ref of [PENDING, PLAN, MERGE]) {
      expect(await plain.history.refs.resolve(ref)).toBeUndefined();
    }
  });
});

/**
 * Bob makes docs/ a nested repository and edits docs/e.md in it; Ann edits it on the branch.
 * Then Bob removes docs/.git: the path comes back with both sides changed.
 */
async function rejoining() {
  const { server, history } = await serverRepo();
  const r = () => messageChannelRemote(server);
  const a = await workspace("Ann", { "docs/e.md": "title\n", "docs/f.md": "f\n", "t.txt": "t\n" });
  await syncWorkspace(a, r());
  const plain = await workspace("Bob");
  await syncWorkspace(plain, r());
  await writeFile(plain, "docs/.git/HEAD", "ref: refs/heads/main\n");
  await syncWorkspace(plain, r());
  await writeFile(plain, "docs/e.md", "title by Bob\n");
  await writeFile(a, "docs/e.md", "title by Ann\n");
  await writeFile(a, "docs/f.md", "f by Ann\n");
  await syncWorkspace(a, r());
  await syncWorkspace(plain, r());
  expect(await readFile(plain, "docs/f.md")).toBe("f\n"); // left alone while nested
  await plain.folder.remove("/docs/.git");
  return { r, history, plain };
}

describe("a path that comes back with changes on both sides stops like a merge", () => {
  it("markers in the folder, nothing committed or pushed; conclude commits, the next sync pushes", async () => {
    const { r, history, plain } = await rejoining();
    const served = await serverFiles(history);
    const head = await headOf(plain);
    const res = await syncWorkspace(plain, r());
    expect(res).toMatchObject({
      integration: "conflicted",
      pushed: false,
      committed: false,
      conflicts: ["docs/e.md"],
    });
    expect(res.merge).toMatchObject({ kind: "rejoin", head });
    expect(res.rejoined).toEqual(["docs/f.md"]); // unchanged in the folder: brought up
    expect(await readFile(plain, "docs/f.md")).toBe("f by Ann\n");
    const e = await readFile(plain, "docs/e.md");
    expect(markers(e)).toBe(1);
    expect(e).toContain("title by Bob");
    expect(e).toContain("title by Ann");
    expect(await headOf(plain)).toBe(head);
    expect(await serverFiles(history)).toEqual(served);
    // theirs holds the folder's copy, on the branch tip
    const theirs = res.merge?.theirs as string;
    expect((await plain.history.commits.load(theirs))?.parents).toEqual([head]);
    expect((await treeFiles(plain.history, theirs))["docs/e.md"]).toBe("title by Bob\n");
    const again = await syncWorkspace(plain, r());
    expect(again).toMatchObject({ integration: "conflicted", pushed: false });
    expect((await commitWorkspaceChanges(plain)).changed).toBe(false);
    await expect(concludeMerge(plain)).rejects.toThrow(UnresolvedConflictsError);
    await writeFile(plain, "docs/e.md", "title by Ann and Bob\n");
    await concludeMerge(plain);
    const pushed = await syncWorkspace(plain, r());
    expect(pushed).toMatchObject({ pushed: true, conflicts: [], rejoined: [] });
    expect(await serverFiles(history)).toEqual({
      "docs/e.md": "title by Ann and Bob\n",
      "docs/f.md": "f by Ann\n",
      "t.txt": "t\n",
    });
    expect(await plain.history.refs.resolve(SKIP)).toBeUndefined();
  });

  it("abort gives the folder's copy back; the next commit brings the path back again", async () => {
    const { r, history, plain } = await rejoining();
    const served = await serverFiles(history);
    const head = await headOf(plain);
    await syncWorkspace(plain, r());
    await abortMerge(plain);
    expect(await readFile(plain, "docs/e.md")).toBe("title by Bob\n");
    expect(await headOf(plain)).toBe(head);
    expect(await serverFiles(history)).toEqual(served);
    expect(await plain.history.refs.resolve(SKIP)).toBeDefined();
    // the branch's version is still to come: the next sync stops on it again, once
    const next = await syncWorkspace(plain, r());
    expect(next).toMatchObject({ integration: "conflicted", conflicts: ["docs/e.md"] });
    expect(markers(await readFile(plain, "docs/e.md"))).toBe(1);
    await abortMerge(plain);
    // or commits it, as before, when asked
    const committed = await syncWorkspace(plain, r(), { onConflict: "commit" });
    expect(committed).toMatchObject({ pushed: true, conflicts: ["docs/e.md"] });
    const e = (await serverFiles(history))["docs/e.md"];
    expect(markers(e)).toBe(1);
    expect(e).toContain("title by Bob");
  });

  it("a crash after the conflicted path is written, before the stop is recorded, stops once", async () => {
    const { r, history, plain } = await rejoining();
    const served = await serverFiles(history);
    const f = faulty(plain, () => false);
    f.state.crash = { method: "set", ref: MERGE };
    await expect(syncWorkspace(await f.open(), r())).rejects.toThrow(/crash/);
    expect(markers(await readFile(plain, "docs/e.md"))).toBe(1);
    const res = await syncWorkspace(await reopen(plain), r());
    expect(res).toMatchObject({ integration: "conflicted", conflicts: ["docs/e.md"] });
    expect(markers(await readFile(plain, "docs/e.md"))).toBe(1);
    expect(await serverFiles(history)).toEqual(served);
    await writeFile(plain, "docs/e.md", "resolved\n");
    await concludeMerge(plain);
    await syncWorkspace(plain, r());
    expect((await serverFiles(history))["docs/e.md"]).toBe("resolved\n");
  });

  it("a conclude cut short after the branch moved leaves no rejoin behind", async () => {
    const { r, history, plain } = await rejoining();
    await syncWorkspace(plain, r());
    await writeFile(plain, "docs/e.md", "resolved\n");
    const f = faulty(plain, () => false);
    f.state.crash = { method: "remove", ref: SKIP }; // the record empties: removed
    await expect(concludeMerge(await f.open())).rejects.toThrow(/crash/);
    const res = await syncWorkspace(await reopen(plain), r());
    expect(res).toMatchObject({ pushed: true, conflicts: [], rejoined: [] });
    expect((await serverFiles(history))["docs/e.md"]).toBe("resolved\n");
    expect(await plain.history.refs.resolve(MERGE)).toBeUndefined();
    expect(await plain.history.refs.resolve(SKIP)).toBeUndefined();
  });
});

/** Review round of the recovery stop (R1, R3, R5, R9). */
describe("a recovery stop never takes a file back from being ignored", () => {
  const ignoreSecret = (p: string) => defaultIgnore(p) || p === "secret.env";

  async function withSecret(annFiles: Record<string, string> = {}) {
    const { server, history } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    await syncWorkspace(a, r());
    const h = createMemoryHistoryWithOperations();
    await h.initialize();
    const plain = await openGitWorkspace({
      folder: new MemFilesApi({ initialFiles: { "/secret.env": "TOKEN=hunter2\n" } }),
      history: h,
      identity: { name: "Bob", email: "bob@example.com" },
      now: tick,
      ignore: ignoreSecret,
    });
    await syncWorkspace(plain, r());
    await writeFile(a, "a.txt", "a2\n");
    await writeFile(a, "b.txt", "b2\n");
    await writeFile(a, "c.txt", "c from Ann\n");
    for (const [p, c] of Object.entries(annFiles)) await writeFile(a, p, c);
    await syncWorkspace(a, r());
    const f = faulty(plain, (p) => p === "/c.txt");
    await expect(syncWorkspace(await f.open({ ignore: ignoreSecret }), r())).rejects.toThrow(
      /disk full/,
    );
    f.state.armed = false;
    await writeFile(plain, "c.txt", "c from Bob\n");
    // restarted with an ignore that no longer ignores secret.env
    return { r, history, plain, b: await f.open() };
  }

  it("R1: the un-ignored local file is held: not in the edits, not concluded, not pushed", async () => {
    const { r, history, plain, b } = await withSecret();
    const res = await syncWorkspace(b, r());
    expect(res).toMatchObject({ integration: "conflicted", conflicts: ["c.txt"] });
    expect(res.skipped).toContainEqual({ path: "secret.env", reason: "unignored-local" });
    expect((await treeFiles(plain.history, res.merge?.head))["secret.env"]).toBeUndefined();
    await writeFile(plain, "c.txt", "resolved\n");
    const done = await concludeMerge(b);
    expect(done.skipped).toContainEqual({ path: "secret.env", reason: "unignored-local" });
    await syncWorkspace(b, r());
    expect(await serverFiles(history)).toEqual({
      "a.txt": "a2\n",
      "b.txt": "b2\n",
      "c.txt": "resolved\n",
    });
    expect(await readFile(plain, "secret.env")).toBe("TOKEN=hunter2\n");
  });

  it("R1: when the target adds the same path, the local copy is held and the target's stays", async () => {
    const { r, history, plain, b } = await withSecret({ "secret.env": "TOKEN=public\n" });
    const res = await syncWorkspace(b, r());
    expect(res.conflicts).toEqual(["c.txt"]);
    expect(res.skipped).toContainEqual({ path: "secret.env", reason: "unignored-local" });
    expect(await readFile(plain, "secret.env")).toBe("TOKEN=hunter2\n");
    expect((await treeFiles(plain.history, res.merge?.head))["secret.env"]).toBeUndefined();
    await writeFile(plain, "c.txt", "resolved\n");
    await concludeMerge(b);
    await syncWorkspace(b, r());
    expect((await serverFiles(history))["secret.env"]).toBe("TOKEN=public\n");
  });
});

describe("abort keeps edits made after the stop to paths that merged cleanly", () => {
  it("R3: a recovery abort is refused with the paths, nothing changed; force discards them", async () => {
    const { r, plain, b, f } = await cutShort();
    f.state.armed = false;
    await writeFile(plain, "c.txt", "c from Bob\n");
    await syncWorkspace(b, r());
    // after the stop Bob edits b.txt (the checkout wrote b2) and c.txt (the conflict)
    await writeFile(plain, "b.txt", "b2 + Bob's work after the stop\n");
    await writeFile(plain, "c.txt", "half resolved\n");
    const refused = await abortMerge(b).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(MergeAbortRefusedError);
    expect((refused as MergeAbortRefusedError).paths).toEqual(["b.txt"]);
    expect(await readFile(plain, "b.txt")).toBe("b2 + Bob's work after the stop\n");
    expect(await readFile(plain, "c.txt")).toBe("half resolved\n");
    expect((await readMergeState(b))?.kind).toBe("recovery");
    await abortMerge(b, { force: true });
    expect(await folderFiles(plain)).toEqual({
      "a.txt": "a\n",
      "b.txt": "b\n",
      "c.txt": "c from Bob\n",
    });
  });

  it("R3: the same for a merge with the remote; a conflicted file's edit alone is discarded", async () => {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "p.txt": "p\n", "q.txt": "q\n" });
    await syncWorkspace(a, r());
    const b = await workspace("Bob");
    await syncWorkspace(b, r());
    await writeFile(a, "p.txt", "p by Ann\n");
    await writeFile(a, "q.txt", "q by Ann\n");
    await syncWorkspace(a, r());
    await writeFile(b, "p.txt", "p by Bob\n");
    const res = await syncWorkspace(b, r());
    expect(res).toMatchObject({ integration: "conflicted", conflicts: ["p.txt"] });
    await writeFile(b, "q.txt", "q by Ann, then Bob\n");
    await writeFile(b, "p.txt", "half resolved\n");
    await expect(abortMerge(b)).rejects.toThrow(MergeAbortRefusedError);
    await writeFile(b, "q.txt", "q by Ann\n"); // back to the merge result
    await abortMerge(b);
    expect(await folderFiles(b)).toEqual({ "p.txt": "p by Bob\n", "q.txt": "q\n" });
  });
});

describe("a rejoin step stopped on does not outlive its crash", () => {
  it("R5: left out again and edited for weeks, the path comes back by a fresh merge", async () => {
    const { r, plain } = await rejoining();
    const f = faulty(plain, () => false);
    f.state.crash = { method: "set", ref: MERGE };
    await expect(syncWorkspace(await f.open(), r())).rejects.toThrow(/crash/);
    // Bob puts the nested repository back, and works in it
    await writeFile(plain, "docs/.git/HEAD", "ref: refs/heads/main\n");
    const ws = await reopen(plain);
    await syncWorkspace(ws, r());
    await writeFile(plain, "docs/e.md", "Bob's much newer work\n");
    await syncWorkspace(ws, r());
    await plain.folder.remove("/docs/.git");
    const later = await reopen(plain);
    const res = await syncWorkspace(later, r());
    expect(res).toMatchObject({ integration: "conflicted", conflicts: ["docs/e.md"] });
    const e = await readFile(plain, "docs/e.md");
    expect(markers(e)).toBe(1);
    expect(e).toContain("Bob's much newer work");
    await abortMerge(later);
    expect(await readFile(plain, "docs/e.md")).toBe("Bob's much newer work\n");
  });
});

describe("a first checkout cut short has nothing to commit the edits on", () => {
  async function firstCheckout() {
    const { server, history } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    const target = (await syncWorkspace(a, r())).head as string;
    const plain = await workspace("Bob");
    const f = faulty(plain, (p) => p === "/b.txt");
    const b = await f.open();
    await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/);
    expect(await headOf(plain)).toBeUndefined();
    f.state.armed = false;
    await writeFile(plain, "c.txt", "c by Bob\n");
    const res = await syncWorkspace(b, r());
    return { r, history, plain, b, target, res };
  }

  it("R9: the branch takes the target, the edits are a commit on it; conclude commits on the target", async () => {
    const { r, history, plain, b, target, res } = await firstCheckout();
    expect(res).toMatchObject({ integration: "conflicted", committed: false });
    expect(res.merge).toMatchObject({ kind: "recovery", head: target, conflicts: ["c.txt"] });
    expect(await headOf(plain)).toBe(target);
    const theirs = res.merge?.theirs as string;
    expect((await plain.history.commits.load(theirs))?.parents).toEqual([target]);
    expect((await treeFiles(plain.history, theirs))["c.txt"]).toBe("c by Bob\n");
    expect(markers(await readFile(plain, "c.txt"))).toBe(1);
    await writeFile(plain, "c.txt", "c by Ann and Bob\n");
    const done = await concludeMerge(b);
    // one parent: no unrelated histories are merged
    expect((await plain.history.commits.load(done.head as string))?.parents).toEqual([target]);
    const pushed = await syncWorkspace(b, r());
    expect(pushed.pushed).toBe(true);
    expect(await serverFiles(history)).toEqual({
      "a.txt": "a\n",
      "b.txt": "b\n",
      "c.txt": "c by Ann and Bob\n",
    });
  });

  it("R9: abort gives the folder's file back on the target; the next sync takes it as an edit", async () => {
    const { r, history, plain, b, target } = await firstCheckout();
    const aborted = await abortMerge(b);
    expect(aborted.head).toBe(target);
    expect(await folderFiles(plain)).toEqual({
      "a.txt": "a\n",
      "b.txt": "b\n",
      "c.txt": "c by Bob\n",
    });
    expect(await plain.history.refs.resolve(MERGE)).toBeUndefined();
    const next = await syncWorkspace(b, r());
    expect(next).toMatchObject({ committed: true, pushed: true });
    const head = (await headOf(plain)) as string;
    expect((await plain.history.commits.load(head))?.parents).toEqual([target]);
    expect((await serverFiles(history))["c.txt"]).toBe("c by Bob\n");
  });
});

/** Second review round: kept directories are still named; releases are still reported. */
describe("a recovery stop on a directory kept in place of the target's file", () => {
  async function nestedBecomesFile() {
    const { server, history } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { README: "r\n", "sub/x.txt": "x\n" });
    await syncWorkspace(a, r());
    const plain = await workspace("Bob");
    await syncWorkspace(plain, r());
    // Bob makes sub/ a repository of its own, with unpushed work
    await writeFile(plain, "sub/.git/HEAD", "ref: refs/heads/main\n");
    await writeFile(plain, "sub/unpushed-work.c", "int x;\n");
    await syncWorkspace(plain, r());
    // Ann replaces the directory by a file
    await a.folder.remove("/sub");
    await writeFile(a, "sub", "now a file\n");
    await writeFile(a, "README", "r2\n");
    const target = (await syncWorkspace(a, r())).head as string;
    return { r, history, plain, target };
  }

  it("N1: the path is still named, as kept, with a hint how to get out; conclude keeps both", async () => {
    const { r, history, plain, target } = await nestedBecomesFile();
    const res = await syncWorkspace(plain, r());
    expect(res).toMatchObject({ integration: "conflicted", conflicts: ["sub"] });
    expect(res.merge).toMatchObject({ kind: "recovery", conflicts: ["sub"], kept: ["sub"] });
    expect(res.merge?.hint).toMatch(/onConflict: "commit"/);
    expect(res.merge?.message).toContain("sub (directory kept)");
    const aside = `sub.theirs-${target.slice(0, 7)}`;
    expect(await readFile(plain, aside)).toBe("now a file\n");
    expect(await readFile(plain, "sub/unpushed-work.c")).toBe("int x;\n");
    await concludeMerge(plain);
    await syncWorkspace(plain, r());
    const served = await serverFiles(history);
    expect(served[aside]).toBe("now a file\n");
    expect(served.README).toBe("r2\n");
    expect(await readFile(plain, "sub/.git/HEAD")).toBe("ref: refs/heads/main\n");
  });

  it("N1: an abort brings the same stop back, still named", async () => {
    const { r, plain } = await nestedBecomesFile();
    await syncWorkspace(plain, r());
    await abortMerge(plain);
    expect(await readFile(plain, "sub/unpushed-work.c")).toBe("int x;\n");
    const again = await syncWorkspace(plain, r());
    expect(again.merge).toMatchObject({ conflicts: ["sub"], kept: ["sub"] });
    expect(again.merge?.hint).toBeDefined();
  });
});

describe("a held file released in a round that finishes a cut-short checkout", () => {
  it("is reported in rejoined", async () => {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "a.txt": "a\n", "b.txt": "b\n", "app.cfg": "v1\n" });
    await syncWorkspace(a, r());
    const plain = await workspace("Bob");
    await syncWorkspace(plain, r());
    const ignoring = await reopen(plain, { ignore: (p) => defaultIgnore(p) || p === "app.cfg" });
    await writeFile(plain, "app.cfg", "local\n");
    await syncWorkspace(ignoring, r());
    await writeFile(a, "a.txt", "a2\n");
    await writeFile(a, "b.txt", "b2\n");
    await syncWorkspace(a, r());
    // app.cfg no longer ignored: held; the checkout is cut short
    const f = faulty(plain, (p) => p === "/b.txt");
    const b = await f.open();
    await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/);
    f.state.armed = false;
    await writeFile(plain, "app.cfg", "v1\n"); // the branch's content again
    const res = await syncWorkspace(b, r());
    expect(res.rejoined).toContain("app.cfg");
    expect(res.skipped).not.toContainEqual({ path: "app.cfg", reason: "unignored-local" });
    expect(await folderFiles(plain)).toEqual({
      "a.txt": "a2\n",
      "app.cfg": "v1\n",
      "b.txt": "b2\n",
    });
  });
});
