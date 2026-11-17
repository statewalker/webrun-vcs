import { describe, expect, it } from "vitest";

import {
  isAbsoluteGitPath,
  parseCommonDir,
  parseGitfile,
  parseWorktreeGitdir,
  stripLineEnds,
} from "../../../src/workspace/git-dir/index.js";

describe("linked-worktree pointer files, as git reads them", () => {
  it("strips only trailing \\n and \\r", () => {
    expect(stripLineEnds("a\r\n\n")).toBe("a");
    expect(stripLineEnds(" a \t\n")).toBe(" a \t");
    expect(stripLineEnds("a\nb\n")).toBe("a\nb");
  });

  it("a .git file: `gitdir: ` with one space, the rest up to the line end (read_gitfile_gently)", () => {
    expect(parseGitfile("gitdir: /repo/.git/worktrees/wt\n")).toBe("/repo/.git/worktrees/wt");
    expect(parseGitfile("gitdir: ../.git/modules/m\r\n")).toBe("../.git/modules/m");
    expect(parseGitfile("gitdir:  spaced \n")).toBe(" spaced ");
    expect(parseGitfile("gitdir: \n")).toBeUndefined();
    expect(parseGitfile("gitdir:/x\n")).toBeUndefined();
    expect(parseGitfile(" gitdir: /x\n")).toBeUndefined();
    expect(parseGitfile("GITDIR: /x\n")).toBeUndefined();
  });

  it("commondir: up to the line end; empty is no commondir (get_common_dir_noenv)", () => {
    expect(parseCommonDir("../..\n")).toBe("../..");
    expect(parseCommonDir("../.. \n")).toBe("../.. ");
    expect(parseCommonDir("\n")).toBeUndefined();
  });

  it("the worktrees/NAME/gitdir back-pointer: trailing whitespace only (strbuf_rtrim)", () => {
    expect(parseWorktreeGitdir("/srv/wt/.git \t\r\n")).toBe("/srv/wt/.git");
    expect(parseWorktreeGitdir(" /srv/wt/.git\n")).toBe(" /srv/wt/.git");
  });

  it("absolute paths: `/`, or a drive letter with a slash or backslash", () => {
    expect(isAbsoluteGitPath("/repo")).toBe(true);
    expect(isAbsoluteGitPath("C:/repo/.git")).toBe(true);
    expect(isAbsoluteGitPath("c:\\repo\\.git")).toBe(true);
    expect(isAbsoluteGitPath("../..")).toBe(false);
    expect(isAbsoluteGitPath("C:repo")).toBe(false);
    expect(isAbsoluteGitPath("repo/C:/x")).toBe(false);
  });
});
