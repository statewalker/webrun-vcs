/**
 * Review of the git-like conflict handling: what was left out when a merge stopped stays left
 * out until it is concluded or aborted (an `ignore` change or a nested repository removed
 * meanwhile never commits, writes or removes those paths); a conclude cut short never wedges
 * the workspace; held files are released when they match the branch again and merged when
 * included after the branch changed them; old skip records keep their three-way rejoin; an
 * abort of a half-written merge follows its plan.
 */

import type { HistoryWithOperations } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";
import {
  abortMerge,
  commitWorkspaceChanges,
  concludeMerge,
  type GitWorkspace,
  type GitWorkspaceOptions,
  NoMergeInProgressError,
  openGitWorkspace,
  readCommitTree,
  readMergeState,
  type SyncEvent,
  syncWorkspace,
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

const reopen = (ws: GitWorkspace, o: Partial<GitWorkspaceOptions> = {}) =>
  openGitWorkspace({
    folder: ws.folder,
    history: ws.history,
    identity: ws.identity,
    now: tick,
    ...o,
  });

function bind<T extends object>(target: T, hook: (prop: string | symbol) => unknown): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const replaced = hook(prop);
      if (replaced !== undefined) return replaced;
      const value = Reflect.get(t, prop, receiver);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

/** Ann and Bob both change p.txt; Bob's sync stops. Returns before Bob's conflicting sync. */
async function setup(annFiles: Record<string, string>, bobOptions: Partial<GitWorkspaceOptions>) {
  const srv = await serverRepo();
  const r = () => messageChannelRemote(srv.server);
  const a = await workspace("Ann", { "p.txt": "title\nbody\n", ...annFiles });
  await syncWorkspace(a, r());
  const plain = await workspace("Bob");
  await syncWorkspace(plain, r());
  const b = await reopen(plain, bobOptions);
  return { ...srv, r, a, b };
}

describe("1. what was left out when a merge stopped stays left out until it ends", () => {
  it("R1: an ignored path un-ignored during the stop keeps the branch's version", async () => {
    const { history, r, a, b } = await setup(
      { "cfg.txt": "v1\n" },
      {
        ignore: (p) => p === "cfg.txt",
      },
    );
    await writeFile(a, "cfg.txt", "v2\n");
    await syncWorkspace(a, r());
    await syncWorkspace(b, r());
    expect(await readFile(b, "cfg.txt")).toBe("v1\n"); // ignored: the folder's stale copy
    await writeFile(a, "p.txt", "title by Ann\nbody\n");
    await syncWorkspace(a, r());
    await writeFile(b, "p.txt", "title by Bob\nbody\n");
    expect((await syncWorkspace(b, r())).integration).toBe("conflicted");
    const b2 = await reopen(b); // cfg.txt no longer ignored
    await writeFile(b2, "p.txt", "resolved\nbody\n");
    await concludeMerge(b2);
    await syncWorkspace(b2, r());
    expect((await serverFiles(history))["cfg.txt"]).toBe("v2\n");
    expect(await readFile(b2, "cfg.txt")).toBe("v2\n"); // brought back by the next commit
  });

  it("R1b: a local .env un-ignored during the stop is not committed by the conclude", async () => {
    const srv = await serverRepo();
    const r = () => messageChannelRemote(srv.server);
    const a = await workspace("Ann", { "p.txt": "title\nbody\n" });
    await syncWorkspace(a, r());
    const plain = await workspace("Bob", { ".env": "TOKEN=secret\n" });
    const b = await reopen(plain, { ignore: (p) => p === ".env" });
    await syncWorkspace(b, r());
    await writeFile(a, "p.txt", "title by Ann\nbody\n");
    await syncWorkspace(a, r());
    await writeFile(b, "p.txt", "title by Bob\nbody\n");
    expect((await syncWorkspace(b, r())).integration).toBe("conflicted");
    const b2 = await reopen(b);
    await writeFile(b2, "p.txt", "resolved\nbody\n");
    await concludeMerge(b2);
    const next = await syncWorkspace(b2, r());
    expect(next.skipped).toContainEqual({ path: ".env", reason: "unignored-local" });
    expect(await serverFiles(srv.history)).toEqual({ "p.txt": "resolved\nbody\n" });
  });

  it("R1c: abort never removes a local file the merge left alone", async () => {
    const { r, a, b } = await setup({}, { ignore: (p) => p === ".env" });
    await writeFile(b, ".env", "TOKEN=secret\n");
    await syncWorkspace(b, r());
    await writeFile(a, ".env", "TOKEN=public\n");
    await writeFile(a, "p.txt", "title by Ann\nbody\n");
    await syncWorkspace(a, r());
    await writeFile(b, "p.txt", "title by Bob\nbody\n");
    expect((await syncWorkspace(b, r())).integration).toBe("conflicted");
    const b2 = await reopen(b);
    await abortMerge(b2);
    expect(await readFile(b2, ".env")).toBe("TOKEN=secret\n");
    expect(await readFile(b2, "p.txt")).toBe("title by Bob\nbody\n");
  });

  it("a nested repository removed during the stop: the conclude keeps the branch's files", async () => {
    const { history, r, a, b } = await setup({ "docs/a.md": "A1\n" }, {});
    await writeFile(b, "docs/.git/HEAD", "ref: refs/heads/main\n");
    await syncWorkspace(b, r());
    await writeFile(a, "docs/a.md", "A2\n");
    await writeFile(a, "p.txt", "title by Ann\nbody\n");
    await syncWorkspace(a, r());
    await writeFile(b, "p.txt", "title by Bob\nbody\n");
    expect((await syncWorkspace(b, r())).integration).toBe("conflicted");
    expect(await readFile(b, "docs/a.md")).toBe("A1\n"); // nested: left alone
    await b.folder.remove("/docs/.git");
    await writeFile(b, "p.txt", "resolved\nbody\n");
    const done = await concludeMerge(b);
    const tree = (await readCommitTree(b.history, done.head)).files;
    expect(tree.get("docs/a.md")?.id).toBe(
      (await readCommitTree(b.history, await headOf(a))).files.get("docs/a.md")?.id,
    );
    const res = await syncWorkspace(b, r());
    expect(res.rejoined).toEqual(["docs/a.md"]);
    expect(await readFile(b, "docs/a.md")).toBe("A2\n");
    expect(await serverFiles(history)).toMatchObject({
      "docs/a.md": "A2\n",
      "p.txt": "resolved\nbody\n",
    });
  });
});

describe("2. a conclude cut short", () => {
  it("between the branch move and the record's removal never wedges the workspace", async () => {
    const { history, r, a, b: plain } = await setup({}, {});
    await writeFile(a, "p.txt", "title by Ann\nbody\n");
    await syncWorkspace(a, r());
    await writeFile(plain, "p.txt", "title by Bob\nbody\n");
    expect((await syncWorkspace(plain, r())).integration).toBe("conflicted");
    let crash = true;
    const refs = bind(plain.history.refs, (prop) =>
      prop === "remove"
        ? async (name: string) => {
            if (crash && name === "refs/workspace/merge/main") {
              crash = false;
              throw new Error("crash");
            }
            return plain.history.refs.remove(name);
          }
        : undefined,
    );
    const b = await reopen(plain, {
      history: bind(plain.history, (p) => (p === "refs" ? refs : undefined)),
    });
    await writeFile(b, "p.txt", "resolved\nbody\n");
    await expect(concludeMerge(b)).rejects.toThrow(/crash/);
    const b2 = await reopen(plain);
    const s = await syncWorkspace(b2, r());
    expect(s).toMatchObject({ integration: "up-to-date", pushed: true });
    expect(await readMergeState(b2)).toBeUndefined();
    await expect(abortMerge(b2)).rejects.toBeInstanceOf(NoMergeInProgressError);
    expect((await serverFiles(history))["p.txt"]).toBe("resolved\nbody\n");
  });
});

describe("3. held files", () => {
  async function held() {
    const s = await setup({ "cfg.txt": "a\nb\nc\nd\ne\n" }, { ignore: (p) => p === "cfg.txt" });
    await writeFile(s.b, "cfg.txt", "A-bob\nb\nc\nd\ne\n");
    await syncWorkspace(s.b, s.r());
    return s;
  }

  it("R2: include after the branch changed it merges three ways, never drops the change", async () => {
    const { history, r, a, b } = await held();
    await writeFile(a, "cfg.txt", "a\nb\nc\nd\nE-ann\n");
    await syncWorkspace(a, r());
    await syncWorkspace(b, r());
    const b2 = await reopen(b);
    const res = await syncWorkspace(b2, r());
    expect(res.skipped).toContainEqual({ path: "cfg.txt", reason: "unignored-local" });
    const included = await commitWorkspaceChanges(b2, { include: ["cfg.txt"] });
    expect(included.rejoined).toEqual(["cfg.txt"]);
    await syncWorkspace(b2, r());
    expect((await serverFiles(history))["cfg.txt"]).toBe("A-bob\nb\nc\nd\nE-ann\n");
    expect(await readFile(b2, "cfg.txt")).toBe("A-bob\nb\nc\nd\nE-ann\n");
  });

  it("R4: a held file holding the branch's content again is released and follows the branch", async () => {
    const { history, r, a, b } = await held();
    const b2 = await reopen(b);
    expect((await syncWorkspace(b2, r())).skipped).toContainEqual({
      path: "cfg.txt",
      reason: "unignored-local",
    });
    await writeFile(b2, "cfg.txt", "a\nb\nc\nd\ne\n"); // back to the branch's version
    const s1 = await syncWorkspace(b2, r());
    expect(s1.skipped).toEqual([]);
    expect(s1.rejoined).toEqual(["cfg.txt"]);
    await writeFile(a, "cfg.txt", "v2\n");
    await syncWorkspace(a, r());
    await syncWorkspace(b2, r());
    expect(await readFile(b2, "cfg.txt")).toBe("v2\n");
    expect((await serverFiles(history))["cfg.txt"]).toBe("v2\n");
  });

  it("a skip record without reasons (older version) keeps its three-way rejoin", async () => {
    const { history, r, b } = await held();
    // rewrite the record as the previous version wrote it: no `nested`, no `held`
    const ref = "refs/workspace/skip/main";
    const id = (await b.history.refs.resolve(ref))?.objectId as string;
    const commit = await b.history.commits.load(id);
    const meta = JSON.parse(commit?.message.slice(commit.message.indexOf("\n\n") + 2) ?? "{}");
    const legacy = await b.history.commits.store({
      ...(commit as NonNullable<typeof commit>),
      parents: [],
      message: `skipped paths\n\n${JSON.stringify({ absent: meta.absent })}\n`,
    });
    await b.history.refs.set(ref, legacy);
    const res = await syncWorkspace(await reopen(b), r());
    expect(res.rejoined).toEqual(["cfg.txt"]);
    expect((await serverFiles(history))["cfg.txt"]).toBe("A-bob\nb\nc\nd\ne\n");
  });
});

describe("4. smaller points", () => {
  it("abort of a half-written merge follows its plan: copies it put beside files go", async () => {
    const { r, a, b: plain } = await setup({ "a.bin": "\0base", "z0.txt": "z\n" }, {});
    await writeFile(a, "a.bin", "\0ann");
    await writeFile(a, "p.txt", "title by Ann\nbody\n");
    await writeFile(a, "z.txt", "new\n");
    await syncWorkspace(a, r());
    await writeFile(plain, "p.txt", "title by Bob\nbody\n");
    await syncWorkspace(plain, r(), { maxAttempts: 1 }).catch(() => undefined);
    const before = await folderFiles(plain);
    expect(before["p.txt"]).toBeDefined();
    const state = { failBin: true, failZ: true };
    const b = await reopen(plain, {
      folder: bind(plain.folder, (prop) => {
        if (prop === "write") {
          return async (path: string, c: Iterable<Uint8Array>) => {
            if (state.failBin && path === "/a.bin") {
              state.failBin = false;
              throw new Error("disk full");
            }
            return plain.folder.write(path, c);
          };
        }
        if (prop === "move") {
          return async (from: string, to: string) => {
            if (state.failZ && to === "/z.txt") throw new Error("disk full");
            return plain.folder.move(from, to);
          };
        }
        return undefined;
      }),
    });
    // the conflicted sync above stopped already: abort it and merge again, cut short twice
    await abortMerge(plain);
    await expect(syncWorkspace(b, r(), { maxAttempts: 1 })).rejects.toThrow(/disk full/);
    await writeFile(plain, "a.bin", "\0user"); // edited before the finish reached it
    await expect(commitWorkspaceChanges(b)).rejects.toThrow(/disk full/);
    const files = await folderFiles(plain);
    expect(Object.keys(files).some((p) => p.startsWith("a.bin.theirs-"))).toBe(true);
    const aborted = await abortMerge(b);
    expect(aborted.kept).toEqual([]);
    expect(await folderFiles(plain)).toEqual({
      "a.bin": "\0base",
      "p.txt": "title by Bob\nbody\n",
      "z0.txt": "z\n",
    });
  });

  it("a stop whose writing was finished by a later sync is reported as started there", async () => {
    const { r, a, b: plain } = await setup({}, {});
    await writeFile(a, "p.txt", "title by Ann\nbody\n");
    await writeFile(a, "q.txt", "q\n");
    await syncWorkspace(a, r());
    await writeFile(plain, "p.txt", "title by Bob\nbody\n");
    let armed = true;
    const b = await reopen(plain, {
      folder: bind(plain.folder, (prop) =>
        prop === "move"
          ? async (from: string, to: string) => {
              if (armed && to === "/q.txt") throw new Error("disk full");
              return plain.folder.move(from, to);
            }
          : undefined,
      ),
    });
    await expect(syncWorkspace(b, r(), { maxAttempts: 1 })).rejects.toThrow(/disk full/);
    armed = false;
    const events: SyncEvent[] = [];
    await syncWorkspace(b, r(), { onEvent: (e) => events.push(e) });
    expect(events.find((e) => e.type === "conflicted")).toMatchObject({ started: true });
    events.length = 0;
    await syncWorkspace(b, r(), { onEvent: (e) => events.push(e) });
    expect(events.find((e) => e.type === "conflicted")).toMatchObject({ started: false });
  });

  it("concludeMerge({ force: true }) concludes with marker lines in place", async () => {
    const { history, r, a, b } = await setup({}, {});
    await writeFile(a, "p.txt", "title by Ann\nbody\n");
    await syncWorkspace(a, r());
    await writeFile(b, "p.txt", "title by Bob\nbody\n");
    await syncWorkspace(b, r());
    await expect(concludeMerge(b)).rejects.toThrow(/conflict markers/);
    await concludeMerge(b, { force: true });
    await syncWorkspace(b, r());
    expect((await serverFiles(history))["p.txt"]).toContain("<<<<<<<");
  });

  it("blobs a skip record names only in its message stay reachable from its commit", async () => {
    const { b } = await setup({ "cfg.txt": "a\nb\n" }, { ignore: (p) => p === "cfg.txt" });
    await writeFile(b, "cfg.txt", "local\n");
    await syncWorkspace(b, messageChannelRemote((await serverRepo()).server)).catch(() => {});
    await commitWorkspaceChanges(await reopen(b)); // held: its base is named in the message
    const id = (await b.history.refs.resolve("refs/workspace/skip/main"))?.objectId as string;
    const commit = await b.history.commits.load(id);
    const meta = JSON.parse(commit?.message.slice(commit.message.indexOf("\n\n") + 2) ?? "{}");
    const base = meta.heldBase["cfg.txt"].id as string;
    const parent = commit?.parents[0] as string;
    const kept = [...(await readCommitTree(b.history, parent)).files.values()].map((e) => e.id);
    expect(kept).toContain(base);
  });
});
