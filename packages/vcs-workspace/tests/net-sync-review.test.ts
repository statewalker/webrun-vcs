/**
 * Review regressions of the network sync (PR #78): the merge base, byte-preserving line
 * merges, ignored and unsafe paths at checkout, modes and submodules, edits during a checkout,
 * case collisions, unfinished checkouts, retry classification and the names of moved-aside
 * files.
 */

import type { HistoryWithOperations } from "@statewalker/vcs-core";
import { createMemoryHistoryWithOperations } from "@statewalker/vcs-core";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  type FlatTree,
  integrateCommit,
  isSafePath,
  MODE_GITLINK,
  mergeFlatTrees,
  openGitWorkspace,
  probeCaseInsensitive,
  readCommitTree,
  SYNC_TEMP_MARK,
  type SyncRemote,
  storeFlatTree,
  syncWorkspace,
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
const who = { name: "Tester", email: "t@example.com", timestamp: 1_700_000_000, tzOffset: "+0000" };

/** A commit of `files` (path → text, or { content, mode }) on `parents`. */
async function commitFiles(
  history: HistoryWithOperations,
  files: Record<string, string | { content?: string; id?: string; mode: number }>,
  parents: string[] = [],
  message = "c",
): Promise<string> {
  const flat: FlatTree = new Map();
  for (const [path, value] of Object.entries(files)) {
    if (typeof value === "string") {
      flat.set(path, { id: await history.blobs.store([enc.encode(value)]), mode: 0o100644 });
    } else {
      const id = value.id ?? (await history.blobs.store([enc.encode(value.content ?? "")]));
      flat.set(path, { id, mode: value.mode });
    }
  }
  const tree = await storeFlatTree(history, flat);
  return history.commits.store({
    tree,
    parents,
    author: who,
    committer: who,
    message: `${message}\n`,
  });
}

/** A workspace over a proxied folder (`hook` sees every call first). */
async function proxied(
  plain: Awaited<ReturnType<typeof workspace>>,
  hook: (target: FilesApi, prop: string | symbol) => unknown,
) {
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

async function workspaceWith(
  name: string,
  files: Record<string, string>,
  options: { ignore?: (p: string) => boolean; caseInsensitive?: boolean } = {},
) {
  const history = createMemoryHistoryWithOperations();
  await history.initialize();
  const initialFiles: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) initialFiles[`/${k}`] = v;
  return openGitWorkspace({
    folder: new MemFilesApi({ initialFiles }),
    history,
    identity: { name, email: `${name}@example.com` },
    now: tick,
    ...options,
  });
}

describe("1. the merge base is the best common ancestor", () => {
  it("a revert after a merged push is not undone, a deletion stays deleted, no self-conflict", async () => {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "f.txt": "orig\n" });
    await syncWorkspace(a, r());
    const b = await workspace("Bob");
    await syncWorkspace(b, r());
    await writeFile(b, "b.txt", "b\n");
    await writeFile(a, "f.txt", "changed by A1\n");
    await writeFile(a, "n.txt", "new\n");
    await syncWorkspace(a, r()); // A1
    await syncWorkspace(b, r()); // merge (B1, A1), pushed
    await writeFile(a, "f.txt", "orig\n"); // A2 reverts A1's change
    await removeFile(a, "n.txt"); // and deletes what A1 added
    const res = await syncWorkspace(a, r());
    expect(res.integration).toBe("merge");
    expect(res.conflicts).toEqual([]);
    expect(await folderFiles(a)).toEqual({ "b.txt": "b\n", "f.txt": "orig\n" });
    await syncWorkspace(b, r());
    expect(await folderFiles(b)).toEqual(await folderFiles(a));
  });

  it("a criss-cross merge uses a virtual base (recursive), not one of the bases", async () => {
    const ws = await workspace("W");
    const h = ws.history;
    const base = await commitFiles(h, { "f.txt": "a\nb\nc\nd\ne\n" });
    const x1 = await commitFiles(h, { "f.txt": "A\nb\nc\nd\ne\n" }, [base]);
    const y1 = await commitFiles(h, { "f.txt": "a\nb\nc\nd\nE\n" }, [base]);
    const m1 = await commitFiles(h, { "f.txt": "A\nb\nc\nd\nE\n" }, [x1, y1]);
    const m2 = await commitFiles(h, { "f.txt": "A\nb\nc\nd\nE\n" }, [y1, x1]);
    const x2 = await commitFiles(h, { "f.txt": "A\nB\nc\nd\nE\n" }, [m1]);
    const y2 = await commitFiles(h, { "f.txt": "A\nb\nc\nD\nE\n" }, [m2]);
    await integrateCommit(ws, x2); // fast-forward from empty
    const merged = await integrateCommit(ws, y2);
    expect(merged.kind).toBe("merge");
    expect(merged.conflicts).toEqual([]);
    expect(await readFile(ws, "f.txt")).toBe("A\nB\nc\nD\nE\n");
  });
});

