/**
 * FileWorktree against native git: files we check out (streamed from blobs)
 * leave `git status` clean, and the ids we hash (streamed from the files) match
 * `git hash-object`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createFileWorktree, createGitFilesBackend } from "../../../src/index.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, maxBuffer: 1 << 30 })
    .toString()
    .trim();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Files of several shapes: text, CRLF text, binary, nested, empty, and multi-chunk. */
function fixture(): Record<string, Uint8Array> {
  const big = new Uint8Array(3 * 1024 * 1024 + 17);
  for (let i = 0; i < big.length; i++) big[i] = (i * 131 + 7) & 0xff;
  const enc = new TextEncoder();
  return {
    "README.md": enc.encode("# Test\n"),
    "crlf.txt": enc.encode("one\r\ntwo\r\n\r\nthree\r"),
    "empty.txt": new Uint8Array(0),
    "dir/nested/file.txt": enc.encode("nested\n"),
    "big.bin": big,
  };
}

describe("FileWorktree and native git", () => {
  it("checks a commit out so that git status is clean, and hashes as git does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worktree-checkout-"));
    dirs.push(dir);
    git(dir, ["init", "-q", "--initial-branch=main", "."]);
    const files = fixture();
    for (const [path, bytes] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), bytes);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "fixture"]);
    const treeId = git(dir, ["rev-parse", "HEAD^{tree}"]);

    // the worktree is gone; our checkout must bring it back byte for byte
    for (const path of Object.keys(files)) unlinkSync(join(dir, path));

    const fs = createNodeFilesApi({ rootDir: dir });
    const { history } = await createGitFilesBackend({ files: fs });
    const worktree = createFileWorktree({
      files: fs,
      rootPath: "",
      blobs: history.blobs,
      trees: history.trees,
      gitDir: ".git",
    });
    const result = await worktree.checkoutTree(treeId, { force: true });
    expect(result.failed).toEqual([]);
    expect(result.updated.sort()).toEqual(Object.keys(files).sort());

    expect(git(dir, ["status", "--porcelain"])).toBe("");

    for (const path of Object.keys(files)) {
      expect(await worktree.computeHash(path), path).toBe(git(dir, ["hash-object", path]));
    }
  });
});
