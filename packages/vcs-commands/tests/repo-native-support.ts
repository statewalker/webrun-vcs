/**
 * Test-only: native twins of `git repo` and `git format-rev` (git 2.52+/2.56+). Each scenario
 * runs on native git and on ours over the same repository; stdout (as latin1 bytes), stderr
 * and the exit status are compared. The native git is the one on PATH or `$GIT3`, whichever
 * a suite names; a binary without the command skips the suite.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createGitFilesBackend,
  openGitLinkedWorktrees,
  openRepositoryFromEnvironment,
} from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";

import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { Git, type PlumbingOutput } from "../src/index.js";
import { nativeGitEnv } from "./native-git-http-backend.js";
import { nativeGit3Env } from "./native-git3.js";

export interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

/** A native git binary and the environment it runs with. */
export interface NativeGit {
  label: string;
  binary: string;
  env(home: string): Record<string, string>;
}

/** The git on PATH, and `$GIT3` when set. */
export function nativeGits(): NativeGit[] {
  const gits: NativeGit[] = [{ label: "git on PATH", binary: "git", env: nativeGitEnv }];
  const git3 = process.env.GIT3;
  if (git3 && existsSync(git3)) {
    // the bare twins under a git 3.0 build (safe.bareRepository's default is `explicit`); ours
    // runs without breakingChanges, so the twins compare the output, not the refusal
    const env = (home: string) => ({
      ...nativeGit3Env(home),
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "safe.bareRepository",
      GIT_CONFIG_VALUE_2: "all",
    });
    gits.push({ label: "$GIT3", binary: git3, env });
  }
  return gits;
}

/** t/test-lib's clock: 1112911993, 60 seconds per test_tick, `-0700`. */
export class NativeShell {
  private time = 1112911993;
  readonly home: string;

  constructor(
    readonly git: NativeGit,
    home: string,
  ) {
    this.home = realpathSync(home);
  }

  tick(): void {
    this.time += 60;
  }

  /** Native git in `cwd`. */
  run(
    cwd: string,
    args: string[],
    options: { env?: Record<string, string>; input?: string | Uint8Array } = {},
  ): Outcome {
    const date = `${this.time} -0700`;
    const r = spawnSync(this.git.binary, args, {
      cwd,
      env: {
        ...this.git.env(this.home),
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
        ...options.env,
      },
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
    return {
      status: r.status ?? 1,
      stdout: (r.stdout ?? Buffer.alloc(0)).toString("latin1"),
      stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
    };
  }

  /** Native git that must succeed: its stdout. */
  ok(cwd: string, ...args: string[]): string {
    const r = this.run(cwd, args);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  }

  /** test_commit <name>: a file `<name>.t`, a commit, a lightweight tag. */
  commit(dir: string, name: string): void {
    this.tick();
    writeFileSync(join(dir, `${name}.t`), `${name}\n`);
    this.ok(dir, "add", `${name}.t`);
    this.ok(dir, "commit", "-q", "-m", name);
    this.ok(dir, "tag", name);
  }

  /** test_commit_bulk <n>: n commits of `<i>.t` files through fast-import, on HEAD's branch. */
  commitBulk(dir: string, n: number): void {
    let input = "";
    const branch = this.ok(dir, "symbolic-ref", "HEAD").trim();
    for (let i = 1; i <= n; i++) {
      this.tick();
      input += `commit ${branch}\n`;
      input += `author A U Thor <author@example.com> ${this.time} -0700\n`;
      input += `committer C O Mitter <committer@example.com> ${this.time} -0700\n`;
      const message = `commit ${i}\n`;
      input += `data ${message.length}\n${message}`;
      const content = `content ${i}\n`;
      input += `M 644 inline ${i}.t\ndata ${content.length}\n${content}\n`;
    }
    const r = this.run(dir, ["fast-import", "--quiet"], { input });
    if (r.status !== 0) throw new Error(`fast-import failed: ${r.stderr}`);
    this.ok(dir, "reset", "-q", "--hard");
  }

  /** The git version's `repo info` key table, by what `--keys` lists. */
  repoCompatibility(dir: string): "2.54" | "2.56" | "2.57" | undefined {
    const r = this.run(dir, ["repo", "info", "--keys"]);
    if (r.status !== 0) return undefined;
    if (r.stdout.includes("references.storageFormat")) return "2.57";
    if (r.stdout.includes("path.commondir.absolute")) return "2.56";
    return "2.54";
  }

  /** Whether `format-rev` exists. */
  hasFormatRev(dir: string): boolean {
    const r = this.run(dir, ["format-rev", "-h"]);
    return r.stdout.includes("git format-rev");
  }
}

/** Our Git over a repository at `dir` (a worktree or a bare repository). */
export async function openOursAt(home: string, dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const bare = !existsSync(join(dir, ".git"));
  const gitDir = bare ? "" : ".git";
  const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(home) });
  const { history } = await createGitFilesBackend({ files, gitDir, environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
  if (bare) return Git.fromWorktreeAdmin(await worktrees.openAdmin());
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/**
 * Our Git as a git command started in `cwd` with the repository variables of `env`
 * (`GIT_DIR`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`...) sees it: opened through
 * `openRepositoryFromEnvironment` over a FilesApi rooted at `/`; `prefix` is git's.
 */
export async function openOursFromEnvironment(
  home: string,
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ git: Git; prefix: string; cwd: string }> {
  const files = createNodeFilesApi({ rootDir: "/" });
  const environment = createNodeGitHostEnvironment({ env: { ...nativeGitEnv(home), ...env } });
  const { admin, setup } = await openRepositoryFromEnvironment({
    files,
    cwd: realpathSync(cwd).slice(1),
    environment,
  });
  const git =
    setup.workTree === undefined
      ? Git.fromWorktreeAdmin(admin)
      : Git.fromWorkingCopy(admin as WorkingCopy);
  // the FilesApi is rooted at `/`: its paths are host paths without the leading slash
  return { git, prefix: setup.prefix ?? "", cwd: `/${setup.cwd.replace(/^\/+/, "")}` };
}

/** A plumbing run as an outcome (stdout as latin1). */
export async function outcomeOf(run: () => Promise<PlumbingOutput>): Promise<Outcome> {
  const r = await run();
  return {
    status: r.exitCode,
    stdout: Buffer.from(r.stdout).toString("latin1"),
    stderr: r.stderr,
  };
}
