/**
 * Edge cases of git-files ref batches, checked against native git 2.43:
 * noDeref and reflogs, a ref that becomes symbolic while a batch locks,
 * readers that never combine states, and D/F races on disk.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FilesApi } from "@statewalker/vcs-core";
import { createRefBatchTests } from "@statewalker/vcs-testing";
import type { AtomicFiles } from "@statewalker/vcs-utils/files";
import { createNodeAtomicFiles, createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import {
  createFilesRefBatch,
  createRefsStructure,
  FileRefStore,
  readAllRefs,
} from "../../src/refs/index.js";

const IDENT = "A U Thor <author@example.com> 1700000000 +0000";
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "A U Thor",
  GIT_COMMITTER_EMAIL: "author@example.com",
  GIT_COMMITTER_DATE: "1700000000 +0000",
  // Both dates fixed: twin repositories must get the same commit ids.
  GIT_AUTHOR_DATE: "1700000000 +0000",
};
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, { cwd, input, env: GIT_ENV, encoding: "utf8" }).trim();

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "refs-edge-"));
  roots.push(dir);
  git(dir, ["init", "-q", "-b", "main", "."]);
  return dir;
}
function commits(repo: string, n: number): string[] {
  const blob = git(repo, ["hash-object", "-w", "--stdin"], "x\n");
  const tree = git(repo, ["mktree"], `100644 blob ${blob}\tf\n`);
  return Array.from({ length: n }, (_, i) => git(repo, ["commit-tree", "-m", `c${i}`, tree]));
}
/** Reflog lines without the identity, for comparing ours with git's. */
function logLines(repo: string, ref: string): string[] {
  const path = join(repo, ".git", "logs", ref);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(0, 81));
}
/** Two repositories with the same commits: one updated by git, one by our batch. */
function twins(n: number): { ours: string; theirs: string; cs: string[] } {
  const ours = newRepo();
  const cs = commits(ours, n);
  const theirs = newRepo();
  commits(theirs, n);
  return { ours, theirs, cs };
}
const batchFor = (repo: string, options = {}) =>
  createFilesRefBatch(createNodeAtomicFiles(join(repo, ".git")), options);
const updateRef = (repo: string, stdin: string, extra: string[] = []) =>
  git(repo, ["update-ref", ...extra, "-m", "msg", "--stdin"], stdin);

// The full batch contract on disk, through FileRefStore with native lock files.
createRefBatchTests("Git files on disk (native AtomicFiles)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refs-contract-"));
  roots.push(dir);
  const files = createNodeFilesApi({ rootDir: dir });
  await files.mkdir(".git");
  await createRefsStructure(files, ".git");
  return {
    refs: new FileRefStore(files, ".git", {
      atomicFiles: createNodeAtomicFiles(join(dir, ".git")),
    }),
  };
});

describe("reflogs as git writes them", () => {
  it("noDeref on a symbolic HEAD: same refs and same HEAD log line as git", async () => {
    const { ours, theirs, cs } = twins(2);
    const [c0, c1] = cs as [string, string];
    for (const repo of [ours, theirs]) git(repo, ["update-ref", "refs/heads/main", c0]);
    expect(
      await batchFor(ours)([{ name: "HEAD", old: c0, new: c1, noDeref: true }], {
        ident: IDENT,
        message: "msg",
      }),
    ).toEqual({ ok: true, rejected: [] });
    updateRef(theirs, `update HEAD ${c1} ${c0}\n`, ["--no-deref"]);
    for (const repo of [ours, theirs]) {
      expect(spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: repo }).status).not.toBe(0);
      expect(git(repo, ["rev-parse", "HEAD", "refs/heads/main"])).toBe(`${c1}\n${c0}`);
    }
    expect(logLines(ours, "HEAD")).toEqual(logLines(theirs, "HEAD"));
  });

  it("no-op update and delete of HEAD's branch: the same log lines as git", async () => {
    const { ours, theirs, cs } = twins(1);
    const [c0] = cs as [string];
    const z = "0".repeat(40);
    for (const repo of [ours, theirs]) git(repo, ["update-ref", "refs/heads/main", c0]);
    await batchFor(ours)([{ name: "refs/heads/main", old: c0, new: c0 }], {
      ident: IDENT,
      message: "msg",
    });
    updateRef(theirs, `update refs/heads/main ${c0} ${c0}\n`);
    expect(logLines(ours, "refs/heads/main")).toEqual(logLines(theirs, "refs/heads/main"));
    expect(logLines(ours, "HEAD")).toEqual(logLines(theirs, "HEAD"));
    await batchFor(ours)([{ name: "refs/heads/main", old: c0, new: null }], {
      ident: IDENT,
      message: "msg",
    });
    updateRef(theirs, `delete refs/heads/main ${c0}\n`);
    expect(existsSync(join(ours, ".git", "logs", "refs", "heads", "main"))).toBe(false);
    expect(logLines(ours, "HEAD")).toEqual(logLines(theirs, "HEAD"));
    expect(logLines(ours, "HEAD").at(-1)).toBe(`${c0} ${z}`);
  });

  it("creates logs for branches but not for tags, as git does", async () => {
    const { ours, theirs, cs } = twins(1);
    const [c0] = cs as [string];
    await batchFor(ours)(
      [
        { name: "refs/heads/b", new: c0 },
        { name: "refs/tags/t", new: c0 },
      ],
      { ident: IDENT, message: "msg" },
    );
    updateRef(theirs, `create refs/heads/b ${c0}\ncreate refs/tags/t ${c0}\n`);
    for (const ref of ["refs/heads/b", "refs/tags/t"]) {
      expect(logLines(ours, ref), ref).toEqual(logLines(theirs, ref));
    }
    expect(logLines(ours, "refs/tags/t")).toEqual([]);
  });

  it("reads back lines that have no message (written by compareAndSwap)", async () => {
    const repo = newRepo();
    const [c0, c1] = commits(repo, 2) as [string, string];
    const files = createNodeFilesApi({ rootDir: repo });
    const store = new FileRefStore(files, ".git", {
      atomicFiles: createNodeAtomicFiles(join(repo, ".git")),
    });
    expect((await store.compareAndSwap("refs/heads/main", undefined, c0)).success).toBe(true);
    expect((await store.compareAndSwap("refs/heads/main", c0, c1)).success).toBe(true);
    const log = await store.getReflog("refs/heads/main");
    const entries = (await log?.getReverseEntries()) ?? [];
    expect(entries.map((e) => `${e.oldId.slice(0, 7)}>${e.newId.slice(0, 7)}`)).toEqual([
      `${c0.slice(0, 7)}>${c1.slice(0, 7)}`,
      `${"0".repeat(7)}>${c0.slice(0, 7)}`,
    ]);
  });
});

