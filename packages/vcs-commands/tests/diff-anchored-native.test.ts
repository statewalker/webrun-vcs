/**
 * `--anchored=<text>` (the patience diff with anchors, xpatience.c) against native git
 * (statewalker-root#342). t4065 diffs two files with `--no-index`; ours has no `--no-index`,
 * so the same contents are a tracked file and its worktree change.
 */

import type { XdiffAlgorithm } from "@statewalker/vcs-utils";
import { afterAll, describe, expect, it } from "vitest";
import {
  differs,
  native,
  openGit,
  repo,
  Scratch,
  twinFormats,
  versionOptions,
} from "./diff-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const scratch = new Scratch("diff-anchored-");
afterAll(() => scratch.cleanup());

/** A repository whose `file` holds `pre` committed and `post` in the worktree */
const prePost = (pre: string, post: string) =>
  repo(scratch, `printf "${pre}" >file && git add file && commit -m pre && printf "${post}" >file`);

async function anchoredTwins(
  dir: string,
  cases: Array<[string[], { anchored?: string[]; algorithm?: XdiffAlgorithm }]>,
): Promise<string[]> {
  const out: string[] = [];
  for (const [flags, options] of cases) {
    await twinFormats(scratch, out, dir, ["diff", ...flags], (d) => d.setOptions(options), [
      "patch",
      "stat",
      "numstat",
    ]);
  }
  return out;
}

describeGit("diff --anchored", () => {
  it('t4065-diff-anchored.sh: "--anchored"', async () => {
    const dir = prePost("a\\nb\\nc\\n", "c\\na\\nb\\n");
    expect(
      await anchoredTwins(dir, [
        [[], {}],
        [["--anchored=c"], { anchored: ["c"] }],
      ]),
    ).toEqual([]);
  });

  it('t4065-diff-anchored.sh: "--anchored multiple"', async () => {
    const dir = prePost("a\\nb\\nc\\nd\\ne\\nf\\n", "c\\na\\nb\\nf\\nd\\ne\\n");
    expect(
      await anchoredTwins(dir, [
        [["--anchored=c"], { anchored: ["c"] }],
        [["--anchored=c", "--anchored=f"], { anchored: ["c", "f"] }],
      ]),
    ).toEqual([]);
  });

  it('t4065-diff-anchored.sh: "--anchored with nonexistent line has no effect"', async () => {
    const dir = prePost("a\\nb\\nc\\n", "c\\na\\nb\\n");
    expect(await anchoredTwins(dir, [[["--anchored=x"], { anchored: ["x"] }]])).toEqual([]);
  });

  it('t4065-diff-anchored.sh: "--anchored with non-unique line has no effect"', async () => {
    const dir = prePost("a\\nb\\nc\\nd\\ne\\nc\\n", "c\\na\\nb\\nc\\nd\\ne\\n");
    expect(await anchoredTwins(dir, [[["--anchored=c"], { anchored: ["c"] }]])).toEqual([]);
  });

  it('t4065-diff-anchored.sh: "diff still produced with impossible multiple --anchored"', async () => {
    const dir = prePost("a\\nb\\nc\\n", "c\\na\\nb\\n");
    expect(
      await anchoredTwins(dir, [[["--anchored=a", "--anchored=c"], { anchored: ["a", "c"] }]]),
    ).toEqual([]);
  });

  it('t4065-diff-anchored.sh: "later algorithm arguments override earlier ones"', async () => {
    const dir = prePost("a\\nb\\nc\\n", "c\\na\\nb\\n");
    expect(
      await anchoredTwins(dir, [
        [["--patience", "--anchored=c"], { anchored: ["c"] }],
        [["--anchored=c", "--patience"], { algorithm: "patience" }],
        [["--histogram", "--anchored=c"], { anchored: ["c"] }],
        [["--anchored=c", "--histogram"], { algorithm: "histogram" }],
      ]),
    ).toEqual([]);
  });

  it("t4065-diff-anchored.sh: anchors as prefixes, in a longer file with several hunks", async () => {
    const dir = prePost(
      "x1\\nfoo bar\\nx2\\nx3\\nbaz\\nx4\\nx5\\nx6\\nx7\\nx8\\nfoo end\\nx9\\n",
      "foo bar\\nx1\\nx2\\nbaz\\nx3\\nx4\\nx5\\nfoo end\\nx6\\nx7\\nx8\\nx9\\n",
    );
    expect(
      await anchoredTwins(dir, [
        [["--anchored=foo"], { anchored: ["foo"] }],
        [["--anchored=foo ", "--anchored=baz"], { anchored: ["foo ", "baz"] }],
        [["--anchored=x"], { anchored: ["x"] }],
      ]),
    ).toEqual([]);
  });

  it('t4065-diff-anchored.sh: "--anchored works with other commands like \\"git show\\""', async () => {
    const dir = repo(
      scratch,
      `printf "a\\nb\\nc\\n" >file && git add file && commit -m foo
       printf "c\\na\\nb\\n" >file && git add file && commit -m foo`,
    );
    const theirs = native(scratch, dir, ["show", "--patience", "--anchored=c"]);
    const git = await openGit(scratch, dir);
    const r = await git
      .show()
      .setOptions({ diff: { ...versionOptions, anchored: ["c"] } })
      .call();
    const m = differs("git show --anchored=c", theirs, {
      status: r.exitCode,
      stdout: Buffer.from(r.stdout),
      messages: [],
    });
    expect(m).toBeUndefined();
  });
});
