/**
 * Atomic ref batches on a real .git directory: native git reads what the batch
 * writes, locks interoperate both ways, and a crash at any file operation
 * leaves every ref at its old or new value. Needs native git.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectId } from "@statewalker/vcs-core";
import type { AtomicFiles } from "@statewalker/vcs-utils/files";
import { atomicFilesOver } from "@statewalker/vcs-utils/files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createFilesRefBatch } from "../../src/refs/index.js";

/** One FilesApi per repository: atomicFilesOver excludes writers sharing an instance. */
const sharedFiles = new Map<string, ReturnType<typeof createNodeFilesApi>>();
function atomicFor(root: string) {
  let files = sharedFiles.get(root);
  if (!files) {
    files = createNodeFilesApi({ rootDir: root });
    sharedFiles.set(root, files);
  }
  return atomicFilesOver(files, ".git");
}

const IDENT = "A U Thor <author@example.com> 1700000000 +0000";
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A fixed identity, so git works on machines without user.name / user.email (CI). */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "A",
  GIT_AUTHOR_EMAIL: "a@b",
  GIT_COMMITTER_NAME: "A",
  GIT_COMMITTER_EMAIL: "a@b",
};
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, { cwd, input, env: GIT_ENV, encoding: "utf8" }).trim();
const gitTry = (cwd: string, args: string[]) =>
  spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "refs-git-"));
  roots.push(dir);
  git(dir, ["init", "-q", "-b", "main", "."]);
  return dir;
}

function commits(repo: string, n: number): ObjectId[] {
  const blob = git(repo, ["hash-object", "-w", "--stdin"], "x\n");
  const tree = git(repo, ["mktree"], `100644 blob ${blob}\tf\n`);
  return Array.from({ length: n }, (_, i) => git(repo, ["commit-tree", "-m", `c${i}`, tree]));
}

/** Resolve a ref as native git does (undefined if absent). */
function gitResolve(repo: string, name: string): string | undefined {
  const r = gitTry(repo, ["rev-parse", "--verify", "-q", name]);
  return r.status === 0 ? r.stdout.trim() : undefined;
}