describe("lock files are not refs", () => {
  it("listing and optimize skip another writer's <ref>.lock and leave it in place", async () => {
    const repo = newRepo();
    const [c0, c1] = commits(repo, 2) as [string, string];
    git(repo, ["update-ref", "refs/heads/main", c0]);
    const lock = join(repo, ".git", "refs", "heads", "main.lock");
    writeFileSync(lock, `${c1}\n`); // git (or another batch) is mid-update
    const store = new FileRefStore(createNodeFilesApi({ rootDir: repo }), ".git", {
      atomicFiles: createNodeAtomicFiles(join(repo, ".git")),
    });
    const names: string[] = [];
    for await (const ref of store.list("refs/")) names.push(ref.name);
    expect(names).toEqual(["refs/heads/main"]);
    await store.optimize?.();
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(join(repo, ".git", "packed-refs"), "utf8")).not.toContain("main.lock");
  });
});

describe("races with other writers", () => {
  it("refuses a name that became a symbolic ref while the batch was locking", async () => {
    const repo = newRepo();
    const [c0, c1] = commits(repo, 2) as [string, string];
    git(repo, ["update-ref", "refs/heads/main", c0]);
    git(repo, ["update-ref", "--no-deref", "HEAD", c0]); // detached
    const native = createNodeAtomicFiles(join(repo, ".git"));
    let reattached = false;
    const racing: AtomicFiles = {
      ...native,
      async createExclusive(path, content) {
        if (!reattached) {
          reattached = true; // a concurrent `git checkout main`
          writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
        }
        return native.createExclusive(path, content);
      },
    };
    const r = await createFilesRefBatch(racing)([{ name: "HEAD", old: c0, new: c1 }]);
    expect(r).toEqual({ ok: false, rejected: [{ name: "HEAD", reason: "mismatch" }] });
    expect(git(repo, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    expect(git(repo, ["rev-parse", "refs/heads/main"])).toBe(c0);
  });

  it("refuses a multi-ref batch that replaces a symbolic ref (noDeref), changing nothing", async () => {
    const repo = newRepo();
    const [c0] = commits(repo, 1) as [string];
    git(repo, ["update-ref", "refs/heads/main", c0]);
    git(repo, ["symbolic-ref", "refs/remotes/o/HEAD", "refs/heads/main"]);
    const r = await batchFor(repo)([
      { name: "refs/remotes/o/HEAD", new: c0, noDeref: true },
      { name: "refs/heads/x", new: c0 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.rejected.every((x) => x.reason === "unsupported")).toBe(true);
    expect(git(repo, ["symbolic-ref", "refs/remotes/o/HEAD"])).toBe("refs/heads/main");
  });

  it("a listing never combines old and new states while a two-phase batch commits", async () => {
    const repo = newRepo();
    const [c0, c1] = commits(repo, 2) as [string, string];
    const batch = batchFor(repo);
    await batch([{ name: "refs/heads/a", new: c0 }]); // loose
    await batch([{ name: "refs/heads/b", new: c0 }]); // loose
    const disk = createNodeFilesApi({ rootDir: repo });
    let fired = false;
    // Run the whole batch right after the reader's first loose scan, before it reads packed-refs.
    const reader: FilesApi = new Proxy(disk, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "read") return typeof value === "function" ? value.bind(target) : value;
        return (path: string, options?: unknown) => {
          if (!fired && path.endsWith("packed-refs")) {
            fired = true;
            return (async function* () {
              const r = await batch([
                { name: "refs/heads/a", old: c0, new: c1 },
                { name: "refs/heads/b", old: c0, new: c1 },
              ]);
              expect(r.ok).toBe(true);
              yield* disk.read(path, options as never);
            })();
          }
          return disk.read(path, options as never);
        };
      },
    });
    const refs = await readAllRefs(reader, ".git", "refs/heads/");
    expect(fired).toBe(true);
    const values = new Set(refs.map((r) => ("objectId" in r ? r.objectId : "")));
    expect(values.size).toBe(1);
  });

  it("concurrent creates of refs/x and refs/x/y never both succeed", async () => {
    const [c0] = commits(newRepo(), 1) as [string];
    for (let trial = 0; trial < 30; trial++) {
      const repo = newRepo();
      const a = batchFor(repo, { refLockTimeoutMs: 0 });
      const b = batchFor(repo, { refLockTimeoutMs: 0 });
      const [r1, r2] = await Promise.all([
        a([{ name: "refs/x", old: null, new: c0 }]),
        b([{ name: "refs/x/y", old: null, new: c0 }]),
      ]);
      expect(r1.ok && r2.ok, `trial ${trial}`).toBe(false);
    }
  }, 60_000);
});
