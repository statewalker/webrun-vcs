/**
 * `git check-ref-format` against native git: every name of git's t1402-check-ref-format.sh
 * with its options (`--normalize`, `--allow-onelevel`, `--refspec-pattern`), `--branch`
 * (`@{-N}`, a name starting with `-`), and the inputs of JGit's ValidRefNameTest
 * (`Repository.isValidRefName`) and RefSpecTest (each side of its refspecs, with
 * `--refspec-pattern --allow-onelevel`), native git deciding each. Run with the system git
 * (2.43) and with 2.56.1 first on `PATH`.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkRefFormat, type Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { fromBytes, git, native, type Outcome, outcomeOf } from "./plumbing-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root = "";
let repo = "";

/** `git check-ref-format <args>` through ours. */
async function ours(dir: string, args: string[]): Promise<Outcome> {
  const g: Git = await openOurs(dir);
  const cmd = g.checkRefFormat();
  if (args[0] === "--branch")
    return outcomeOf(await cmd.setBranch(fromBytes(args[1] ?? "")).call());
  for (const a of args.slice(0, -1)) {
    if (a === "--normalize" || a === "--print") cmd.setNormalize(true);
    else if (a === "--allow-onelevel") cmd.setAllowOneLevel(true);
    else if (a === "--no-allow-onelevel") cmd.setAllowOneLevel(false);
    else if (a === "--refspec-pattern") cmd.setRefspecPattern(true);
    else throw new Error(`unknown option ${a}`);
  }
  return outcomeOf(await cmd.setRefName(fromBytes(args[args.length - 1] ?? "")).call());
}

async function twin(args: string[], dir = repo): Promise<Outcome> {
  const n = native(root, dir, ["check-ref-format", ...args]);
  expect(await ours(dir, args), args.join(" ")).toEqual(n);
  return n;
}

/** t1402's `valid_ref`/`invalid_ref` lines: a name and its options. */
const T1402: Array<[string, string?]> = [
  [""],
  ["/"],
  ["/", "--allow-onelevel"],
  ["/", "--normalize"],
  ["/", "--allow-onelevel --normalize"],
  ["foo/bar/baz"],
  ["foo/bar/baz", "--normalize"],
  ["refs///heads/foo"],
  ["refs///heads/foo", "--normalize"],
  ["heads/foo/"],
  ["/heads/foo"],
  ["/heads/foo", "--normalize"],
  ["///heads/foo"],
  ["///heads/foo", "--normalize"],
  ["./foo"],
  ["./foo/bar"],
  ["foo/./bar"],
  ["foo/bar/."],
  [".refs/foo"],
  ["refs/heads/foo."],
  ...["?", "~", "^", ":", "*", "[", " ", "\\", ".."].map((c): [string] => [`heads/foo${c}bar`]),
  ["foo./bar"],
  ["heads/foo.lock"],
  ["heads///foo.lock"],
  ["foo.lock/bar"],
  ["foo.lock///bar"],
  ["heads/foo@bar"],
  ["refs/@"],
  ["@", "--allow-onelevel"],
  ["heads/v@{ation"],
  ["heads/foo\t"],
  ["heads/foo\x7f"],
  ["heads/fu\xc3\x9f"],
  ["heads/*foo/bar", "--refspec-pattern"],
  ["heads/foo*/bar", "--refspec-pattern"],
  ["heads/f*o/bar", "--refspec-pattern"],
  ["heads/f*o*/bar", "--refspec-pattern"],
  ["heads/foo*/bar*", "--refspec-pattern"],
  ...[
    "foo",
    "foo/bar",
    "foo/*",
    "*/foo",
    "foo/*/bar",
    "*",
    "foo/*/*",
    "*/foo/*",
    "*/*/foo",
    "/foo",
  ].flatMap((ref) =>
    [
      "",
      "--allow-onelevel",
      "--refspec-pattern",
      "--refspec-pattern --allow-onelevel",
      "--normalize",
      "--allow-onelevel --normalize",
      "--refspec-pattern --normalize",
      "--refspec-pattern --allow-onelevel --normalize",
    ].map((o): [string, string] => [ref, o]),
  ),
  // valid_ref_normalized / invalid_ref_normalized
  ...[
    "heads/foo",
    "refs///heads/foo",
    "/heads/foo",
    "///heads/foo",
    "foo",
    "/foo",
    "heads/foo/../bar",
    "heads/./foo",
    "heads\\foo",
    "heads/foo.lock",
    "heads///foo.lock",
    "foo.lock/bar",
    "foo.lock///bar",
  ].map((ref): [string, string] => [ref, "--normalize"]),
];

