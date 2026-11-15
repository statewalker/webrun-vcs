import { describe, expect, it } from "vitest";
import {
  assertValidWorktreePath,
  isGitWorktreeFile,
  isValidWorktreePath,
} from "../../src/index.js";

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

// verify_path with the entry mode: a symbolic link named .gitmodules (CVE-2018-11235).
describe("isValidWorktreePath with a mode", () => {
  const SYMLINK = 0o120000;
  for (const path of [
    ".gitmodules",
    "sub/.gitmodules",
    ".GITMODULES",
    "gitmod~1",
    ".gitmodules. ",
  ]) {
    it(`refuses a symlink at ${JSON.stringify(path)}`, () => {
      expect(isValidWorktreePath(path, SYMLINK)).toBe(false);
      expect(isValidWorktreePath(path, 0o100644)).toBe(true);
      expect(isValidWorktreePath(path)).toBe(true);
    });
  }
  it("accepts other symlinks", () => {
    expect(isValidWorktreePath("link", SYMLINK)).toBe(true);
    expect(isValidWorktreePath(".gitignore", SYMLINK)).toBe(true);
  });
});

// CVE-2019-1354: Windows reads `\` as a separator, so `d\post-checkout` lands inside `d`
// (a directory or a link). Git refuses it only on Windows; elsewhere it is a file name.
describe("isValidWorktreePath and backslashes", () => {
  for (const path of ["a\\b.txt", "d\\post-checkout", "dir/x\\y", "\\abs"]) {
    it(`accepts ${JSON.stringify(path)} on POSIX, refuses it on Windows`, () => {
      expect(isValidWorktreePath(path)).toBe(true);
      expect(isValidWorktreePath(path, 0o100644, { windows: true })).toBe(false);
      expect(() => assertValidWorktreePath(path, undefined, { windows: true })).toThrow(
        /Invalid worktree path/,
      );
    });
  }
  it("refuses .git behind a backslash on every platform (protectNTFS)", () => {
    expect(isValidWorktreePath(".git\\hooks")).toBe(false);
    expect(isValidWorktreePath("x\\.GIT")).toBe(false);
  });
});

// git's is_valid_win32_path, applied for a worktree on Windows only.
describe("isValidWorktreePath with Windows rules", () => {
  const refused = [
    "C:x",
    "a<b",
    "a>b",
    'a"b',
    "a|b",
    "a?b",
    "a*b",
    "a:b",
    "dir./x",
    "x ",
    "x.",
    "CON",
    "nul.txt",
    "Com1",
    "lpt9.log",
    "conin$",
    "dir/aux",
    "aux .txt",
    "a\u0001b",
  ];
  for (const path of refused) {
    it(`refuses ${JSON.stringify(path)} on Windows only`, () => {
      expect(isValidWorktreePath(path, undefined, { windows: true })).toBe(false);
    });
  }
  for (const path of ["console.txt", "com10", "lpt", "a.b/c d", "nulx"]) {
    it(`accepts ${JSON.stringify(path)} on Windows`, () =>
      expect(isValidWorktreePath(path, undefined, { windows: true })).toBe(true));
  }
});

// git's is_ntfs_dot_generic: the NTFS short names of the files git reads from the worktree.
describe("isGitWorktreeFile", () => {
  const cases: [string, Parameters<typeof isGitWorktreeFile>[1], boolean][] = [
    [".gitmodules", "gitmodules", true],
    [".GITMODULES . ", "gitmodules", true],
    ["gitmod~4", "gitmodules", true],
    ["gitmod~5", "gitmodules", false],
    ["gi7eba~1", "gitmodules", true],
    ["GI7EBA~9", "gitmodules", true],
    ["gi7eba~0", "gitmodules", false],
    ["gi7eba~1x", "gitmodules", false],
    ["gi7d29~1", "gitattributes", true],
    ["gitatt~2", "gitattributes", true],
    ["gi250a~1", "gitignore", true],
    [".gitignore:stream", "gitignore", true],
    ["maba30~3", "mailmap", true],
    [".mailmap..", "mailmap", true],
    [".gitmodulesx", "gitmodules", false],
    ["gitmodules", "gitmodules", false],
  ];
  for (const [name, file, expected] of cases) {
    it(`${JSON.stringify(name)} ${expected ? "is" : "is not"} .${file}`, () =>
      expect(isGitWorktreeFile(name, file)).toBe(expected));
  }
  it("refuses a symlink at the NTFS fallback short name of .gitmodules", () => {
    expect(isValidWorktreePath("gi7eba~1", 0o120000)).toBe(false);
    expect(isValidWorktreePath("gi7eba~1", 0o100644)).toBe(true);
  });
});
