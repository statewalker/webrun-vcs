/**
 * A submodule (or nested repository) whose refs live in a reftable (statewalker/webrun-vcs#459):
 * its `.git/HEAD` is the stub `ref: refs/heads/.invalid` and its real HEAD is in
 * `.git/reftable`, so every read of a gitlink's HEAD must go through its ref storage, as
 * git's `resolve_gitlink_ref` opens the submodule's ref store. Each twin is a files
 * superproject holding a reftable repository at `sub`, built by native git; `add`, `status`,
 * `diff` and `submodule status` run in both and are compared.
 *
 * Needs a git that creates reftable repositories (`init --ref-format=reftable`, 2.45+): the
 * git on PATH when recent enough, else `$GIT3`; skipped otherwise.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";
import { nativeGit3Env } from "./native-git3.js";

/** A native git that makes reftable repositories, and its environment. */
function reftableGit(): { bin: string; env: (home: string) => Record<string, string> } | undefined {
  if (nativeGitAvailable()) {
    const line = execFileSync("git", ["--version"]).toString();
    if (gitAtLeast(line, 2, 45)) return { bin: "git", env: nativeGitEnv };
  }
  const git3 = process.env.GIT3;
  if (git3) return { bin: git3, env: nativeGit3Env };
  return undefined;
}

const native = reftableGit();
const describeReftable = native && process.platform === "linux" ? describe : describe.skip;

let root: string;
let caseNo = 0;

function run(cwd: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(native?.bin ?? "git", args, {
    cwd,
    env: { ...native?.env(root), GIT_CONFIG_PARAMETERS: "'protocol.file.allow'='always'" },
  });
  return {
    stdout: r.stdout.toString("latin1"),
    stderr: r.stderr.toString("latin1"),
    status: r.status ?? -1,
  };
}

