/**
 * `git log -p` stays proportional to the history it prints: the diff it runs for each commit
 * looks for `.gitmodules` only when a submodule changed (git reads the submodule settings
 * then), not once per commit, and its output is native git's, byte for byte. The bounds
 * count file operations, which are deterministic.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const COMMITS = 40;

/** A FilesApi counting the calls of any of its methods on a path ending in `suffix`. */
function counted(files: FilesApi, suffix: string, calls: { n: number }): FilesApi {
  return new Proxy(files, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (key === "withLstatCache") {
        return () => counted((value as () => FilesApi).call(target), suffix, calls);
      }
      return (...args: unknown[]) => {
        const first = args[0];
        if (typeof first === "string" && first.endsWith(suffix)) calls.n++;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

describeGit("log -p stays proportional to the history", () => {
  let root: string;
  let repo: string;
  const NOW = 1700000000;
  let clock = NOW - COMMITS * 3600;
  const env = () => ({
    ...nativeGitEnv(root),
    TZ: "UTC",
    GIT_AUTHOR_DATE: `${clock} +0000`,
    GIT_COMMITTER_DATE: `${clock} +0000`,
  });
  const git = (dir: string, ...args: string[]): Buffer => {
    const r = spawnSync("git", args, { cwd: dir, env: env() });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-perf-"));
    repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    for (let c = 0; c < COMMITS; c++) {
      clock += 3600;
      const lines = Array.from(
        { length: 30 },
        (_, l) => `line ${l}${l === c % 30 ? ` (${c})` : ""}`,
      );
      writeFileSync(join(repo, "src", `f${c % 3}.txt`), `${lines.join("\n")}\n`);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", `commit ${c}`);
    }
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("looks for .gitmodules only where a submodule changed, printing what git prints", async () => {
    const calls = { n: 0 };
    const files = counted(createNodeFilesApi({ rootDir: repo }), ".gitmodules", calls);
    const environment = createNodeGitHostEnvironment({ env: env() });
    const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
    const ours = Git.fromWorkingCopy(await worktrees.openCurrent());
    const out = Buffer.from(await ours.log().callBytes({ patch: true, now: NOW }));
    expect(out.equals(git(repo, "log", "-p"))).toBe(true);
    // no commit changed a submodule: the settings are never looked up
    expect(calls.n).toBe(0);
  });
});
