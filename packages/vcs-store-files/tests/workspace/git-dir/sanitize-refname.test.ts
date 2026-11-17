import { describe, expect, it } from "vitest";

import { HostPaths, sanitizeRefnameComponent } from "../../../src/workspace/git-dir/index.js";

describe("sanitizeRefnameComponent, as git names a worktree's admin directory", () => {
  // what git 2.43 and 2.56 make of these (`git worktree add --detach ../<name>`)
  const cases: Array<[string, string]> = [
    ["plain", "plain"],
    ["a.", "a."],
    [".x", "-x"],
    ["x.lock", "x"],
    ["x.lock.lock", "x"],
    ["a..b", "a.b"],
    ["x..", "x."],
    ["a@{b", "a@-b"],
    ["@{", "@-"],
    ["a b", "a-b"],
    ["x*y", "x-y"],
    ["q?", "q-"],
    ["a:b", "a-b"],
    ["a~^[\\", "a----"],
    ["tab\tx", "tab-x"],
    ["...lock", "-lock"],
    [".lock", "-lock"],
    ["a.lock.", "a.lock."],
    ["é", "é"],
  ];
  for (const [name, expected] of cases) {
    it(`${JSON.stringify(name)} -> ${JSON.stringify(expected)}`, () => {
      expect(sanitizeRefnameComponent(name)).toBe(expected);
    });
  }

  it("a lone @ gives a second component, which git cannot use either", () => {
    expect(sanitizeRefnameComponent("@")).toBe("-/@");
  });
});

describe("HostPaths", () => {
  it("maps FilesApi paths to host paths and back", () => {
    const paths = new HostPaths("/home/me/src/");
    expect(paths.hostPath("repo/.git/worktrees/wt")).toBe("/home/me/src/repo/.git/worktrees/wt");
    expect(paths.hostPath("/")).toBe("/home/me/src");
    expect(paths.filesPath("/home/me/src/wt/.git")).toBe("/wt/.git");
    expect(paths.filesPath("/elsewhere/wt")).toBe("/elsewhere/wt");
    expect(paths.inside("/home/me/src/wt")).toBe(true);
    expect(paths.inside("/home/me/other")).toBe(false);
  });

  it("writes a Windows root with forward slashes and compares without case", () => {
    const paths = new HostPaths("C:\\Users\\Me");
    expect(paths.hostPath("wt")).toBe("C:/Users/Me/wt");
    expect(paths.filesPath("c:/users/me/wt")).toBe("/wt");
    expect(paths.same("C:/Users/Me/WT", "c:\\users\\me\\wt")).toBe(true);
  });

  it("without a root, paths stay as they are", () => {
    const paths = new HostPaths();
    expect(paths.known).toBe(false);
    expect(paths.hostPath("repo/.git")).toBe("repo/.git");
    expect(paths.filesPath("/x")).toBe("/x");
  });
});

describe("HostPaths with the root /", () => {
  it("holds every absolute path, so linked worktrees map", () => {
    const paths = new HostPaths("/");
    expect(paths.known).toBe(true);
    expect(paths.hostPath("tmp/repo/.git/worktrees/wt")).toBe("/tmp/repo/.git/worktrees/wt");
    expect(paths.filesPath("/tmp/wt/.git")).toBe("/tmp/wt/.git");
    expect(paths.inside("/tmp/wt/.git")).toBe(true);
    expect(paths.inside("/")).toBe(true);
    expect(paths.inside("relative/wt")).toBe(false);
    expect(new HostPaths("C:\\").inside("c:/Users/x")).toBe(true);
    expect(new HostPaths("/home/me").inside("/home/meet/x")).toBe(false);
  });
});
