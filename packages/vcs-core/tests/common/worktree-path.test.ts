import { describe, expect, it } from "vitest";
import { assertValidWorktreePath, isValidWorktreePath } from "../../src/index.js";

// git's verify_path with core.protectHFS and core.protectNTFS on (CVE-2014-9390): a tree path
// must never name the repository's own `.git`, under any spelling a filesystem folds to it.
describe("isValidWorktreePath", () => {
  const valid = [
    "a.txt",
    "dir/nested/file.txt",
    ".gitignore",
    ".gitattributes",
    ".github/workflows/ci.yml",
    "sub/.gitmodules",
    "git",
    "x.git",
    ".git-foo",
    "..hidden",
    "git~2",
    "a\\b.txt",
  ];
  for (const path of valid) {
    it(`accepts ${JSON.stringify(path)}`, () => expect(isValidWorktreePath(path)).toBe(true));
  }

  const invalid = [
    "",
    "/abs",
    "trailing/",
    "a//b",
    ".",
    "..",
    "a/../b",
    "./a",
    "a/./b",
    "a\0b",
    ".git",
    ".git/config",
    "sub/.git/config",
    ".GIT/config",
    ".Git/hooks/post-checkout",
    // NTFS: trailing dots and spaces are dropped, `git~1` is the 8.3 short name, `:` opens a stream.
    ".git./config",
    ".git . ./config",
    "git~1/config",
    "GIT~1/config",
    ".git::$INDEX_ALLOCATION/config",
    "a\\.git\\config",
    // HFS+: these code points are ignored when comparing names.
    "‌.git/config",
    ".g‍it/config",
    ".gi﻿t/config",
    ".git⁪/config",
  ];
  for (const path of invalid) {
    it(`refuses ${JSON.stringify(path)}`, () => {
      expect(isValidWorktreePath(path)).toBe(false);
      expect(() => assertValidWorktreePath(path)).toThrow(/Invalid worktree path/);
    });
  }
});
