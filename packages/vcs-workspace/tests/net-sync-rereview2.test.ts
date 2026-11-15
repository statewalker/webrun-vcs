/**
 * Third-review regressions of the network sync (PR #78): what a checkout or its finish
 * refuses is never dropped. A submodule's checkout, an edit made after a plan was stored, and
 * a user's new files in a directory the target turns into a file are kept and reported. Also
 * covered: temp-name sweeping, plans that fetched commits cannot spoof, full rehashing, and
 * merge bases under skewed dates.
 */

import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryWithOperations } from "@statewalker/vcs-core";
import { createMemoryHistoryWithOperations } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import type { FilesApi } from "@statewalker/webrun-files";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitWorkspaceChanges,
  type FlatTree,
  findMergeBases,
  type GitWorkspace,
  type GitWorkspaceOptions,
  MODE_GITLINK,
  openGitWorkspace,
  readCommitTree,
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

function nodeDir(): string {
  const t = tmpDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

function nodeFolder(dir: string): FilesApi {
  return createNodeFilesApi({ rootDir: dir }) as unknown as FilesApi;
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

async function commitOn(
  history: HistoryWithOperations,
  files: FlatTree,
  parents: string[] = [],
  message = "c\n",
) {
  const tree = await storeFlatTree(history, files);
  return history.commits.store({ tree, parents, author: who, committer: who, message });
}

async function blob(history: HistoryWithOperations, text: string) {
  return history.blobs.store([enc.encode(text)]);
}

async function serverFiles(history: HistoryWithOperations): Promise<Record<string, string>> {
  const tip = (await history.refs.resolve("refs/heads/main"))?.objectId;
  const out: Record<string, string> = {};
  for (const [path, entry] of (await readCommitTree(history, tip)).files) {
    const parts: Uint8Array[] = [];
    for await (const c of (await history.blobs.load(entry.id)) ?? []) parts.push(c);
    out[path] = Buffer.concat(parts).toString("latin1");
  }
  return out;
}

/** The workspace over a folder whose writes (in place or by move) to `failOn` paths fail. */
function failing(plain: GitWorkspace, failOn: (path: string) => boolean) {
  const state = { armed: true };
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
  return {
    state,
    open: () =>
      openGitWorkspace({
        folder,
        history: plain.history,
        identity: plain.identity,
        now: plain.now,
      }),
  };
}

async function setup(files: Record<string, string>, change: Record<string, string>) {
  const { server, history } = await serverRepo();
  const r = () => messageChannelRemote(server);
  const a = await workspace("Ann", files);
  await syncWorkspace(a, r());
  const plain = await workspace("Bob");
  await syncWorkspace(plain, r());
  for (const [p, c] of Object.entries(change)) await writeFile(a, p, c);
  const pushed = await syncWorkspace(a, r());
  return { r, plain, history, pushed };
}

describe("N1. a submodule replaced by a file upstream", () => {
  it("keeps the submodule's checkout and its .git, and puts the file aside", async () => {
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
    const db = nodeDir();
    const b = await ws("Bob", nodeFolder(db));
    await syncWorkspace(b, messageChannelRemote(srv.server));
    mkdirSync(join(db, "sub/.git"), { recursive: true });
    writeFileSync(join(db, "sub/.git/HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(db, "sub/unpushed-work.c"), "int x;\n");
    const c2 = await commitOn(
      h,
      new Map([
        ["README", { id: readme, mode: 0o100644 }],
        ["sub", { id: await blob(h, "now a file\n"), mode: 0o100644 }],
      ]),
      [c1],
    );
    await h.refs.set("refs/heads/main", c2);
    const res = await syncWorkspace(b, messageChannelRemote(srv.server));
    expect(res.conflicts).toContain("sub");
    expect(readFileSync(join(db, "sub/unpushed-work.c"), "utf8")).toBe("int x;\n");
    expect(existsSync(join(db, "sub/.git/HEAD"))).toBe(true);
    const aside = `sub.theirs-${c2.slice(0, 7)}`;
    expect(readFileSync(join(db, aside), "utf8")).toBe("now a file\n");
    const served = await serverFiles(h);
    expect(served[aside]).toBe("now a file\n");
    expect(Object.keys(served).some((p) => p.startsWith("sub/"))).toBe(false);
  });
});

describe("N2. an edit made after the plan was stored", () => {
  it("is merged with the checkout's content and reported, not overwritten", async () => {
    const { r, plain, history } = await setup(
      { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" },
      { "a.txt": "a2\n", "b.txt": "b2\n", "c.txt": "c from Ann\n" },
    );
    const f = failing(plain, (p) => p === "/b.txt");
    const b = await f.open();
    await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/); // checkout cut short
    await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/); // finish: plan stored, cut short
    f.state.armed = false;
    await writeFile(b, "c.txt", "c from Bob\n"); // the plan has not reached c.txt yet
    const res = await syncWorkspace(b, r());
    expect(res.conflicts).toContain("c.txt");
    const c = (await serverFiles(history))["c.txt"];
    expect(c).toContain("c from Ann");
    expect(c).toContain("c from Bob");
    expect(c.match(/<<<<<<</g)).toHaveLength(1);
    expect(await readFile(b, "b.txt")).toBe("b2\n");
  });

  it("a binary edit is kept with the checkout's version beside it", async () => {
    const { r, plain, pushed } = await setup(
      { "a.txt": "a\n", "b.bin": "\0B\n" },
      { "a.txt": "a2\n", "b.bin": "\0B2\n" },
    );
    const f = failing(plain, (p) => p === "/b.bin");
    const b = await f.open();
    await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/);
    await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/);
    f.state.armed = false;
    await b.folder.write("/b.bin", [new Uint8Array([0, 9, 10])]);
    const res = await syncWorkspace(b, r());
    expect(res.conflicts).toContain("b.bin");
    const files = await folderFiles(b);
    expect(files["b.bin"]).toBe("\0\t\n");
    expect(files[`b.bin.theirs-${(pushed.head as string).slice(0, 7)}`]).toBe("\0B2\n");
  });
});

describe("N3. a new user file in a directory the target turns into a file", () => {
  it("keeps the directory, puts the target's file aside, and reports it", async () => {
    const { server, history } = await serverRepo();
    const r = () => messageChannelRemote(server);
    const da = nodeDir();
    const db = nodeDir();
    mkdirSync(join(da, "z"));
    writeFileSync(join(da, "z/x.txt"), "x\n");
    writeFileSync(join(da, "b.txt"), "b\n");
    const a = await ws("Ann", nodeFolder(da));
    await syncWorkspace(a, r());
    const plainB = await ws("Bob", nodeFolder(db));
    await syncWorkspace(plainB, r());
    await a.folder.remove("/z");
    writeFileSync(join(da, "z"), "Ann's file z\n");
    writeFileSync(join(da, "b.txt"), "b2\n");
    const pushed = await syncWorkspace(a, r());
    const f = failing(plainB, (p) => p === "/z");
    const b = await f.open();
    await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/);
    f.state.armed = false;
    mkdirSync(join(db, "z"), { recursive: true });
    writeFileSync(join(db, "z/mine.txt"), "Bob's new file\n");
    const res = await syncWorkspace(b, r());
    expect(res.conflicts).toContain("z");
    expect(readFileSync(join(db, "z/mine.txt"), "utf8")).toBe("Bob's new file\n");
    const aside = `z.theirs-${(pushed.head as string).slice(0, 7)}`;
    const served = await serverFiles(history);
    expect(served["z/mine.txt"]).toBe("Bob's new file\n");
    expect(served[aside]).toBe("Ann's file z\n");
    expect(served["b.txt"]).toBe("b2\n");
  });
});