/** JGit's ValidRefNameTest (`Repository.isValidRefName`), names passable as arguments. */
const JGIT_VALID_REF_NAME = [
  "",
  "/",
  "master",
  "heads/master",
  "refs/heads/master",
  "refs/heads/pu",
  "refs/heads/z",
  "refs/heads/FoO",
  "refs/tags/v1.0",
  "refs/heads/master.lock",
  "refs/heads/master/",
  "refs/heads/i haz space",
  "refs/heads/mast\x01er",
  "refs/heads/.",
  "refs/heads/..",
  "refs/heads/./master",
  "refs/heads/../master",
  ".",
  "refs/heads/.bar",
  "refs/heads/..bar",
  "refs/heads/bar.",
  "refs/heads/m.a.s.t.e.r",
  "refs/heads/master..pu",
  ...["^", "~", ":", "?", "[", "*"].flatMap((c) => [
    `refs/heads/master${c}`,
    `refs/heads/${c}master`,
    `${c}refs/heads/master`,
  ]),
  ..."!#$%&'()+,-;=@]_`{}".split("").map((c) => `refs/heads/${c}`),
  "refs/heads/\\",
  "refs/heads/\xc3\xa5ngstr\xc3\xb6m",
  "refs/heads/master@{1}",
  "refs/heads/master@{1.hour.ago}",
  "refs/heads/conx",
  "refs/heads/xcon",
  // assertInvalidOnWindows: valid for git off Windows
  'refs/heads/"',
  "refs/heads/<",
  "refs/heads/>",
  "refs/heads/|",
  "refs/heads/con",
  "refs/con/x",
  "con/heads/x",
];

/** JGit's RefSpecTest refspecs; each side is checked as a refspec's. */
const JGIT_REFSPECS = [
  "*",
  "*/head:refs/heads/*",
  "*:*",
  "+refs/heads/*:refs/remotes/origin/*/head",
  "+refs/pull/*/head:refs/remotes/origin/pr/*",
  "/foo:/foo",
  ":refs/heads/*",
  ":refs/heads//wrong",
  "^refs/heads/*:refs/heads/*",
  "^refs/testdata/*",
  "refs/heads*/for-linus:refs/remotes/mine/*",
  "refs/heads/",
  "refs/heads/*",
  "refs/heads/*/*:refs/heads/*",
  "refs/heads/*/for-linus:refs/remotes/mine/*-blah",
  "refs/heads/*:refs/heads/*/*",
  "refs/heads/*:refs/heads/foo",
  "refs/heads//wrong",
  "refs/heads/foo:refs/heads/*",
  "refs/heads/master:refs/heads/",
  "refs/heads/master:refs/heads/*",
  "refs/heads/master:refs/remotes/origin/master",
  "refs/heads/master~1:refs/heads/x",
];

describeGit("git check-ref-format against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "check-ref-format-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(root, repo, ["init", "-q", "-b", "main"]);
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it("t1402-check-ref-format.sh: valid_ref, invalid_ref, valid_ref_normalized and invalid_ref_normalized names", async () => {
    for (const [ref, options] of T1402) {
      await twin([...(options ? options.split(" ") : []), ref]);
    }
  });

  it("JGit ValidRefNameTest: every name, plain and with --allow-onelevel", async () => {
    for (const name of JGIT_VALID_REF_NAME) {
      await twin([name]);
      await twin(["--allow-onelevel", name]);
    }
  });

  it("JGit RefSpecTest: each side of its refspecs with --refspec-pattern --allow-onelevel", async () => {
    for (const spec of JGIT_REFSPECS) {
      const body = spec.replace(/^[+^]+/, "");
      const colon = body.indexOf(":");
      const sides = colon < 0 ? [body] : [body.slice(0, colon), body.slice(colon + 1)];
      for (const side of sides) {
        if (side === "") continue;
        await twin(["--refspec-pattern", "--allow-onelevel", side]);
        await twin(["--refspec-pattern", "--allow-onelevel", "--normalize", side]);
      }
    }
  });

  it('t1402-check-ref-format.sh: "check-ref-format --branch @{-1}", "check-ref-format --branch -nain", "check-ref-format --branch from subdir"', async () => {
    const tree = git(root, repo, ["write-tree"]).trim();
    const sha1 = git(root, repo, ["commit-tree", tree], "A\n").trim();
    git(root, repo, ["update-ref", "refs/heads/main", sha1]);
    git(root, repo, ["update-ref", "refs/remotes/origin/main", sha1]);
    git(root, repo, ["checkout", "-q", "main"]);
    git(root, repo, ["checkout", "-q", "origin/main"]);
    git(root, repo, ["checkout", "-q", "main"]);
    expect((await twin(["--branch", "@{-1}"])).out).toBe(`${sha1}\n`);
    expect((await twin(["--branch", "@{-2}"])).out).toBe("main\n");
    expect((await twin(["--branch", "-nain"])).status).toBe(128);
    for (const name of ["main", "@", "HEAD", "feature/x", "a..b", "@{-9}", "@{u}", "main@{u}"]) {
      await twin(["--branch", name]);
    }
  });

  it("checkRefFormat: the rules without a repository", () => {
    expect(checkRefFormat("refs///heads/foo", { normalize: true })).toBe("refs/heads/foo");
    expect(checkRefFormat("foo")).toBeUndefined();
    expect(checkRefFormat("foo", { allowOneLevel: true })).toBe("foo");
    expect(checkRefFormat("foo/*", { refspecPattern: true })).toBe("foo/*");
  });
});