describe("2. line merges keep every byte", () => {
  async function conflictOrMerge(baseText: Uint8Array, ann: Uint8Array, bob: Uint8Array) {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann");
    await a.folder.write("/f.txt", [baseText]);
    await syncWorkspace(a, r());
    const b = await workspace("Bob");
    await syncWorkspace(b, r());
    await a.folder.write("/f.txt", [ann]);
    await b.folder.write("/f.txt", [bob]);
    const pushed = await syncWorkspace(a, r());
    const res = await syncWorkspace(b, r());
    const parts: Uint8Array[] = [];
    for await (const c of b.folder.read("/f.txt")) parts.push(c);
    return { res, bytes: Buffer.concat(parts), pushed, b };
  }
  const latin1 = (s: string) => Uint8Array.from(Buffer.from(s, "latin1"));

  it("CRLF files stay CRLF", async () => {
    const { res, bytes } = await conflictOrMerge(
      enc.encode("a\r\nb\r\nc\r\nd\r\n"),
      enc.encode("A\r\nb\r\nc\r\nd\r\n"),
      enc.encode("a\r\nb\r\nc\r\nD\r\n"),
    );
    expect(res.conflicts).toEqual([]);
    expect(bytes.toString("latin1")).toBe("A\r\nb\r\nc\r\nD\r\n");
  });

  it("Latin-1 content is merged as bytes, not decoded", async () => {
    const { res, bytes } = await conflictOrMerge(
      latin1("caf\xe9\nb\nc\nd\n"),
      latin1("caf\xe9\nB\nc\nd\n"),
      latin1("caf\xe9\nb\nc\nD\n"),
    );
    expect(res.conflicts).toEqual([]);
    expect(bytes.equals(Buffer.from(latin1("caf\xe9\nB\nc\nD\n")))).toBe(true);
  });

  it("a missing final newline stays missing", async () => {
    const { bytes } = await conflictOrMerge(
      enc.encode("a\nb\nc\nd"),
      enc.encode("A\nb\nc\nd"),
      enc.encode("a\nb\nc\nD"),
    );
    expect(bytes.toString()).toBe("A\nb\nc\nD");
  });

  it("conflict markers are git's, labelled with branch and commit", async () => {
    const { res, bytes, pushed, b } = await conflictOrMerge(
      enc.encode("x\ny\n"),
      enc.encode("ann\ny\n"),
      enc.encode("bob\ny\n"),
    );
    expect(res.conflicts).toEqual(["f.txt"]);
    const merge = await b.history.commits.load(res.head as string);
    const ours = String(merge?.parents[0]).slice(0, 7);
    const theirs = (pushed.head as string).slice(0, 7);
    expect(bytes.toString()).toBe(
      `<<<<<<< main (${ours})\nbob\n=======\nann\n>>>>>>> origin/main (${theirs})\ny\n`,
    );
  });
});

