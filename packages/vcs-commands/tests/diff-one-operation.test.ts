/**
 * `git diff` prints every file of a comparison in one worktree operation (`Worktree.batch`):
 * the attributes files and the configuration are read once for the whole output, not once per
 * file printed (each attributes lookup outside an operation opens one of its own).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describeGit("DiffCommand output in one worktree operation", () => {
  it("reads the attributes files once for all the files it prints", async () => {
    root = mkdtempSync(join(tmpdir(), "diff-one-op-"));
    const dir = join(root, "repo");
    mkdirSync(dir);
    const env = nativeGitEnv(root);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, env, encoding: "latin1", stdio: "pipe" });
    git("init", "-q", "-b", "main");
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    writeFileSync(join(dir, ".git", "info", "attributes"), "*.bin binary\n");
    writeFileSync(join(dir, ".gitattributes"), "*.txt text\n");
    const write = (round: number) => {
      for (let i = 0; i < 12; i++) {
        mkdirSync(join(dir, `d${i % 3}`), { recursive: true });
        writeFileSync(join(dir, `d${i % 3}`, `f${i}.txt`), `file ${i}\nround ${round}\n`);
      }
    };
    write(1);
    git("add", "-A");
    git("commit", "-qm", "one");
    write(2);
    git("commit", "-qam", "two");
    const expected = git("diff", "main~1", "main");

    const raw = createNodeFilesApi({ rootDir: dir });
    const reads: string[] = [];
    const files = new Proxy(raw, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== "read" || typeof value !== "function") return value;
        return (path: string, ...rest: unknown[]) => {
          if (/attributes$/.test(path)) reads.push(path);
          return value.call(target, path, ...rest);
        };
      },
    }) as FilesApi;
    const environment = createNodeGitHostEnvironment({ env });
    const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
    const ours = Git.fromWorkingCopy(await worktrees.openCurrent());
    reads.length = 0;
    const text = await ours.diff().setOldTree("main~1").setNewTree("main").callText("patch");
    expect(text).toBe(expected);
    // once each (the in-tree file and info/attributes), whatever the number of files
    expect(reads.filter((p) => p.endsWith("info/attributes")).length).toBeLessThanOrEqual(1);
    expect(reads.filter((p) => p.endsWith(".gitattributes")).length).toBeLessThanOrEqual(1);
  });
});
