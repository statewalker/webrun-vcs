/**
 * Test-only: twins for `git pull` against native git over local remotes (a path or `.`).
 * Each pair (`n<k>`, `o<k>`) is built by the same native commands; native git pulls in one,
 * ours in the other (its FilesApi rooted at the shared root, so `../src` reaches a source
 * beside the twins), then the outcome and the repositories are compared.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { expect } from "vitest";

import type { Git, PullResult } from "../src/index.js";
import { normalizeState, openOurs, snapshot } from "./merge-native-helpers.js";
import { gitAtLeast } from "./native-git-working-copy.js";
import { gitOut, gitRun, testEnv } from "./status-native-support.js";

/** Whether the native git on PATH is at least `major.minor`. */
export function nativeAtLeast(major: number, minor: number): boolean {
  try {
    return gitAtLeast(execFileSync("git", ["--version"]).toString(), major, minor);
  } catch {
    return false;
  }
}

/** Native git is 2.5x (else 2.43): its advice text, its hooks' compatibility. */
export const NATIVE_25X = nativeAtLeast(2, 50);
/** git 2.48+ writes `refs/remotes/<name>/HEAD` on a fetch (followRemoteHEAD); ours does too */
const FOLLOWS_REMOTE_HEAD = nativeAtLeast(2, 48);

/** git's outcome of a pull: its exit status and stderr. */
export interface Outcome {
  status: number;
  stderr: string;
}

export class PullTwins {
  private counter = 0;
  constructor(readonly root: string) {}

  /** Native git in `cwd` (must succeed); stdout. */
  git(cwd: string, ...args: string[]): string {
    return gitOut(this.root, cwd, args);
  }

  /** Native git in `cwd`, whatever its status. */
  run(cwd: string, args: string[], extra?: Record<string, string>): Outcome {
    const r = gitRun(this.root, cwd, args, extra);
    return { status: r.status ?? 1, stderr: r.stderr };
  }

  /** Two empty directories `n<k>` and `o<k>`, each built by `build`. */
  pair(build: (dir: string) => void): { n: string; o: string } {
    const k = this.counter++;
    const dirs = { n: join(this.root, `n${k}`), o: join(this.root, `o${k}`) };
    for (const dir of [dirs.n, dirs.o]) {
      mkdirSync(dir);
      build(dir);
    }
    return dirs;
  }

  /** Our working copy over the twin `dir` (git's identities, hooks run as native git's). */
  async ours(dir: string, extra: Record<string, string> = {}): Promise<Git> {
    const env = testEnv(this.root, extra);
    const environment = createNodeGitHostEnvironment({
      env,
      hookRunner: createNodeHookRunner({ env, compatibility: NATIVE_25X ? "2.56" : "2.43" }),
    });
    return openOurs(this.root, environment, undefined, dir.slice(this.root.length + 1));
  }

  /** Our pull's outcome as git's: 0, 1 for a merge or rebase that failed, else the error's. */
  async outcome(call: () => Promise<PullResult>): Promise<Outcome & { result?: PullResult }> {
    try {
      const result = await call();
      const message = result.rebaseResult?.message ?? result.mergeResult?.message ?? "";
      return { status: result.successful ? 0 : 1, stderr: message, result };
    } catch (error) {
      const e = error as { exitCode?: number; message: string };
      if (e.exitCode === undefined) throw error;
      return { status: e.exitCode, stderr: e.message };
    }
  }

  /** The refs, FETCH_HEAD and the snapshot (status, index, files, state) of a twin. */
  state(dir: string): unknown {
    let fetchHead: string | undefined;
    try {
      fetchHead = readFileSync(join(dir, ".git/FETCH_HEAD"), "utf8");
    } catch {
      fetchHead = undefined;
    }
    const refs = this.git(dir, "for-each-ref", "--format=%(refname) %(objectname)")
      .split("\n")
      .filter((l) => FOLLOWS_REMOTE_HEAD || !/^refs\/remotes\/[^/]+\/HEAD /.test(l))
      .join("\n");
    // merge-file's temporary names in conflict markers (`-s resolve`) are random
    return JSON.parse(
      JSON.stringify({
        refs,
        fetchHead,
        snapshot: snapshot(this.root, dir, normalizeState),
      }).replace(/\.merge_file_[A-Za-z0-9]{6}/g, ".merge_file_X"),
    );
  }

  /**
   * Compares a native pull's outcome with ours: both succeed, or both fail (ours' message
   * ending native's stderr when ours died), then the twins' states.
   */
  expectSame(
    label: string,
    dirs: { n: string; o: string },
    native: Outcome,
    ours: Outcome,
    options: { exact?: boolean } = {},
  ): void {
    expect(ours.status === 0, `${label}: ours ${ours.stderr} / native ${native.stderr}`).toBe(
      native.status === 0,
    );
    if (native.status !== 0 && (options.exact ?? true) && ours.stderr) {
      expect(
        native.stderr.trimEnd().endsWith(ours.stderr.trimEnd()),
        `${label}\n--- native\n${native.stderr}\n--- ours\n${ours.stderr}`,
      ).toBe(true);
    }
    expect(this.state(dirs.o), label).toEqual(this.state(dirs.n));
  }
}