describe("3. ignored and unsafe paths", () => {
  it("ignored paths are never written, removed or deleted from history", async () => {
    const { server, history } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspaceWith("Ann", { "secret.txt": "ann's\n", "a.txt": "a\n" });
    await syncWorkspace(a, r());
    const b = await workspaceWith(
      "Bob",
      { "secret.txt": "bob's local, ignored\n", "b.txt": "b\n" },
      { ignore: (p) => p === "secret.txt" },
    );
    await syncWorkspace(b, r());
    expect(await readFile(b, "secret.txt")).toBe("bob's local, ignored\n");
    await syncWorkspace(b, r());
    const tip = (await history.refs.resolve("refs/heads/main"))?.objectId;
    const served = (await readCommitTree(history, tip)).files;
    expect([...served.keys()].sort()).toEqual(["a.txt", "b.txt", "secret.txt"]);
    await syncWorkspace(a, r());
    expect(await readFile(a, "secret.txt")).toBe("ann's\n");

    // removing the ignored file locally records no deletion
    await removeFile(b, "secret.txt");
    expect((await syncWorkspace(b, r())).committed).toBe(false);
  });

  it("a fetched tree with a .git path (any case) fails the sync and writes nothing", async () => {
    for (const bad of [".git/config", ".GIT/hooks/post-checkout", "sub/.Git/config"]) {
      const { server, history } = await serverRepo();
      const evil = await commitFiles(history, {
        [bad]: "[core]\n\tfsmonitor = touch /tmp/pwned\n",
        "ok.txt": "ok\n",
      });
      await history.refs.set("refs/heads/main", evil);
      const b = await workspace("Bob", { "mine.txt": "mine\n" });
      await expect(syncWorkspace(b, messageChannelRemote(server))).rejects.toThrow(/unsafe path/);
      expect(await folderFiles(b)).toEqual({ "mine.txt": "mine\n" });
      // the local commit is all that moved
      expect((await b.history.commits.load((await headOf(b)) as string))?.parents).toEqual([]);
    }
  });

  it("a folder's .git directory is never committed, even when nothing is ignored", async () => {
    const { server, history } = await serverRepo();
    const a = await workspaceWith(
      "Ann",
      { ".git/config": "[core]\n\tfsmonitor = evil\n", "a.txt": "a\n" },
      { ignore: () => false },
    );
    await syncWorkspace(a, messageChannelRemote(server));
    const tip = (await history.refs.resolve("refs/heads/main"))?.objectId;
    expect([...(await readCommitTree(history, tip)).files.keys()]).toEqual(["a.txt"]);
  });

  it("isSafePath follows git's verify_path", () => {
    for (const p of ["a.txt", "dir/a", ".gitignore", ".github/x", "a..b"]) {
      expect(isSafePath(p)).toBe(true);
    }
    for (const p of [
      "",
      "/abs",
      "a//b",
      "a/",
      "./a",
      "a/../b",
      ".git",
      ".GIT/x",
      ".git./x",
      "git~1/x",
      "a\\b",
      "a\0b",
    ]) {
      expect(isSafePath(p)).toBe(false);
    }
  });
});

describe("4. modes and submodules survive", () => {
  it("executable bits and submodule entries are carried over, not rewritten", async () => {
    const srv = await serverRepo();
    const h = srv.history;
    const c = await commitFiles(h, {
      "run.sh": { content: "#!/bin/sh\n", mode: 0o100755 },
      sub: { id: "1".repeat(40), mode: MODE_GITLINK },
      "a.txt": "a\n",
    });
    await h.refs.set("refs/heads/main", c);
    const b = await workspace("Bob");
    const first = await syncWorkspace(b, messageChannelRemote(srv.server));
    expect(first).toMatchObject({ integration: "fast-forward", pushed: false });
    expect(await folderFiles(b)).toEqual({ "a.txt": "a\n", "run.sh": "#!/bin/sh\n" });
    expect((await syncWorkspace(b, messageChannelRemote(srv.server))).committed).toBe(false);

    await writeFile(b, "run.sh", "#!/bin/sh\necho hi\n");
    await syncWorkspace(b, messageChannelRemote(srv.server));
    const tip = (await h.refs.resolve("refs/heads/main"))?.objectId;
    const files = (await readCommitTree(h, tip)).files;
    expect(files.get("run.sh")?.mode).toBe(0o100755);
    expect(files.get("sub")).toEqual({ id: "1".repeat(40), mode: MODE_GITLINK });
  });
});