describe("git files interop", () => {
  it("native git reads refs, packed-refs, symbolic HEAD and reflogs written by batches", async () => {
    const repo = newRepo();
    const [c0, c1, c2] = commits(repo, 3) as [string, string, string];
    const batch = createFilesRefBatch(atomicFor(repo));
    expect(
      await batch([{ name: "refs/heads/main", old: null, new: c0 }], {
        ident: IDENT,
        message: "single",
      }),
    ).toEqual({ ok: true, rejected: [] });
    expect(
      await batch(
        [
          { name: "refs/heads/main", old: c0, new: c1 },
          { name: "refs/heads/topic", old: null, new: c2 },
          { name: "refs/tags/t1", old: null, new: c0 },
        ],
        { ident: IDENT, message: "batch" },
      ),
    ).toEqual({ ok: true, rejected: [] });
    expect(git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(
      [`refs/heads/main ${c1}`, `refs/heads/topic ${c2}`, `refs/tags/t1 ${c0}`].join("\n"),
    );
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(c1);
    expect(git(repo, ["reflog", "show", "--format=%H %gs", "refs/heads/main"])).toBe(
      `${c1} batch\n${c0} single`,
    );
    // HEAD points at main, so its reflog records main's updates too, as git logs them.
    expect(git(repo, ["reflog", "show", "--format=%H %gs", "HEAD"])).toBe(
      `${c1} batch\n${c0} single`,
    );
    const fsck = gitTry(repo, ["fsck", "--no-dangling"]);
    expect(fsck.status, fsck.stderr + fsck.stdout).toBe(0);
  });

  it("reads refs git wrote loose and packed, keeps its peel lines, and git reads the rewrite", async () => {
    const repo = newRepo();
    const [c0, c1, c2] = commits(repo, 3) as [string, string, string];
    git(repo, ["update-ref", "refs/heads/main", c0]);
    git(repo, ["update-ref", "refs/heads/old", c1]);
    git(repo, ["tag", "-a", "-m", "annotated", "v1", c0]);
    git(repo, ["pack-refs", "--all"]);
    git(repo, ["update-ref", "refs/heads/loose", c2]);
    const tagObj = git(repo, ["rev-parse", "refs/tags/v1"]);
    const batch = createFilesRefBatch(atomicFor(repo));
    const r = await batch([
      { name: "refs/heads/old", old: c1, new: null }, // packed delete
      { name: "refs/heads/loose", old: c2, new: c1 }, // loose update
      { name: "refs/heads/main", old: c0, new: c2 }, // packed update
    ]);
    expect(r).toEqual({ ok: true, rejected: [] });
    expect(git(repo, ["for-each-ref", "--format=%(refname) %(objectname) %(*objectname)"])).toBe(
      [`refs/heads/loose ${c1} `, `refs/heads/main ${c2} `, `refs/tags/v1 ${tagObj} ${c0}`].join(
        "\n",
      ),
    );
    expect(readFileSync(join(repo, ".git", "packed-refs"), "utf8")).toContain(`^${c0}`);
    expect(gitResolve(repo, "refs/heads/old")).toBeUndefined();
  });

  it("git's locks make a batch report locked; our packed-refs lock blocks git", async () => {
    const repo = newRepo();
    const [c0, c1] = commits(repo, 2) as [string, string];
    git(repo, ["update-ref", "refs/heads/main", c0]);
    const files = atomicFor(repo);
    expect(
      await files.createExclusive("refs/heads/main.lock", new TextEncoder().encode(`${c1}\n`)),
    ).toBe(true);
    const batch = createFilesRefBatch(files, { refLockTimeoutMs: 50 });
    const r = await batch([
      { name: "refs/heads/main", old: c0, new: c1 },
      { name: "refs/heads/x", new: c1 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.rejected).toContainEqual({ name: "refs/heads/main", reason: "locked" });
    expect(
      readdirSync(join(repo, ".git", "refs", "heads")).filter((n) => n.endsWith(".lock")),
    ).toEqual(["main.lock"]);
    await files.remove("refs/heads/main.lock");
    expect(await files.createExclusive("packed-refs.lock", new Uint8Array(0))).toBe(true);
    const g = gitTry(repo, [
      "-c",
      "core.packedRefsTimeout=0",
      "update-ref",
      "-d",
      "refs/heads/main",
    ]);
    expect(g.status).not.toBe(0);
    expect(g.stderr).toMatch(/packed-refs\.lock|Unable to create/);
  });
});

/** AtomicFiles that dies at the k-th call: that call and every later one throw. */
function dyingAt(inner: AtomicFiles, k: number): AtomicFiles {
  let calls = 0;
  let dead = false;
  const gate = () => {
    calls++;
    if (dead || calls === k) {
      dead = true;
      throw new Error(`crash at call ${k}`);
    }
  };
  const wrap =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A) => {
      gate();
      return fn(...a);
    };
  return {
    read: (p) => ({
      async *[Symbol.asyncIterator]() {
        gate();
        yield* inner.read(p);
      },
    }),
    exists: wrap(inner.exists),
    remove: wrap(inner.remove),
    createExclusive: wrap(inner.createExclusive),
    replace: wrap(inner.replace),
    write: wrap(inner.write),
    list: (d) => ({
      async *[Symbol.asyncIterator]() {
        gate();
        yield* inner.list(d);
      },
    }),
    append: wrap(inner.append),
    removeEmptyDir: wrap(inner.removeEmptyDir),
  };
}

async function clearLocks(files: AtomicFiles): Promise<void> {
  for await (const p of files.list("refs")) if (p.endsWith(".lock")) await files.remove(p);
  await files.remove("packed-refs.lock");
  await files.remove("HEAD.lock");
}

describe("crash at every file operation", () => {
  it("a multi-ref batch leaves all refs old or all new", async () => {
    const seedRepo = newRepo();
    const cs = commits(seedRepo, 6) as string[];
    const names = ["refs/heads/a", "refs/heads/b", "refs/heads/c", "refs/heads/d"];
    const outcomes = new Set<string>();
    let completed = false;
    for (let k = 1; k <= 400 && !completed; k++) {
      // a packed; b packed at cs1 and loose at cs2 (a stale packed value would be visible);
      // c absent; d loose only
      const repo = newRepo();
      const files = atomicFor(repo);
      const setup = createFilesRefBatch(files);
      await setup([
        { name: "refs/heads/a", new: cs[0] as string },
        { name: "refs/heads/b", new: cs[1] as string },
      ]);
      await setup([{ name: "refs/heads/b", old: cs[1] as string, new: cs[2] as string }]);
      await setup([{ name: "refs/heads/d", new: cs[4] as string }]);
      const before = names.map((n) => gitResolve(repo, n));
      let threw = false;
      try {
        const r = await createFilesRefBatch(dyingAt(files, k))([
          { name: "refs/heads/a", old: cs[0] as string, new: cs[3] as string },
          { name: "refs/heads/b", old: cs[2] as string, new: null },
          { name: "refs/heads/c", old: null, new: cs[5] as string },
          { name: "refs/heads/d", old: cs[4] as string, new: cs[0] as string },
        ]);
        if (r.ok) completed = true;
      } catch {
        threw = true;
      }
      await clearLocks(files);
      const after = names.map((n) => gitResolve(repo, n));
      const isOld = after.every((v, i) => v === before[i]);
      const isNew =
        after[0] === cs[3] && after[1] === undefined && after[2] === cs[5] && after[3] === cs[0];
      expect(isOld || isNew, `crash at call ${k}: ${JSON.stringify(after)}`).toBe(true);
      outcomes.add(`${threw ? "crash" : "done"}:${isNew ? "new" : "old"}`);
    }
    expect(completed).toBe(true);
    expect(outcomes.has("crash:old")).toBe(true);
  }, 180_000);

  it("a single-ref update or packed delete leaves the old or the new value", async () => {
    const seedRepo = newRepo();
    const [c0, c1] = commits(seedRepo, 2) as [string, string];
    for (const op of ["update", "delete-packed"] as const) {
      let completed = false;
      for (let k = 1; k <= 200 && !completed; k++) {
        const repo = newRepo();
        const files = atomicFor(repo);
        const setup = createFilesRefBatch(files);
        await setup([
          { name: "refs/heads/m", new: c0 },
          { name: "refs/heads/n", new: c0 },
        ]); // packed
        await setup([{ name: "refs/heads/m", old: c0, new: c1 }]); // loose over a stale packed value
        const batch = createFilesRefBatch(dyingAt(files, k));
        try {
          completed = (
            await batch([{ name: "refs/heads/m", old: c1, new: op === "update" ? c0 : null }])
          ).ok;
        } catch {
          // crashed
        }
        await clearLocks(files);
        const m = gitResolve(repo, "refs/heads/m");
        const ok = op === "update" ? m === c1 || m === c0 : m === c1 || m === undefined;
        expect(ok, `${op}, crash at call ${k}: m=${m}`).toBe(true);
      }
      expect(completed, op).toBe(true);
    }
  }, 180_000);
});
