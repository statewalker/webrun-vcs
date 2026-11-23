/**
 * gc killed at any step leaves a repository native git accepts (statewalker-root#286), after
 * git's t6500-gc.sh and t7700-repack.sh, whose repacks write the new pack before removing old
 * ones and clear a multi-pack-index before its packs go. A native repository (packs, loose
 * objects, unreachable objects young and old, a pack of only unreachable objects, a midx) is
 * copied once per mutating FilesApi call our gc makes; in copy `k` the `k`-th call and every
 * later one throw, as if the process died there (its `finally` blocks cannot clean up either).
 * Native `git fsck --strict` then accepts the copy, every ref still resolves to what it named,
 * and, once the leftover lock files are removed as a user would, our gc and native gc run
 * through, fsck still clean.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FilesApi } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend, gc } from "../src/index.js";

const DAY = 24 * 3600;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, input }).toString().trim();
const gitAvailable = spawnSync("git", ["--version"]).status === 0;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Every file under `dir`, its mtime set `days` ago. */
function ageTree(dir: string, days: number) {
  const t = new Date(Date.now() - days * DAY * 1000);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) ageTree(p, days);
    else utimesSync(p, t, t);
  }
}

/** The fixture: what gc packs, prunes, cruft-packs and keeps, with a midx over two packs. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "gc-crash-"));
  dirs.push(root);
  const dir = join(root, "repo");
  git(root, ["init", "-q", "--initial-branch=main", "repo"]);
  const commit = (name: string, content: string) => {
    writeFileSync(join(dir, name), content);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", name]);
  };
  commit("a.txt", "a\n".repeat(40));
  commit("b.txt", "b\n".repeat(40));
  git(dir, ["tag", "-a", "-m", "v1", "v1"]);
  git(dir, ["checkout", "-q", "-b", "topic"]);
  commit("t.txt", "topic\n");
  git(dir, ["checkout", "-q", "main"]);
  git(dir, ["repack", "-dq"]);
  commit("c.txt", "c\n");
  git(dir, ["repack", "-dq"]);
  git(dir, ["multi-pack-index", "write"]);
  // the topic branch goes: its commit is packed and unreachable
  git(dir, ["branch", "-D", "-q", "topic"]);
  git(dir, ["reflog", "expire", "--expire=now", "--all"]);
  commit("d.txt", "d\n"); // loose and reachable
  // unreachable loose objects: an old one, a young one
  const old = git(dir, ["hash-object", "-w", "--stdin"], "old and unreachable\n");
  git(dir, ["hash-object", "-w", "--stdin"], "young and unreachable\n");
  const loose = join(dir, ".git/objects", old.slice(0, 2), old.slice(2));
  const t = new Date(Date.now() - 30 * DAY * 1000);
  utimesSync(loose, t, t);
  // an old pack of only unreachable objects
  const gone = git(dir, ["hash-object", "-w", "--stdin"], "in an old pack\n");
  const name = git(dir, ["pack-objects", "-q", ".git/objects/pack/pack"], `${gone}\n`);
  rmSync(join(dir, ".git/objects", gone.slice(0, 2), gone.slice(2)));
  for (const ext of ["pack", "idx", "rev"]) {
    const p = join(dir, ".git/objects/pack", `pack-${name}.${ext}`);
    try {
      statSync(p);
      utimesSync(p, t, t);
    } catch {
      // no .rev from an older git
    }
  }
  ageTree(join(dir, ".git/logs"), 0);
  return root;
}

const MUTATING = new Set([
  "write",
  "mkdir",
  "remove",
  "move",
  "copy",
  "createExclusive",
  "append",
  "touch",
  "symlink",
  "chmod",
]);

/** A FilesApi whose `crashAt`-th mutating call and every later one throw; counts them. */
function crashing(base: FilesApi, crashAt: number) {
  const state = { calls: 0, crashed: false };
  const files = new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && MUTATING.has(prop))
        return (...args: unknown[]) => {
          state.calls++;
          if (state.calls >= crashAt) {
            state.crashed = true;
            throw new Error(`killed at mutating call ${state.calls} (${prop} ${String(args[0])})`);
          }
          return value.apply(target, args);
        };
      return value.bind(target);
    },
  });
  return { files, state };
}