describe("5. an edit made during the checkout is not overwritten", () => {
  it("the checkout stops at the edited file and the round merges the edit", async () => {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "x.txt": "base\n", "z.txt": "z\n" });
    await syncWorkspace(a, r());
    const plainB = await workspace("Bob");
    await syncWorkspace(plainB, r());
    await writeFile(a, "x.txt", "ann\n");
    await syncWorkspace(a, r());

    let fired = false;
    const b = await proxied(plainB, (target, prop) => {
      if (prop !== "write") return undefined;
      return async (path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) => {
        // between the check and the write: the user saves x.txt
        if (!fired && path.includes(SYNC_TEMP_MARK)) {
          fired = true;
          await target.write("/x.txt", [enc.encode("bob's edit\n")]);
        }
        return target.write(path, content);
      };
    });
    await syncWorkspace(b, r());
    expect(fired).toBe(true);
    const text = await readFile(b, "x.txt");
    expect(text).toContain("bob's edit");
    expect(text).toContain("ann");
  });
});

describe("6. paths differing only in case", () => {
  it("on a case-insensitive folder one of them is moved aside and reported", async () => {
    const srv = await serverRepo();
    const c = await commitFiles(srv.history, { "README.md": "upper\n", "Readme.md": "mixed\n" });
    await srv.history.refs.set("refs/heads/main", c);
    const b = await workspaceWith("Bob", {}, { caseInsensitive: true });
    const res = await syncWorkspace(b, messageChannelRemote(srv.server));
    expect(res.conflicts).toEqual(["Readme.md"]);
    const files = await folderFiles(b);
    expect(files["README.md"]).toBe("upper\n");
    const aside = Object.keys(files).find((p) => p.startsWith("Readme.md.case-"));
    expect(aside && files[aside]).toBe("mixed\n");
    expect(res.pushed).toBe(true);
  });

  it("probeCaseInsensitive tells the folders apart", async () => {
    expect(await probeCaseInsensitive(new MemFilesApi())).toBe(false);
    const mem = new MemFilesApi();
    const lower = (p: string) => p.toLowerCase();
    const folded = new Proxy(mem, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (typeof v !== "function") return v;
        return (path: string, ...rest: unknown[]) =>
          (v as (...a: unknown[]) => unknown).call(target, lower(path), ...rest);
      },
    }) as FilesApi;
    expect(await probeCaseInsensitive(folded)).toBe(true);
    // the probe leaves nothing behind
    const left: string[] = [];
    for await (const e of mem.list("/", { recursive: true })) left.push(e.path);
    expect(left).toEqual([]);
  });
});

describe("7. a checkout cut short is finished, not committed as local edits", () => {
  it("after a conflicted merge whose checkout failed, the next sync has one set of markers", async () => {
    const { server } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const a = await workspace("Ann", { "p.txt": "title\nbody\n" });
    await syncWorkspace(a, r());
    const plainB = await workspace("Bob");
    await syncWorkspace(plainB, r());
    await writeFile(a, "p.txt", "title by Ann\nbody\n");
    await writeFile(a, "q.txt", "q\n");
    await syncWorkspace(a, r());

    let armed = false;
    let writes = 0;
    const b = await proxied(plainB, (target, prop) => {
      if (prop !== "write") return undefined;
      return async (path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) => {
        if (armed && ++writes > 1) throw new Error("disk full");
        return target.write(path, content);
      };
    });
    await writeFile(b, "p.txt", "title by Bob\nbody\n");
    armed = true;
    await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/);
    armed = false;
    const res = await syncWorkspace(b, r());
    const text = await readFile(b, "p.txt");
    expect(text.match(/<<<<<<</g)).toHaveLength(1);
    expect(text).toContain("title by Ann");
    expect(text).toContain("title by Bob");
    expect(await readFile(b, "q.txt")).toBe("q\n");
    expect(res.pushed).toBe(true);
    await syncWorkspace(a, r());
    expect(await folderFiles(a)).toEqual(await folderFiles(b));
  });
});

