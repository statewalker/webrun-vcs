/**
 * `git am -i` against native git (builtin/am.c's `do_interactive`): a series made by native
 * format-patch is applied to twins, native git reading its answers from stdin and running a
 * scripted editor for `e`, ours given the same answers and editor; stdout, stderr, the exit
 * status, HEAD's history, the index, the worktree and `rebase-apply/` are compared, through
 * `--resolved`. Inputs from git's t/t4257-am-interactive.sh.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AmCommand } from "../src/index.js";
import {
  type Editor,
  editorOf,
  FAIL,
  gitOk,
  lineReader,
  native,
  openOurs,
  put,
  sed,
  view,
} from "./interactive-extras-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let counter = 0;
let modern = true;
let mbox = "";

/** test_commit <message> [<file> [<contents> [<tag>]]] */
function testCommit(
  dir: string,
  message: string,
  file = `${message}.t`,
  contents = message,
  tag = message,
) {
  put(dir, file, `${contents}\n`);
  gitOk(root, dir, ["add", file]);
  gitOk(root, dir, ["commit", "-qm", message]);
  gitOk(root, dir, ["tag", tag]);
}

/** t4257's "set up patches to apply": the mbox of two patches, the repository at `base`. */
function setUp(dir: string): void {
  testCommit(dir, "unrelated");
  testCommit(dir, "no-conflict");
  testCommit(dir, "conflict-patch", "file", "patch");
  gitOk(root, dir, ["reset", "-q", "--hard", "unrelated"]);
  testCommit(dir, "conflict-main", "file", "main", "base");
}

function twins(): { native: string; ours: string } {
  const n = counter++;
  const dirs = { native: join(root, `n${n}`), ours: join(root, `o${n}`) };
  for (const dir of [dirs.native, dirs.ours]) {
    gitOk(root, root, ["init", "-q", "-b", "main", dir]);
    setUp(dir);
  }
  return dirs;
}

/** The repositories as both left them, `rebase-apply/` included. */
function state(dir: string) {
  const files = ["next", "last", "final-commit", "patch", "msg"];
  const apply: Record<string, string | undefined> = {};
  for (const f of files) {
    try {
      apply[f] = readFileSync(join(dir, ".git", "rebase-apply", f), "latin1");
    } catch {
      apply[f] = undefined;
    }
  }
  return { ...view(root, dir), apply };
}

async function compare(
  dirs: { native: string; ours: string },
  args: string[],
  answers: string[],
  configure: (c: AmCommand) => AmCommand,
  editors: Editor[] = [],
) {
  const n = native(root, dirs.native, ["am", ...args], answers, editors);
  const git = await openOurs(root, dirs.ours);
  const buffers: string[] = [];
  const cmd = configure(git.am().setLegacyMessages(!modern))
    .setInteractive(lineReader(answers))
    .setEditor(editorOf(editors, buffers));
  const r = await cmd.call();
  expect(r.output).toBe(n.stdout);
  // the editor's own failure line is the host's to print
  expect(r.errors).toBe(n.stderr.replace(/^error: there was a problem with the editor .*\n/im, ""));
  expect(r.exitCode).toBe(n.status);
  expect(buffers).toEqual(n.buffers);
  expect(state(dirs.ours)).toEqual(state(dirs.native));
}

describeGit("am -i as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "am-interactive-native-"));
    modern = gitAtLeast(gitOk(root, root, ["--version"]), 2, 50);
    const src = join(root, "src");
    gitOk(root, root, ["init", "-q", "-b", "main", src]);
    setUp(src);
    gitOk(root, src, ["checkout", "-q", "conflict-patch"]);
    mbox = join(root, "mbox");
    put(root, "mbox", gitOk(root, src, ["format-patch", "--stdout", "-2"]));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  const withMbox = (c: AmCommand) => c.addMbox(readFileSync(mbox), mbox);

  it('t4257-am-interactive.sh: "interactive am can apply a single patch"', async () => {
    await compare(twins(), ["-i", mbox], ["y", "n"], withMbox);
  });

  it('t4257-am-interactive.sh: "interactive am can resolve conflict"', async () => {
    const dirs = twins();
    await compare(dirs, ["-i", mbox], ["y", "y"], withMbox);
    for (const dir of [dirs.native, dirs.ours]) {
      put(dir, "file", "resolved\n");
      gitOk(root, dir, ["add", "-u"]);
    }
    await compare(dirs, ["-i", "--resolved"], ["y"], (c) => c.setResume("continue"));
  });

  it("asks again, shows the patch, edits the message, accepts all, stops at the end of input", async () => {
    const edit = sed("s/^no-conflict/edited subject/", (t) =>
      t.replace(/^no-conflict/m, "edited subject"),
    );
    await compare(twins(), ["-i", mbox], ["x", "v", "e", "Y", "N"], withMbox, [edit]);
    await compare(twins(), ["-i", mbox], ["e", "e", "a"], withMbox, [FAIL, edit]);
    await compare(twins(), ["-i", mbox], [], withMbox);
    await compare(twins(), ["-i", mbox], ["n", "n"], withMbox);
  });

  it("asks about a resolved patch: view, skip", async () => {
    const dirs = twins();
    await compare(dirs, ["-i", mbox], ["y", "yes"], withMbox);
    for (const dir of [dirs.native, dirs.ours]) {
      put(dir, "file", "resolved\n");
      gitOk(root, dir, ["add", "-u"]);
    }
    await compare(dirs, ["-i", "--resolved"], ["v", "n"], (c) => c.setResume("continue"));
  });
});
