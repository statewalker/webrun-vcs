/**
 * Conflicts handled as git handles them (the default, `onConflict: "stop"`): the merge result
 * goes into the folder, nothing is committed or pushed, and the merge stays in progress until
 * `concludeMerge` or `abortMerge`. Also: files back from being ignored are held out of commits
 * until included; one folder listing per step of a round; a nested repository appearing during
 * a round is never committed as ordinary files; a rejoin is recorded before it is written.
 */

import type { HistoryWithOperations } from "@statewalker/vcs-core";
import type { FilesApi } from "@statewalker/webrun-files";
import { describe, expect, it } from "vitest";
import {
  abortMerge,
  commitWorkspaceChanges,
  concludeMerge,
  type GitWorkspace,
  type GitWorkspaceOptions,
  hasConflictMarkers,
  NoMergeInProgressError,
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
  removeFile,
  serverRepo,
  tick,
  workspace,
  writeFile,
} from "./net-helpers.js";

const enc = new TextEncoder();

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

/** The same folder and repository, opened again (a restart), with other options. */
function reopen(
  ws: GitWorkspace,
  options: Partial<GitWorkspaceOptions> = {},
): Promise<GitWorkspace> {
  return openGitWorkspace({
    folder: ws.folder,
    history: ws.history,
    identity: ws.identity,
    now: tick,
    ...options,
  });
}