describe("8. only lost races are retried", () => {
  it("a declined hook is a refusal, not a retry", async () => {
    const served = await serverRepo();
    const { createSyncServer } = await import("../src/net/index.js");
    const server = createSyncServer({
      repository: served.repository,
      refStore: served.refStore,
      hooks: { update: () => false },
    });
    const base = messageChannelRemote(server);
    let pushes = 0;
    const counting: SyncRemote = {
      name: base.name,
      fetch: (o) => base.fetch(o),
      push: (o) => {
        pushes++;
        return base.push(o);
      },
    };
    const a = await workspace("Ann", { "a.txt": "a\n" });
    await expect(syncWorkspace(a, counting)).rejects.toThrow(/refused.*hook declined/);
    expect(pushes).toBe(1);
  });

  it("a ref that moved under receive-pack's compare-and-swap is retried", async () => {
    const { server } = await serverRepo();
    const base = messageChannelRemote(server);
    const reasons = [
      "cannot lock ref 'refs/heads/main': is at 1111111111111111111111111111111111111111 but expected 2222222222222222222222222222222222222222",
      "failed to update ref",
    ];
    let pushes = 0;
    const losing: SyncRemote = {
      name: base.name,
      fetch: (o) => base.fetch(o),
      async push(o) {
        const reason = reasons[pushes++];
        const result = await base.push(reason ? { ...o, refspecs: [] } : o);
        if (!reason) return result;
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
              message: reason,
              summary: `[remote rejected] (${reason})`,
            },
          ],
        };
      },
    };
    const a = await workspace("Ann", { "a.txt": "a\n" });
    const res = await syncWorkspace(a, losing);
    expect(res).toMatchObject({ attempts: 3, pushed: true });
  });
});

describe("9. merge corner cases", () => {
  const ids = async (history: HistoryWithOperations, files: Record<string, string>) => {
    const out: FlatTree = new Map();
    for (const [p, v] of Object.entries(files)) {
      out.set(p, { id: await history.blobs.store([enc.encode(v)]), mode: 0o100644 });
    }
    return out;
  };

  it("change against deletion keeps the change and reports it", async () => {
    const ws = await workspace("W");
    const h = ws.history;
    const r = await mergeFlatTrees(
      h,
      await ids(h, { "f.txt": "1\n" }),
      await ids(h, { "f.txt": "2\n" }),
      new Map(),
    );
    expect([...r.files.keys()]).toEqual(["f.txt"]);
    expect(r.conflicts).toEqual(["f.txt"]);
  });

  it("file against directory: the file moves aside under its own side's name", async () => {
    const ws = await workspace("W");
    const h = ws.history;
    const r = await mergeFlatTrees(
      h,
      new Map(),
      await ids(h, { x: "file\n" }),
      await ids(h, { "x/y": "nested\n" }),
      { oursTag: "ours-1111111", theirsTag: "theirs-2222222" },
    );
    expect([...r.files.keys()].sort()).toEqual(["x.ours-1111111", "x/y"]);
    expect(r.conflicts).toEqual(["x"]);
  });

  it("names of moved-aside files never collide", async () => {
    const ws = await workspace("W");
    const h = ws.history;
    const bin = async (s: string) => ({
      id: await h.blobs.store([enc.encode(`\0${s}`)]),
      mode: 0o100644,
    });
    const base: FlatTree = new Map([["img.bin", await bin("base")]]);
    const ours: FlatTree = new Map([
      ["img.bin", await bin("ours")],
      ["img.bin.theirs-2222222", await bin("already here")],
    ]);
    const theirs: FlatTree = new Map([["img.bin", await bin("theirs")]]);
    const r = await mergeFlatTrees(h, base, ours, theirs, { theirsTag: "theirs-2222222" });
    expect(r.files.get("img.bin.theirs-2222222")).toEqual(ours.get("img.bin.theirs-2222222"));
    expect(r.files.get("img.bin.theirs-2222222-2")).toEqual(theirs.get("img.bin"));
    expect(r.conflicts).toEqual(["img.bin"]);
  });
});