function fsck(dir: string) {
  const r = spawnSync("git", ["fsck", "--strict", "--no-progress", "--no-dangling"], {
    cwd: dir,
    env: GIT_ENV,
  });
  return { status: r.status, out: r.stdout.toString() + r.stderr.toString() };
}
const refs = (dir: string) => git(dir, ["for-each-ref", "--format=%(objectname) %(refname)"]);

/** Removes the lock files a killed process leaves (`*.lock`, gc.pid), as a user would. */
function removeLeftLocks(gitDir: string) {
  for (const e of readdirSync(gitDir, { withFileTypes: true, recursive: true })) {
    const p = join(e.parentPath, e.name);
    if (e.isFile() && (e.name.endsWith(".lock") || p === join(gitDir, "gc.pid"))) rmSync(p);
  }
}

describe.skipIf(!gitAvailable || process.platform !== "linux")(
  "t6500-gc / t7700-repack: gc killed at any step",
  () => {
    it("leaves a repository native fsck --strict accepts, whatever step it dies at", async () => {
      const src = fixture();
      const before = refs(join(src, "repo"));
      expect(fsck(join(src, "repo")).status).toBe(0);

      // a full run counts the mutating calls
      const count = async (root: string) => {
        const probe = crashing(createNodeFilesApi({ rootDir: join(root, "repo") }), Infinity);
        const b = await createGitFilesBackend({ files: probe.files });
        await gc({ history: b.history, files: probe.files });
        return probe.state.calls;
      };
      const whole = join(mkdtempSync(join(tmpdir(), "gc-crash-count-")), "c");
      dirs.push(join(whole, ".."));
      execFileSync("cp", ["-a", src, whole]);
      const total = await count(whole);
      expect(total).toBeGreaterThan(10);
      expect(fsck(join(whole, "repo")).status).toBe(0);

      const failures: string[] = [];
      for (let k = 1; k <= total; k++) {
        const copy = join(mkdtempSync(join(tmpdir(), "gc-crash-k-")), "c");
        execFileSync("cp", ["-a", src, copy]);
        const repo = join(copy, "repo");
        const { files, state } = crashing(createNodeFilesApi({ rootDir: repo }), k);
        let died: unknown;
        try {
          const b = await createGitFilesBackend({ files });
          await gc({ history: b.history, files });
        } catch (e) {
          died = e;
        }
        if (!state.crashed || !died) failures.push(`step ${k}: gc did not die`);
        const after = fsck(repo);
        if (after.status !== 0) failures.push(`step ${k} (${String(died)}): fsck ${after.out}`);
        if (refs(repo) !== before) failures.push(`step ${k}: refs changed\n${refs(repo)}`);
        // the user removes the locks the dead gc left; then gcs run through
        removeLeftLocks(join(repo, ".git"));
        const files2 = createNodeFilesApi({ rootDir: repo });
        const b2 = await createGitFilesBackend({ files: files2 });
        const again = await gc({ history: b2.history, files: files2 });
        if (again.skipped) failures.push(`step ${k}: second gc skipped`);
        const native = spawnSync("git", ["gc", "-q"], { cwd: repo, env: GIT_ENV });
        if (native.status !== 0) failures.push(`step ${k}: native gc ${native.stderr}`);
        const last = fsck(repo);
        if (last.status !== 0) failures.push(`step ${k}: fsck after gcs ${last.out}`);
        if (refs(repo) !== before) failures.push(`step ${k}: refs changed after gcs`);
        rmSync(join(copy, ".."), { recursive: true, force: true });
      }
      expect(failures).toEqual([]);
    }, 600_000);
  },
);