function ok(cwd: string, ...args: string[]): string {
  const r = run(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stdout;
}

/**
 * A files superproject with one commit (`f`) and, at `sub`, a reftable repository with one
 * commit; `build` goes on from there. Copied into twins.
 */
function twins(build: (dir: string) => void = () => {}): { native: string; ours: string } {
  const base = join(root, `case-${++caseNo}`);
  const dir = join(base, "fixture");
  ok(root, "init", "-q", "--ref-format=files", "-b", "main", dir);
  writeFileSync(join(dir, "f"), "f\n");
  ok(dir, "add", "f");
  ok(dir, "commit", "-q", "-m", "c1");
  ok(dir, "init", "-q", "--ref-format=reftable", "-b", "main", "sub");
  writeFileSync(join(dir, "sub", "s"), "s\n");
  ok(join(dir, "sub"), "add", "s");
  ok(join(dir, "sub"), "commit", "-q", "-m", "s1");
  build(dir);
  const t = { native: join(base, "native"), ours: join(base, "ours") };
  cpSync(dir, t.native, { recursive: true });
  cpSync(dir, t.ours, { recursive: true });
  return t;
}

/** Commits a new file in the reftable repository at `sub`, moving its HEAD. */
function advanceSub(dir: string): void {
  writeFileSync(join(dir, "sub", "s2"), "s2\n");
  ok(join(dir, "sub"), "add", "s2");
  ok(join(dir, "sub"), "commit", "-q", "-m", "s2");
}

/** The superproject staged and committed with its reftable submodule registered. */
function withSubmodule(dir: string): void {
  ok(dir, "add", "sub");
  writeFileSync(join(dir, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n');
  ok(dir, "add", ".gitmodules");
  ok(dir, "commit", "-q", "-m", "with sub");
}

describeReftable("reftable submodules (#459)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "reftable-submodule-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("the nested repository's HEAD file is reftable's stub", () => {
    const t = twins();
    expect(ok(join(t.native, "sub"), "rev-parse", "--show-ref-format").trim()).toBe("reftable");
  });

  it("add stages a reftable repository as a gitlink to its HEAD", async () => {
    const t = twins();
    const r = run(t.native, ["add", "sub"]);
    expect(r.status).toBe(0);
    const result = await (await openOurs(t.ours)).add().addFilepattern("sub").call();
    expect(result.warnings.join("\n")).toContain("adding embedded git repository: sub");
    expect(ok(t.ours, "ls-files", "-s", "sub")).toBe(ok(t.native, "ls-files", "-s", "sub"));
    expect(ok(t.ours, "ls-files", "-s", "sub")).toMatch(/^160000 /);
  });

  it("add -u follows the commit checked out in a reftable submodule", async () => {
    const t = twins((dir) => {
      withSubmodule(dir);
      advanceSub(dir);
    });
    ok(t.native, "add", "-u");
    await (await openOurs(t.ours)).add().setUpdate(true).call();
    expect(ok(t.ours, "ls-files", "-s")).toBe(ok(t.native, "ls-files", "-s"));
  });

  it("status sees a reftable submodule's new commit", async () => {
    const t = twins((dir) => {
      withSubmodule(dir);
      advanceSub(dir);
    });
    for (const format of ["short", "porcelain-v2", "long"] as const) {
      const args =
        format === "short"
          ? ["status", "--short"]
          : format === "porcelain-v2"
            ? ["status", "--porcelain=v2"]
            : ["status"];
      const { text } = await (await openOurs(t.ours)).status().callText({ format });
      expect(text, format).toBe(ok(t.native, ...args));
    }
  });

  it("a clean reftable submodule shows no change", async () => {
    const t = twins(withSubmodule);
    const { text } = await (await openOurs(t.ours)).status().callText({ format: "porcelain-v2" });
    expect(text).toBe(ok(t.native, "status", "--porcelain=v2"));
    expect(text).toBe("");
  });

  it("diff shows a reftable submodule's new commit", async () => {
    const t = twins((dir) => {
      withSubmodule(dir);
      advanceSub(dir);
    });
    expect(await (await openOurs(t.ours)).diff().callText()).toBe(ok(t.native, "diff"));
  });

  it("submodule status names a reftable submodule's commit", async () => {
    const t = twins((dir) => {
      withSubmodule(dir);
      ok(dir, "submodule", "init", "-q");
      advanceSub(dir);
    });
    const r = run(t.native, ["submodule", "status"]);
    const ours = await (await openOurs(t.ours)).submoduleStatus().call();
    expect({ stdout: ours.stdout, stderr: ours.stderr, exitCode: ours.exitCode }).toEqual({
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.status,
    });
  });
  it("submodule add takes an existing reftable repository in place", async () => {
    const t = twins();
    const r = run(t.native, ["submodule", "add", "./sub", "sub"]);
    expect(r.status).toBe(0);
    const ours = await (await openOurs(t.ours))
      .submoduleAdd()
      .setURI("./sub")
      .setPath("sub")
      .call();
    expect(ours.stderr).toBe(r.stderr);
    expect(ok(t.ours, "ls-files", "-s")).toBe(ok(t.native, "ls-files", "-s"));
    expect(ok(t.ours, "config", "-f", ".gitmodules", "--list")).toBe(
      ok(t.native, "config", "-f", ".gitmodules", "--list"),
    );
  });
  // `worktree add --relative-paths` is 2.48+: the twins are copies, so absolute gitdir
  // paths would point the copies back at the fixture
  const relativeWorktrees = gitAtLeast(
    native ? execFileSync(native.bin, ["--version"]).toString() : "",
    2,
    48,
  );
  it.skipIf(!relativeWorktrees)(
    "a linked worktree of a reftable repository reads HEAD from its own stack",
    async () => {
      const t = twins((dir) => {
        // `sub` is replaced by a linked worktree of `main-repo` (reftable), on a branch one
        // commit ahead of the main worktree's HEAD
        ok(dir, "init", "-q", "--ref-format=reftable", "-b", "main", "main-repo");
        writeFileSync(join(dir, "main-repo", "m"), "m\n");
        ok(join(dir, "main-repo"), "add", "m");
        ok(join(dir, "main-repo"), "commit", "-q", "-m", "m1");
        rmSync(join(dir, "sub"), { recursive: true, force: true });
        ok(
          join(dir, "main-repo"),
          "worktree",
          "add",
          "-q",
          "--relative-paths",
          "-b",
          "wt",
          "../sub",
        );
        writeFileSync(join(dir, "sub", "w"), "w\n");
        ok(join(dir, "sub"), "add", "w");
        ok(join(dir, "sub"), "commit", "-q", "-m", "w1");
      });
      const wtHead = ok(join(t.native, "sub"), "rev-parse", "HEAD");
      expect(wtHead).not.toBe(ok(join(t.native, "main-repo"), "rev-parse", "HEAD"));
      ok(t.native, "add", "sub");
      await (await openOurs(t.ours)).add().addFilepattern("sub").call();
      expect(ok(t.ours, "ls-files", "-s", "sub")).toBe(ok(t.native, "ls-files", "-s", "sub"));
      expect(ok(t.ours, "ls-files", "-s", "sub")).toContain(wtHead.trim());
      const { text } = await (await openOurs(t.ours)).status().callText({ format: "short" });
      expect(text).toBe(ok(t.native, "status", "--short"));
    },
  );
});