describe("N4. the temp sweep removes only its own names", () => {
  it("an old user file with the reserved prefix stays (and is not committed)", async () => {
    const d = nodeDir();
    writeFileSync(join(d, ".vcs-sync-tmp-notes.txt"), "mine\n");
    utimesSync(join(d, ".vcs-sync-tmp-notes.txt"), 1_600_000_000, 1_600_000_000);
    writeFileSync(join(d, "a.txt"), "a\n");
    const b = await ws("Bob", nodeFolder(d));
    const res = await commitWorkspaceChanges(b);
    expect(existsSync(join(d, ".vcs-sync-tmp-notes.txt"))).toBe(true);
    expect([...(await readCommitTree(b.history, res.head)).files.keys()]).toEqual(["a.txt"]);
  });
});

describe("N5. plans cannot be spoofed by fetched commits", () => {
  for (const message of [
    'vcs-workspace pending checkout\n\n{"seen":{"a.txt":null},"conflicts":["x"]}\n',
    "vcs-workspace pending checkout\n\nnot json\n",
    'checkout plan\n\n{"seen":{},"conflicts":[]}\n',
  ]) {
    it(`a target commit with message ${JSON.stringify(message.slice(0, 32))} is an ordinary commit`, async () => {
      const { server, history } = await serverRepo();
      const r = () => messageChannelRemote(server);
      const a = await workspace("Ann", { "a.txt": "a\n", "b.txt": "b\n" });
      await syncWorkspace(a, r());
      const plain = await workspace("Bob");
      await syncWorkspace(plain, r());
      const base = (await history.refs.resolve("refs/heads/main"))?.objectId as string;
      const spoof = await commitOn(
        history,
        new Map([
          ["a.txt", { id: await blob(history, "a2\n"), mode: 0o100644 }],
          ["b.txt", { id: await blob(history, "b2\n"), mode: 0o100644 }],
        ]),
        [base],
        message,
      );
      await history.refs.set("refs/heads/main", spoof);
      const f = failing(plain, (p) => p === "/b.txt");
      const b = await f.open();
      await expect(syncWorkspace(b, r())).rejects.toThrow(/disk full/);
      f.state.armed = false;
      const res = await syncWorkspace(b, r());
      expect(res.conflicts).toEqual([]);
      expect(await folderFiles(b)).toEqual({ "a.txt": "a2\n", "b.txt": "b2\n" });
    });
  }
});