/** `plain` opened over a folder whose methods `hook` may replace. */
function proxied(
  plain: GitWorkspace,
  hook: (target: FilesApi, prop: string | symbol) => unknown,
  options: Partial<GitWorkspaceOptions> = {},
): Promise<GitWorkspace> {
  const folder: FilesApi = new Proxy(plain.folder, {
    get(target, prop, receiver) {
      const replaced = hook(target, prop);
      if (replaced !== undefined) return replaced;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return reopen(plain, { folder, ...options });
}

/** Ann and Bob share p.txt; both change its first line, Ann pushes first. */
async function conflicting() {
  const srv = await serverRepo();
  const r = () => messageChannelRemote(srv.server);
  const a = await workspace("Ann", { "p.txt": "title\nbody\n", "keep.txt": "k\n" });
  await syncWorkspace(a, r());
  const b = await workspace("Bob");
  await syncWorkspace(b, r());
  await writeFile(a, "p.txt", "title by Ann\nbody\n");
  await writeFile(a, "q.txt", "q from Ann\n");
  await syncWorkspace(a, r());
  await writeFile(b, "p.txt", "title by Bob\nbody\n");
  return { ...srv, r, a, b };
}

describe("a merge with conflicts stops, as git stops (default)", () => {
  it("writes the markers into the folder, commits and pushes nothing, and reports it", async () => {
    const { history, r, a, b } = await conflicting();
    const served = await serverFiles(history);
    const events: SyncEvent[] = [];
    const res = await syncWorkspace(b, r(), { onEvent: (e) => events.push(e) });
    expect(res.integration).toBe("conflicted");
    expect(res.pushed).toBe(false);
    expect(res.conflicts).toEqual(["p.txt"]);
    expect(res.merge?.theirs).toBe(await headOf(a));
    // the local edit is committed, the branch stays there: no merge commit
    expect(res.committed).toBe(true);
    expect(res.head).toBe(await headOf(b));
    expect((await b.history.commits.load(res.head as string))?.parents).toHaveLength(1);
    const text = await readFile(b, "p.txt");
    expect(text.match(/^<<<<<<< main /gm)).toHaveLength(1);
    expect(text).toContain("title by Ann");
    expect(await readFile(b, "q.txt")).toBe("q from Ann\n"); // the clean part is written too
    expect(await serverFiles(history)).toEqual(served);
    expect(events.find((e) => e.type === "conflicted")).toMatchObject({
      started: true,
      conflicts: ["p.txt"],
    });
    expect(events.some((e) => e.type === "push")).toBe(false);
    // the merge state is a local ref, never pushed
    expect(await b.history.refs.resolve("refs/workspace/merge/main")).toBeDefined();
    expect(await history.refs.resolve("refs/workspace/merge/main")).toBeUndefined();
    expect((await readMergeState(b))?.conflicts).toEqual(["p.txt"]);
  });

  it("while it is in progress, syncs and commits do nothing but report it", async () => {
    const { history, r, b } = await conflicting();
    await syncWorkspace(b, r());
    const head = await headOf(b);
    await writeFile(b, "other.txt", "made during the merge\n");
    const events: SyncEvent[] = [];
    const again = await syncWorkspace(b, r(), { onEvent: (e) => events.push(e) });
    expect(again).toMatchObject({
      integration: "conflicted",
      pushed: false,
      committed: false,
      conflicts: ["p.txt"],
    });
    expect(events.map((e) => e.type)).toEqual(["conflicted"]); // no fetch, no push
    expect(events[0]).toMatchObject({ started: false });
    const commit = await commitWorkspaceChanges(b, "not now");
    expect(commit.changed).toBe(false);
    expect(commit.merge?.conflicts).toEqual(["p.txt"]);
    expect(await headOf(b)).toBe(head);
    expect(await serverFiles(history)).not.toHaveProperty("other.txt");
    // a restart keeps the merge in progress
    const restarted = await reopen(b);
    expect((await syncWorkspace(restarted, r())).integration).toBe("conflicted");
  });

  it("concluding is refused while markers remain; then a merge commit, pushed by the next sync", async () => {
    const { history, r, a, b } = await conflicting();
    const stopped = await syncWorkspace(b, r());
    await expect(concludeMerge(b)).rejects.toBeInstanceOf(UnresolvedConflictsError);
    await expect(concludeMerge(b)).rejects.toMatchObject({ paths: ["p.txt"] });
    await writeFile(b, "p.txt", "title by Ann and Bob\nbody\n");
    const done = await concludeMerge(b);
    expect(done.changed).toBe(true);
    const merge = await b.history.commits.load(done.head as string);
    expect(merge?.parents).toEqual([stopped.head, stopped.merge?.theirs]);
    expect(merge?.message).toContain("Conflicts:\n\tp.txt");
    expect(await readMergeState(b)).toBeUndefined();
    await expect(concludeMerge(b)).rejects.toBeInstanceOf(NoMergeInProgressError);
    const pushed = await syncWorkspace(b, r());
    expect(pushed).toMatchObject({ pushed: true, integration: "up-to-date", committed: false });
    expect(await serverFiles(history)).toEqual({
      "keep.txt": "k\n",
      "p.txt": "title by Ann and Bob\nbody\n",
      "q.txt": "q from Ann\n",
    });
    await syncWorkspace(a, r());
    expect(await folderFiles(a)).toEqual(await folderFiles(b));
  });

  it("aborting restores what the merge changed and keeps other edits", async () => {
    const { history, r, b } = await conflicting();
    const before = (await syncWorkspace(b, r())).head;
    await writeFile(b, "keep.txt", "edited during the merge\n");
    await writeFile(b, "p.txt", "half resolved\n"); // discarded, as git merge --abort does
    const aborted = await abortMerge(b);
    expect(aborted.head).toBe(before);
    expect(aborted.restored).toEqual(["p.txt", "q.txt"]);
    expect(await folderFiles(b)).toEqual({
      "keep.txt": "edited during the merge\n",
      "p.txt": "title by Bob\nbody\n",
    });
    expect(await readMergeState(b)).toBeUndefined();
    await expect(abortMerge(b)).rejects.toBeInstanceOf(NoMergeInProgressError);
    // the next sync commits the other edit and merges again
    const again = await syncWorkspace(b, r());
    expect(again.integration).toBe("conflicted");
    expect(again.committed).toBe(true);
    expect(await serverFiles(history)).not.toHaveProperty("p.txt", "half resolved\n");
  });

  it("a binary conflict keeps ours with theirs beside it; concluding takes the folder as it is", async () => {
    const { history, server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "img.bin": "\0base" });
    await syncWorkspace(a, r());
    const b = await workspace("Bob");
    await syncWorkspace(b, r());
    await writeFile(a, "img.bin", "\0ann");
    const byA = await syncWorkspace(a, r());
    await writeFile(b, "img.bin", "\0bob");
    const res = await syncWorkspace(b, r());
    expect(res).toMatchObject({ integration: "conflicted", conflicts: ["img.bin"] });
    const aside = `img.bin.theirs-${(byA.head as string).slice(0, 7)}`;
    expect(await folderFiles(b)).toEqual({ "img.bin": "\0bob", [aside]: "\0ann" });
    await removeFile(b, aside); // keep ours
    await concludeMerge(b);
    await syncWorkspace(b, r());
    expect(await serverFiles(history)).toEqual({ "img.bin": "\0bob" });
  });

  it("onConflict: 'commit' keeps the former behaviour: committed with markers, pushed", async () => {
    const { history, r, b } = await conflicting();
    const res = await syncWorkspace(b, r(), { onConflict: "commit" });
    expect(res).toMatchObject({ integration: "merge", pushed: true, conflicts: ["p.txt"] });
    expect((await serverFiles(history))["p.txt"]).toContain("<<<<<<<");
    expect(await readMergeState(b)).toBeUndefined();
    // the same as a workspace option
    const c = await conflicting();
    const ws = await reopen(c.b, { onConflict: "commit" });
    expect((await syncWorkspace(ws, c.r())).integration).toBe("merge");
  });

  it("hasConflictMarkers sees git's markers, not a Markdown underline", () => {
    expect(hasConflictMarkers(enc.encode("a\n<<<<<<< main (1)\nx\n=======\ny\n>>>>>>> o\n"))).toBe(
      true,
    );
    expect(hasConflictMarkers(enc.encode("x\r\n>>>>>>>\r\n"))).toBe(true);
    expect(hasConflictMarkers(enc.encode("Title\n=======\n\n<<<<<<<<x\n"))).toBe(false);
    expect(hasConflictMarkers(enc.encode("\0<<<<<<< binary\n"))).toBe(false);
  });
});

describe("a merge whose writing is cut short", () => {
  async function cutShort() {
    const c = await conflicting();
    let armed = true;
    // q.txt is new: staged, then moved in place, after p.txt got its markers
    const b = await proxied(c.b, (target, prop) => {
      if (prop !== "move") return undefined;
      return async (from: string, to: string) => {
        if (armed && to === "/q.txt") throw new Error("disk full");
        return target.move(from, to);
      };
    });
    await expect(syncWorkspace(b, c.r(), { maxAttempts: 1 })).rejects.toThrow(/disk full/);
    return { ...c, b, disarm: () => (armed = false) };
  }

  it("is finished by the next call (after a restart too), one set of markers, nothing pushed", async () => {
    const { history, r, b, disarm } = await cutShort();
    const served = await serverFiles(history);
    expect((await readFile(b, "p.txt")).match(/<<<<<<</g)).toHaveLength(1);
    await expect(syncWorkspace(b, r(), { maxAttempts: 1 })).rejects.toThrow(/disk full/);
    disarm();
    const restarted = await reopen(b);
    const res = await syncWorkspace(restarted, r());
    expect(res).toMatchObject({ integration: "conflicted", pushed: false, conflicts: ["p.txt"] });
    expect((await readFile(b, "p.txt")).match(/<<<<<<</g)).toHaveLength(1);
    expect(await readFile(b, "q.txt")).toBe("q from Ann\n");
    expect(await serverFiles(history)).toEqual(served);
    await writeFile(b, "p.txt", "resolved\n");
    await concludeMerge(restarted);
    await syncWorkspace(restarted, r());
    expect(await serverFiles(history)).toMatchObject({
      "p.txt": "resolved\n",
      "q.txt": "q from Ann\n",
    });
  });

  it("a hand resolution made before the finish is kept, never merged again", async () => {
    const { history, r, b, disarm } = await cutShort();
    await writeFile(b, "p.txt", "title by Ann and Bob\nbody\n");
    disarm();
    const done = await concludeMerge(b); // finishes the writing first
    expect(await readFile(b, "p.txt")).toBe("title by Ann and Bob\nbody\n");
    expect(await readFile(b, "q.txt")).toBe("q from Ann\n");
    expect((await b.history.commits.load(done.head as string))?.parents).toHaveLength(2);
    await syncWorkspace(b, r());
    expect((await serverFiles(history))["p.txt"]).toBe("title by Ann and Bob\nbody\n");
  });

  it("can be aborted: the folder gets the branch tip back", async () => {
    const { b, disarm } = await cutShort();
    disarm();
    await abortMerge(b);
    expect(await folderFiles(b)).toEqual({ "keep.txt": "k\n", "p.txt": "title by Bob\nbody\n" });
    expect(await b.history.refs.resolve("refs/workspace/plan/main")).toBeUndefined();
  });
});

describe("B1. a file back from being ignored", () => {
  const env = (p: string) => p === ".env";

  it("a local .env with secrets never reaches the server by default; include commits it", async () => {
    const { history, server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const plain = await workspace("Ann", { "a.txt": "a\n", ".env": "TOKEN=secret\n" });
    const a = await reopen(plain, { ignore: env });
    await syncWorkspace(a, r());
    expect(await serverFiles(history)).toEqual({ "a.txt": "a\n" });
    // Ann stops ignoring .env
    const a2 = await reopen(a);
    const res = await syncWorkspace(a2, r());
    expect(res.skipped).toContainEqual({ path: ".env", reason: "unignored-local" });
    expect(res.committed).toBe(false);
    expect(await serverFiles(history)).toEqual({ "a.txt": "a\n" });
    expect(await readFile(a2, ".env")).toBe("TOKEN=secret\n");
    await writeFile(a2, "a.txt", "a2\n");
    const later = await syncWorkspace(await reopen(a2), r());
    expect(later.skipped).toContainEqual({ path: ".env", reason: "unignored-local" });
    expect(await serverFiles(history)).toEqual({ "a.txt": "a2\n" });
    // an explicit opt-in commits it
    const included = await commitWorkspaceChanges(a2, { include: [".env"] });
    expect(included.changed).toBe(true);
    await syncWorkspace(a2, r());
    expect(await serverFiles(history)).toEqual({ "a.txt": "a2\n", ".env": "TOKEN=secret\n" });
  });

  it("with a version on the remote: neither merged nor written over, the remote's stays", async () => {
    const { history, server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const bob = await workspace("Bob", { ".env": "TOKEN=public\n", "b.txt": "b\n" });
    await syncWorkspace(bob, r());
    const plain = await workspace("Ann", { ".env": "TOKEN=secret\n" });
    const a = await reopen(plain, { ignore: env });
    await syncWorkspace(a, r());
    expect(await readFile(a, ".env")).toBe("TOKEN=secret\n"); // ignored: never written
    const a2 = await reopen(a);
    const res = await syncWorkspace(a2, r());
    expect(res.skipped).toContainEqual({ path: ".env", reason: "unignored-local" });
    expect(res.rejoined).toEqual([]);
    expect(await readFile(a2, ".env")).toBe("TOKEN=secret\n");
    expect(await serverFiles(history)).toEqual({ ".env": "TOKEN=public\n", "b.txt": "b\n" });
    // the remote changes it meanwhile: still not written over
    await writeFile(bob, ".env", "TOKEN=public2\n");
    await syncWorkspace(bob, r());
    await syncWorkspace(a2, r());
    expect(await readFile(a2, ".env")).toBe("TOKEN=secret\n");
    expect((await serverFiles(history))[".env"]).toBe("TOKEN=public2\n");
    // removing the held file brings the branch's version, never deletes it
    await removeFile(a2, ".env");
    await syncWorkspace(a2, r());
    expect((await serverFiles(history))[".env"]).toBe("TOKEN=public2\n");
    await syncWorkspace(a2, r());
    expect(await readFile(a2, ".env")).toBe("TOKEN=public2\n");
  });

  it("commitUnignored: true commits it as before", async () => {
    const { history, server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const plain = await workspace("Ann", { "a.txt": "a\n", ".env": "TOKEN=x\n" });
    await syncWorkspace(await reopen(plain, { ignore: env }), r());
    await syncWorkspace(await reopen(plain, { commitUnignored: true }), r());
    expect(await serverFiles(history)).toEqual({ "a.txt": "a\n", ".env": "TOKEN=x\n" });
  });
});

describe("B2. folder listings per round", () => {
  it("one listing to commit, one to check out: 2 for a pulling round, 1 for a pushing one", async () => {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "a.txt": "a\n", "d/x.txt": "x\n" });
    await syncWorkspace(a, r());
    const plain = await workspace("Bob");
    await syncWorkspace(plain, r());
    let lists = 0;
    const b = await proxied(plain, (target, prop) => {
      if (prop !== "list") return undefined;
      return (...args: Parameters<FilesApi["list"]>) => {
        lists++;
        return target.list(...args);
      };
    });
    await writeFile(a, "a.txt", "a2\n");
    await writeFile(a, "d/y.txt", "y\n");
    await syncWorkspace(a, r());
    lists = 0;
    expect((await syncWorkspace(b, r())).integration).toBe("fast-forward");
    expect(lists).toBe(2);
    await writeFile(b, "b.txt", "b\n");
    lists = 0;
    expect((await syncWorkspace(b, r())).pushed).toBe(true);
    expect(lists).toBe(1);
  });
});

describe("B3. narrow windows", () => {
  it("(a) a nested repository appearing during the round is not committed as files", async () => {
    const { history, server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "top.txt": "t\n" });
    await syncWorkspace(a, r());
    const plain = await workspace("Bob");
    await syncWorkspace(plain, r());
    await writeFile(a, "top.txt", "t2\n");
    await syncWorkspace(a, r());
    const state = { fail: true, plant: false };
    const b = await proxied(plain, (target, prop) => {
      if (prop !== "write") return undefined;
      return async (path: string, content: Iterable<Uint8Array>) => {
        if (path === "/top.txt" && state.fail) throw new Error("disk full");
        const done = await target.write(path, content);
        if (path === "/top.txt" && state.plant) {
          // `git init` in sub/ while the finish writes top.txt
          state.plant = false;
          await target.write("/sub/.git/HEAD", [enc.encode("ref: refs/heads/main\n")]);
        }
        return done;
      };
    });
    await expect(syncWorkspace(b, r(), { maxAttempts: 1 })).rejects.toThrow(/disk full/);
    await writeFile(plain, "sub/a.txt", "the nested repository's file\n");
    state.fail = false;
    state.plant = true;
    const res = await commitWorkspaceChanges(b);
    expect(await readFile(b, "top.txt")).toBe("t2\n");
    expect(res.skipped).toContainEqual({ path: "sub", reason: "nested-repository" });
    await syncWorkspace(b, r());
    expect(await serverFiles(history)).toEqual({ "top.txt": "t2\n" });
  });

  it("(b) a crash after a rejoin merge is written never merges it twice", async () => {
    const { history: served, server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", {
      "docs/e.md": "title\n",
      "docs/f.md": "f\n",
      "t.txt": "t\n",
    });
    await syncWorkspace(a, r());
    const plain = await workspace("Bob");
    await syncWorkspace(plain, r());
    await writeFile(plain, "docs/.git/HEAD", "ref: refs/heads/main\n");
    await syncWorkspace(plain, r());
    await writeFile(plain, "docs/e.md", "title by Bob\n");
    await writeFile(a, "docs/e.md", "title by Ann\n");
    await syncWorkspace(a, r());
    await syncWorkspace(plain, r());
    await plain.folder.remove("/docs/.git");
    // the record is saved after the merged file is written: that save fails once (a crash)
    let armed = false;
    let crash = false;
    const skipRef = "refs/workspace/skip/main";
    const refs = new Proxy(plain.history.refs, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if ((prop === "set" || prop === "remove") && typeof value === "function") {
          return async (name: string, ...rest: unknown[]) => {
            if (crash && name === skipRef) {
              crash = false;
              throw new Error("crash");
            }
            return (value as (...a: unknown[]) => unknown).call(target, name, ...rest);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const history = new Proxy(plain.history, {
      get(target, prop, receiver) {
        if (prop === "refs") return refs;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    armed = true;
    const b = await proxied(
      plain,
      (target, prop) => {
        if (prop !== "write") return undefined;
        return async (path: string, content: Iterable<Uint8Array>) => {
          const done = await target.write(path, content);
          if (armed && path === "/docs/e.md") {
            armed = false;
            crash = true;
          }
          return done;
        };
      },
      { history },
    );
    await expect(syncWorkspace(b, r())).rejects.toThrow(/crash/);
    const res = await syncWorkspace(await reopen(plain), r());
    const text = await readFile(plain, "docs/e.md");
    expect(text.match(/<<<<<<</g)).toHaveLength(1);
    expect(text).toContain("title by Ann");
    expect(text).toContain("title by Bob");
    expect(res.pushed).toBe(true);
    expect((await serverFiles(served))["docs/e.md"]).toBe(text);
  });
});