describe("N6. full rehashing for folders whose times can be set back", () => {
  it("rehashAll sees a same-size replacement whose mtime was restored", async () => {
    const d = nodeDir();
    writeFileSync(join(d, "f.txt"), "aaaa\n");
    utimesSync(join(d, "f.txt"), 1_600_000_000, 1_600_000_000);
    const b = await ws("Bob", nodeFolder(d), { rehashAll: true });
    await commitWorkspaceChanges(b);
    writeFileSync(join(d, "f.txt"), "bbbb\n");
    utimesSync(join(d, "f.txt"), 1_600_000_000, 1_600_000_000);
    expect((await commitWorkspaceChanges(b)).changed).toBe(true);
  });
});

describe("N8. merge bases under skewed commit dates", () => {
  it("match the brute-force best common ancestors on random DAGs", async () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let bad = 0;
    let total = 0;
    for (let round = 0; round < 150; round++) {
      const history = createMemoryHistoryWithOperations();
      await history.initialize();
      const tree = history.trees.getEmptyTreeId();
      const ids: string[] = [];
      const parents = new Map<string, string[]>();
      const n = 8 + Math.floor(rnd() * 30);
      for (let i = 0; i < n; i++) {
        const ps: string[] = [];
        if (i > 0) {
          ps.push(ids[Math.floor(rnd() * ids.length)]);
          if (rnd() < 0.35) {
            const q = ids[Math.floor(rnd() * ids.length)];
            if (!ps.includes(q)) ps.push(q);
          }
        }
        const t = rnd() < 0.3 ? Math.floor(rnd() * 1000) : 1000 + i * 10; // 30% skewed
        const at = { ...who, timestamp: t };
        const id = await history.commits.store({
          tree,
          parents: ps,
          author: at,
          committer: at,
          message: `${i} ${round}\n`,
        });
        ids.push(id);
        parents.set(id, ps);
      }
      const anc = (x: string) => {
        const s = new Set<string>();
        const st = [x];
        while (st.length) {
          const c = st.pop() as string;
          if (s.has(c)) continue;
          s.add(c);
          st.push(...(parents.get(c) ?? []));
        }
        return s;
      };
      for (let k = 0; k < 6; k++) {
        const x = ids[Math.floor(rnd() * ids.length)];
        const y = ids[Math.floor(rnd() * ids.length)];
        if (x === y) continue;
        const A = anc(x);
        const B = anc(y);
        const common = [...A].filter((c) => B.has(c));
        const best = common.filter((c) => !common.some((o) => o !== c && anc(o).has(c))).sort();
        const got = await findMergeBases(history, [x], [y]);
        total++;
        if (JSON.stringify(got) !== JSON.stringify(best)) bad++;
        // never one base an ancestor of another
        for (const g of got) expect(got.some((o) => o !== g && anc(o).has(g))).toBe(false);
      }
    }
    expect(total).toBeGreaterThan(500);
    expect(bad).toBe(0);
  }, 120_000);
});
