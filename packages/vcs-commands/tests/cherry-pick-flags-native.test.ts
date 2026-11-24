/**
 * The flags of `cherry-pick` and `revert` against native git: `-x`, `-s`, the empties
 * (`--allow-empty`, `--allow-empty-message`, `--keep-redundant-commits`, `--empty=`), `--ff`,
 * `--reference` (and `revert.reference`), `-m <parent>`, `-n` and `-e`. Each history is built
 * twice by native git (fixed dates, so equal commits have equal ids), native git runs the
 * command in one twin and ours in the other, then the exit status, the first line git prints
 * on failure, HEAD, the last commits (ids and messages), HEAD's reflog, the index, every
 * worktree file and the state files (`sequencer/opts` among them) are compared. Each test
 * names the git test (t/ script and title) it takes its inputs from.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CherryPickStatus, GitApiError, RevertStatus, SequencerOperation } from "../src/index.js";
import {
  git,
  gitOk,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  put,
  snapshot,
} from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;
/** native git is 2.45 or later (`--empty`) */
let hasEmptyOption = true;
/** native git is 2.5x (else 2.43) */
let modern = true;

/**
 * Ours with nativeGitEnv's variables (author, committer and their dates resolved as native
 * git resolves them) and the native version's compatibility.
 */
function ourEnvironment(): GitHostEnvironment {
  const env = nativeGitEnv(root);
  return createNodeGitHostEnvironment({
    env,
    hookRunner: createNodeHookRunner({ env, compatibility: modern ? "2.56" : "2.43" }),
  });
}

/** A commit of `message` (exact bytes, no cleanup) with `parent` and `tree`; its id. */
function commitTree(dir: string, tree: string, parents: string[], message: string): string {
  const r = spawnSync("git", ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])], {
    cwd: dir,
    env: nativeGitEnv(root),
    input: message,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** The repository `build` makes, built twice. */
function twins(build: (dir: string) => void): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    mkdirSync(dir, { recursive: true });
    gitOk(root, dir, "init", "-q", "-b", "main");
    gitOk(root, dir, "config", "advice.detachedHead", "false");
    build(dir);
  }
  return { native, ours };
}

/** test_commit: `file` set to `content` (default the message), committed, tagged `tag`. */
function testCommit(dir: string, message: string, file?: string, content?: string, tag?: string) {
  const name = file ?? `${message}.t`;
  put(dir, name, `${content ?? message}\n`);
  gitOk(root, dir, "add", name);
  gitOk(root, dir, "commit", "-q", "-m", message);
  gitOk(root, dir, "tag", tag ?? message);
}

/** The commits and HEAD's reflog, as both twins must have them. */
function history(dir: string): string {
  const log = git(root, dir, "log", "-4", "--format=%H %P%n%an <%ae> %ad%n%cn <%ce> %cd%n%B%x00");
  const reflog = git(root, dir, "reflog", "-3", "--format=%gs");
  return `${log.stdout}\n${reflog.stdout}`;
}

function compare(ours: string, native: string): void {
  expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
  expect(history(ours)).toBe(history(native));
}

interface Run {
  status: number;
  /** what git prints to stderr (ours: the message and the output lines) */
  stderr: string;
}

/**
 * Ours, given git's arguments: `cherry-pick` or `revert` and its options, then the commits.
 */
async function ours(dir: string, args: string[]): Promise<Run> {
  const [name, ...rest] = args;
  const g = await openOurs(dir, ourEnvironment());
  const command = name === "revert" ? g.revert() : g.cherryPick();
  for (let k = 0; k < rest.length; k++) {
    const arg = rest[k];
    if (arg === "-x") (command as ReturnType<typeof g.cherryPick>).setRecordOrigin(true);
    else if (arg === "-s" || arg === "--signoff") command.setSignoff(true);
    else if (arg === "--allow-empty")
      (command as ReturnType<typeof g.cherryPick>).setAllowEmpty(true);
    else if (arg === "--allow-empty-message")
      (command as ReturnType<typeof g.cherryPick>).setAllowEmptyMessage(true);
    else if (arg === "--keep-redundant-commits")
      (command as ReturnType<typeof g.cherryPick>).setKeepRedundantCommits(true);
    else if (arg.startsWith("--empty="))
      (command as ReturnType<typeof g.cherryPick>).setEmpty(
        arg.slice("--empty=".length) as "stop" | "drop" | "keep",
      );
    else if (arg === "--ff") (command as ReturnType<typeof g.cherryPick>).setFastForward(true);
    else if (arg === "--reference") (command as ReturnType<typeof g.revert>).setReference(true);
    else if (arg === "-m") command.setMainlineParentNumber(Number(rest[++k]));
    else if (arg === "-n" || arg === "--no-commit") command.setNoCommit(true);
    else if (arg === "-e" || arg === "--edit") command.setEdit(true);
    else if (arg === "--no-edit") command.setEdit(false);
    else if (arg === "--continue") command.setOperation(SequencerOperation.CONTINUE);
    else if (arg === "--skip") command.setOperation(SequencerOperation.SKIP);
    else if (arg === "--abort") command.setOperation(SequencerOperation.ABORT);
    else if (arg === "--quit") command.setOperation(SequencerOperation.QUIT);
    else command.include(arg);
  }
  try {
    const result = await command.call();
    const ok = result.status === CherryPickStatus.OK || result.status === RevertStatus.OK;
    const conflicting =
      result.status === CherryPickStatus.CONFLICTING || result.status === RevertStatus.CONFLICTING;
    const message = result.message ?? "";
    const stderr = [...(result.output ?? []), ...(message ? [message] : [])].join("\n");
    if (ok) return { status: 0, stderr };
    if (conflicting) return { status: 1, stderr };
    return { status: /^fatal: /m.test(message) ? 128 : 1, stderr };
  } catch (error) {
    if (!(error instanceof GitApiError)) throw error;
    return { status: error.exitCode, stderr: error.message };
  }
}

/** The first line of stderr git prints for an error (`error:`/`fatal:`/the empty pick's). */
function firstError(stderr: string): string {
  return (
    stderr
      .split("\n")
      .find((l) => /^(error|fatal): |^The previous|^dropping /.test(l))
      ?.replace(/^(\[| {2})/, "") ?? ""
  );
}

/** Native git and ours run `args`; status, first error line and the repositories compared. */
async function both(native: string, mine: string, args: string[]): Promise<Run> {
  const expected = git(root, native, ...args);
  const actual = await ours(mine, args);
  expect(actual.status, `${args.join(" ")}: ${expected.stderr}${actual.stderr}`).toBe(
    expected.status,
  );
  expect(firstError(actual.stderr)).toBe(firstError(expected.stderr));
  for (const line of expected.stderr.split("\n").filter((l) => l.startsWith("dropping "))) {
    expect(actual.stderr.split("\n")).toContain(line);
  }
  compare(mine, native);
  return actual;
}

/** Both twins: `args` run by native git (setting up, not compared). */
function inBoth(t: { native: string; ours: string }, ...args: string[]): void {
  for (const dir of [t.native, t.ours]) git(root, dir, ...args);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pick-flags-"));
  const version = gitOk(root, root, "version");
  hasEmptyOption = gitAtLeast(version, 2, 45);
  modern = gitAtLeast(version, 2, 50);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------
// t3511-cherry-pick-x.sh

const ME = `${INTEROP_IDENT.name} <${INTEROP_IDENT.email}>`;
const mesgOneLine = "base: commit message";
const mesgNoFooter = `${mesgOneLine}\n\nOneWordBodyThatsNotA-S-o-B`;
const mesgWithFooter = `${mesgNoFooter}\n\nSigned-off-by: ${ME}\nSigned-off-by: A.U. Thor <author@example.com>\nSigned-off-by: B.U. Thor <buthor@example.com>`;
const mesgBrokenFooter = `${mesgNoFooter}\n\nThis is not recognized as a footer because Myfooter is not a recognized token.\nMyfooter: A.U. Thor <author@example.com>`;
const mesgWithFooterSob = `${mesgWithFooter}\nSigned-off-by: ${ME}`;
const mesgWithCherryFooter = `${mesgWithFooterSob}\n(cherry picked from commit da39a3ee5e6b4b0d3255bfef95601890afd80709)\nTested-by: C.U. Thor <cuthor@example.com>`;
const mesgUnclean = `${mesgOneLine}\n\n\nleading empty lines\n\n\nconsecutive empty lines\n\n# hash tag comment\n\ntrailing empty lines\n\n\n`;

/** t3511's setup: initial, then a commit of each message off it (tags), detached at initial. */
function t3511(dir: string): void {
  put(dir, "unrelated", "unrelated\n");
  gitOk(root, dir, "add", "unrelated");
  testCommit(dir, "initial", "foo", "a");
  const messages: [string, string][] = [
    ["mesg-one-line", mesgOneLine],
    ["mesg-no-footer", mesgNoFooter],
    ["mesg-broken-footer", mesgBrokenFooter],
    ["mesg-with-footer", mesgWithFooter],
    ["mesg-with-footer-sob", mesgWithFooterSob],
    ["mesg-with-cherry-footer", mesgWithCherryFooter],
    ["mesg-unclean", mesgUnclean],
  ];
  for (const [tag, message] of messages) {
    gitOk(root, dir, "reset", "-q", "--hard", "initial");
    put(dir, "foo", "b\n");
    gitOk(root, dir, "add", "foo");
    gitOk(root, dir, "commit", "-q", "--cleanup=verbatim", "-m", message);
    gitOk(root, dir, "tag", tag);
  }
  const tree = gitOk(root, dir, "rev-parse", "mesg-with-footer^{tree}").trim();
  const initial = gitOk(root, dir, "rev-parse", "initial").trim();
  gitOk(
    root,
    dir,
    "tag",
    "no-nl-footer",
    commitTree(dir, tree, [initial], "title\n\nSigned-off-by: A <a@example.com>"),
  );
  gitOk(
    root,
    dir,
    "tag",
    "no-nl-no-footer",
    commitTree(dir, tree, [initial], "title\n\nnot a footer"),
  );
  gitOk(root, dir, "checkout", "-q", "-f", "initial^0");
}

describeGit("cherry-pick -x and -s as native git (t3511-cherry-pick-x)", () => {
  const cases: [string, string[]][] = [
    ["cherry-pick -x inserts blank line after one line subject", ["-x", "mesg-one-line"]],
    ["cherry-pick -s inserts blank line after one line subject", ["-s", "mesg-one-line"]],
    ["cherry-pick -s inserts blank line after non-conforming footer", ["-s", "mesg-broken-footer"]],
    [
      "cherry-pick -x inserts blank line when conforming footer not found",
      ["-x", "mesg-no-footer"],
    ],
    [
      "cherry-pick -s inserts blank line when conforming footer not found",
      ["-s", "mesg-no-footer"],
    ],
    [
      "cherry-pick -x -s inserts blank line when conforming footer not found",
      ["-x", "-s", "mesg-no-footer"],
    ],
    ["cherry-pick -s adds sob when last sob doesnt match committer", ["-s", "mesg-with-footer"]],
    [
      "cherry-pick -x -s adds sob when last sob doesnt match committer",
      ["-x", "-s", "mesg-with-footer"],
    ],
    ["cherry-pick -s refrains from adding duplicate trailing sob", ["-s", "mesg-with-footer-sob"]],
    [
      "cherry-pick -x -s adds sob even when trailing sob exists for committer",
      ["-x", "-s", "mesg-with-footer-sob"],
    ],
    ["cherry-pick -x handles commits with no NL at end of message", ["-x", "no-nl-footer"]],
    [
      "cherry-pick -x handles commits with no footer and no NL at end of message",
      ["-x", "no-nl-no-footer"],
    ],
    ["cherry-pick -s handles commits with no NL at end of message", ["-s", "no-nl-footer"]],
    [
      "cherry-pick -s handles commits with no footer and no NL at end of message",
      ["-s", "no-nl-no-footer"],
    ],
    [
      'cherry-pick -x treats "(cherry picked from..." line as part of footer',
      ["-x", "mesg-with-cherry-footer"],
    ],
    [
      'cherry-pick -s treats "(cherry picked from..." line as part of footer',
      ["-s", "mesg-with-cherry-footer"],
    ],
    [
      'cherry-pick -x -s treats "(cherry picked from..." line as part of footer',
      ["-x", "-s", "mesg-with-cherry-footer"],
    ],
    ["cherry-pick preserves commit message", ["mesg-unclean"]],
    ["cherry-pick -x cleans commit message", ["-x", "mesg-unclean"]],
  ];
  for (const [title, args] of cases) {
    it(`t3511-cherry-pick-x.sh: "${title}"`, async () => {
      const t = twins(t3511);
      await both(t.native, t.ours, ["cherry-pick", ...args]);
    });
  }

  it('t3511-cherry-pick-x.sh: "cherry-pick -s recognizes trailer config"', async () => {
    const t = twins(t3511);
    inBoth(t, "config", "trailer.Myfooter.ifexists", "add");
    await both(t.native, t.ours, ["cherry-pick", "-s", "mesg-broken-footer"]);
  });

  it('t3511-cherry-pick-x.sh: "cherry-pick -x respects commit.cleanup"', async () => {
    const t = twins(t3511);
    inBoth(t, "config", "commit.cleanup", "strip");
    await both(t.native, t.ours, ["cherry-pick", "-x", "mesg-unclean"]);
  });

  it("commit.cleanup=verbatim keeps -x's message as it is", async () => {
    const t = twins(t3511);
    inBoth(t, "config", "commit.cleanup", "verbatim");
    await both(t.native, t.ours, ["cherry-pick", "-x", "-s", "mesg-unclean"]);
  });

  it("-e commits -x's and -s's message through git commit's editor (comments stripped)", async () => {
    for (const args of [
      ["-e", "-x", "-s", "mesg-unclean"],
      ["-e", "mesg-with-footer"],
    ]) {
      const t = twins(t3511);
      await both(t.native, t.ours, ["cherry-pick", ...args]);
    }
  });

  it("-x and -s of a conflicting pick are in MERGE_MSG, and -n writes them too", async () => {
    const t = twins(t3511);
    inBoth(t, "checkout", "-q", "mesg-one-line^0");
    // mesg-no-footer changes foo a -> b as well, on a HEAD where foo is b: empty
    await both(t.native, t.ours, ["cherry-pick", "-x", "-s", "mesg-no-footer"]);
    inBoth(t, "cherry-pick", "--abort");
    put(t.native, "foo", "c\n");
    put(t.ours, "foo", "c\n");
    inBoth(t, "commit", "-q", "-a", "-m", "c");
    await both(t.native, t.ours, ["cherry-pick", "-x", "-s", "mesg-no-footer"]);
    inBoth(t, "cherry-pick", "--abort");
    inBoth(t, "checkout", "-q", "-f", "initial^0");
    await both(t.native, t.ours, ["cherry-pick", "-n", "-x", "-s", "mesg-no-footer"]);
  });
});

// ---------------------------------------------------------------------------------------
// t3510-cherry-pick-sequence.sh

function t3510(dir: string): void {
  put(dir, "unrelated", "unrelated\n");
  gitOk(root, dir, "add", "unrelated");
  testCommit(dir, "initial", "foo", "a");
  testCommit(dir, "base", "foo", "b");
  testCommit(dir, "unrelatedpick", "unrelated", "reallyunrelated");
  testCommit(dir, "picked", "foo", "c");
  testCommit(dir, "anotherpick", "foo", "d");
  testCommit(dir, "yetanotherpick", "foo", "e");
  gitOk(root, dir, "checkout", "-q", "-f", "initial^0");
  testCommit(dir, "conflicting", "unrelated");
}

describeGit(
  "cherry-pick sequences keep their flags as native git (t3510-cherry-pick-sequence)",
  () => {
    const detach = (t: { native: string; ours: string }, rev: string) =>
      inBoth(t, "checkout", "-q", "-f", `${rev}^0`);

    it('t3510-cherry-pick-sequence.sh: "cherry-pick persists data on failure"', async () => {
      const t = twins(t3510);
      detach(t, "initial");
      await both(t.native, t.ours, ["cherry-pick", "-s", "base", "unrelatedpick", "picked"]);
    });

    for (const mode of ["stop", "drop", "keep"]) {
      it(`t3510-cherry-pick-sequence.sh: "cherry-pick persists --empty=${mode} correctly"`, async () => {
        if (!hasEmptyOption) return;
        const t = twins(t3510);
        detach(t, "yetanotherpick");
        await both(t.native, t.ours, [
          "cherry-pick",
          `--empty=${mode}`,
          "anotherpick",
          "yetanotherpick",
        ]);
        await both(t.native, t.ours, ["cherry-pick", "--skip"]);
      });
    }

    it('t3510-cherry-pick-sequence.sh: "--continue respects opts"', async () => {
      const t = twins(t3510);
      detach(t, "initial");
      await both(t.native, t.ours, [
        "cherry-pick",
        "-x",
        "base",
        "unrelatedpick",
        "picked",
        "anotherpick",
      ]);
      put(t.native, "foo", "c\n");
      put(t.ours, "foo", "c\n");
      inBoth(t, "add", "foo");
      inBoth(t, "commit", "-q", "--no-edit");
      await both(t.native, t.ours, ["cherry-pick", "--continue"]);
    });

    it('t3510-cherry-pick-sequence.sh: "--continue of single-pick respects -x"', async () => {
      const t = twins(t3510);
      detach(t, "initial");
      await both(t.native, t.ours, ["cherry-pick", "-x", "picked"]);
      put(t.native, "foo", "c\n");
      put(t.ours, "foo", "c\n");
      inBoth(t, "add", "foo");
      await both(t.native, t.ours, ["cherry-pick", "--continue"]);
    });

    it('t3510-cherry-pick-sequence.sh: "--continue respects -x in first commit in multi-pick"', async () => {
      const t = twins(t3510);
      detach(t, "initial");
      await both(t.native, t.ours, ["cherry-pick", "-x", "picked", "anotherpick"]);
      put(t.native, "foo", "c\n");
      put(t.ours, "foo", "c\n");
      inBoth(t, "add", "foo");
      await both(t.native, t.ours, ["cherry-pick", "--continue"]);
    });

    it("our --continue goes on with native git's -x -s sequence, and native git with ours", async () => {
      for (const continuer of ["native", "ours"] as const) {
        const t = twins(t3510);
        detach(t, "initial");
        await both(t.native, t.ours, ["cherry-pick", "-x", "-s", "base", "picked", "anotherpick"]);
        // a twin stopped by the other implementation: swap the sequencer state
        put(t.native, "foo", "c\n");
        put(t.ours, "foo", "c\n");
        inBoth(t, "add", "foo");
        if (continuer === "native") {
          expect(git(root, t.ours, "cherry-pick", "--continue").status).toBe(
            (await ours(t.native, ["cherry-pick", "--continue"])).status,
          );
        } else {
          await both(t.native, t.ours, ["cherry-pick", "--continue"]);
        }
        compare(t.ours, t.native);
      }
    });
  },
);

// ---------------------------------------------------------------------------------------
// t3505-cherry-pick-empty.sh

function t3505(dir: string): void {
  put(dir, "file1", "first\n");
  gitOk(root, dir, "add", "file1");
  gitOk(root, dir, "commit", "-q", "-m", "first");
  gitOk(root, dir, "checkout", "-q", "-b", "empty-message-branch");
  put(dir, "file1", "first\nthird\n");
  gitOk(root, dir, "add", "file1");
  gitOk(root, dir, "commit", "-q", "--allow-empty-message", "-m", "");
  gitOk(root, dir, "checkout", "-q", "main");
  gitOk(root, dir, "checkout", "-q", "-b", "empty-change-branch");
  gitOk(root, dir, "commit", "-q", "--allow-empty", "-m", "empty");
  gitOk(root, dir, "checkout", "-q", "main");
}

/** t3505's "cherry-pick a commit that becomes no-op (prep)": main and fork both add file2. */
function t3505Noop(dir: string): void {
  t3505(dir);
  put(dir, "file2", "fourth\n");
  gitOk(root, dir, "add", "file2");
  gitOk(root, dir, "commit", "-q", "-m", "fourth");
  gitOk(root, dir, "branch", "fork");
  put(dir, "file2", "foo\n");
  gitOk(root, dir, "add", "file2");
  gitOk(root, dir, "commit", "-q", "-m", "add file2 on main");
  gitOk(root, dir, "checkout", "-q", "fork");
  put(dir, "file2", "foo\n");
  gitOk(root, dir, "add", "file2");
  gitOk(root, dir, "commit", "-q", "-m", "add file2 on the side");
  gitOk(root, dir, "checkout", "-q", "fork^0");
}

describeGit("cherry-pick of empty commits as native git (t3505-cherry-pick-empty)", () => {
  it('t3505-cherry-pick-empty.sh: "cherry-pick an empty commit"', async () => {
    const t = twins(t3505);
    await both(t.native, t.ours, ["cherry-pick", "empty-change-branch"]);
  });

  it('t3505-cherry-pick-empty.sh: "cherry-pick a commit with an empty message"', async () => {
    const t = twins(t3505);
    await both(t.native, t.ours, ["cherry-pick", "empty-message-branch"]);
  });

  it('t3505-cherry-pick-empty.sh: "cherry-pick a commit with an empty message with --allow-empty-message"', async () => {
    const t = twins(t3505);
    await both(t.native, t.ours, ["cherry-pick", "--allow-empty-message", "empty-message-branch"]);
  });

  it('t3505-cherry-pick-empty.sh: "cherry pick an empty non-ff commit without --allow-empty"', async () => {
    const t = twins(t3505);
    for (const dir of [t.native, t.ours]) {
      put(dir, "file2", "fourth\n");
      gitOk(root, dir, "add", "file2");
      gitOk(root, dir, "commit", "-q", "-m", "fourth");
    }
    await both(t.native, t.ours, ["cherry-pick", "empty-change-branch"]);
  });

  it('t3505-cherry-pick-empty.sh: "cherry pick an empty non-ff commit with --allow-empty"', async () => {
    const t = twins(t3505);
    for (const dir of [t.native, t.ours]) {
      put(dir, "file2", "fourth\n");
      gitOk(root, dir, "add", "file2");
      gitOk(root, dir, "commit", "-q", "-m", "fourth");
    }
    await both(t.native, t.ours, ["cherry-pick", "--allow-empty", "empty-change-branch"]);
  });

  it('t3505-cherry-pick-empty.sh: "cherry pick with --keep-redundant-commits"', async () => {
    const t = twins(t3505);
    for (const dir of [t.native, t.ours]) {
      put(dir, "file2", "fourth\n");
      gitOk(root, dir, "add", "file2");
      gitOk(root, dir, "commit", "-q", "-m", "fourth");
    }
    await both(t.native, t.ours, ["cherry-pick", "--keep-redundant-commits", "HEAD^"]);
  });

  it('t3505-cherry-pick-empty.sh: "cherry-pick a no-op with neither --keep-redundant nor --empty"', async () => {
    const t = twins(t3505Noop);
    await both(t.native, t.ours, ["cherry-pick", "main"]);
  });

  it('t3505-cherry-pick-empty.sh: "cherry-pick a no-op with --keep-redundant"', async () => {
    const t = twins(t3505Noop);
    await both(t.native, t.ours, ["cherry-pick", "--keep-redundant-commits", "main"]);
  });

  for (const mode of ["stop", "drop", "keep"]) {
    it(`t3505-cherry-pick-empty.sh: "cherry-pick a no-op with --empty=${mode}"`, async () => {
      if (!hasEmptyOption) return;
      const t = twins(t3505Noop);
      await both(t.native, t.ours, ["cherry-pick", `--empty=${mode}`, "main"]);
    });
  }

  it("--empty=drop leaves an originally empty commit to --allow-empty; --keep-redundant-commits keeps it", async () => {
    for (const args of [
      ["--empty=drop", "empty-change-branch"],
      ["--empty=drop", "--allow-empty", "empty-change-branch"],
      ["--empty=keep", "empty-change-branch"],
      ["--keep-redundant-commits", "empty-change-branch"],
    ]) {
      if (!hasEmptyOption && args[0].startsWith("--empty")) continue;
      const t = twins(t3505);
      await both(t.native, t.ours, ["cherry-pick", ...args]);
    }
  });

  it("--empty=drop in a sequence drops the redundant commit and picks the rest", async () => {
    if (!hasEmptyOption) return;
    const t = twins(t3505Noop);
    await both(t.native, t.ours, ["cherry-pick", "--empty=drop", "main", "empty-message-branch"]);
  });

  it('t3505-cherry-pick-empty.sh: "--keep-redundant-commits is incompatible with operations", "--empty is incompatible with operations"', async () => {
    const t = twins(t3505);
    await both(t.native, t.ours, ["cherry-pick", "HEAD"]);
    const flags = [["--keep-redundant-commits"], ...(hasEmptyOption ? [["--empty=stop"]] : [])];
    for (const flag of flags) {
      for (const op of ["--continue", "--skip", "--abort", "--quit"]) {
        await both(t.native, t.ours, ["cherry-pick", ...flag, op]);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------
// t3506-cherry-pick-ff.sh, t3502-cherry-pick-merge.sh

function t3506(dir: string): void {
  put(dir, "file1", "first\n");
  gitOk(root, dir, "add", "file1");
  gitOk(root, dir, "commit", "-q", "-m", "first");
  gitOk(root, dir, "tag", "first");
  gitOk(root, dir, "checkout", "-q", "-b", "other");
  put(dir, "file1", "first\nsecond\n");
  gitOk(root, dir, "add", "file1");
  gitOk(root, dir, "commit", "-q", "-m", "second");
  gitOk(root, dir, "tag", "second");
  gitOk(root, dir, "checkout", "-q", "main");
}

/** The merge graph: B---C over first---A (t3506's "merge setup", t3502's setup). */
function mergeGraph(dir: string): void {
  t3506(dir);
  put(dir, "A", "new line\n");
  gitOk(root, dir, "add", "A");
  gitOk(root, dir, "commit", "-q", "-m", "add line to A");
  gitOk(root, dir, "tag", "A");
  gitOk(root, dir, "checkout", "-q", "-b", "side", "first");
  put(dir, "B", "new line\n");
  gitOk(root, dir, "add", "B");
  gitOk(root, dir, "commit", "-q", "-m", "add line to B");
  gitOk(root, dir, "tag", "B");
  gitOk(root, dir, "checkout", "-q", "main");
  gitOk(root, dir, "merge", "-q", "--no-edit", "side");
  gitOk(root, dir, "tag", "C");
  gitOk(root, dir, "checkout", "-q", "-b", "new", "A");
}

describeGit("cherry-pick --ff as native git (t3506-cherry-pick-ff)", () => {
  it('t3506-cherry-pick-ff.sh: "cherry-pick using --ff fast forwards"', async () => {
    const t = twins(t3506);
    await both(t.native, t.ours, ["cherry-pick", "--ff", "second"]);
  });

  it('t3506-cherry-pick-ff.sh: "cherry-pick not using --ff does not fast forwards"', async () => {
    const t = twins(t3506);
    await both(t.native, t.ours, ["cherry-pick", "second"]);
  });

  const cases: [string, string, string[]][] = [
    ["cherry-pick explicit first parent of a non-merge with --ff", "A", ["--ff", "-m", "1", "B"]],
    ["cherry pick a merge with --ff but without -m should fail", "A", ["--ff", "C"]],
    ["cherry pick with --ff a merge (1)", "A", ["--ff", "-m", "1", "C"]],
    ["cherry pick with --ff a merge (2)", "B", ["--ff", "-m", "2", "C"]],
    [
      "cherry pick a merge relative to nonexistent parent with --ff should fail",
      "B",
      ["--ff", "-m", "3", "C"],
    ],
  ];
  for (const [title, start, args] of cases) {
    it(`t3506-cherry-pick-ff.sh: "${title}"`, async () => {
      const t = twins(mergeGraph);
      inBoth(t, "reset", "-q", "--hard", start);
      await both(t.native, t.ours, ["cherry-pick", ...args]);
    });
  }

  it('t3506-cherry-pick-ff.sh: "cherry pick a root commit with --ff"', async () => {
    const t = twins(mergeGraph);
    for (const dir of [t.native, t.ours]) {
      gitOk(root, dir, "reset", "-q", "--hard", "first");
      gitOk(root, dir, "rm", "-q", "file1");
      put(dir, "file2", "first\n");
      gitOk(root, dir, "add", "file2");
      gitOk(root, dir, "commit", "-q", "--amend", "-m", "file2");
    }
    await both(t.native, t.ours, ["cherry-pick", "--ff", "first"]);
  });

  it('t3506-cherry-pick-ff.sh: "cherry-pick --ff on unborn branch"', async () => {
    const t = twins(t3506);
    for (const dir of [t.native, t.ours]) {
      gitOk(root, dir, "checkout", "-q", "--orphan", "unborn");
      gitOk(root, dir, "rm", "-q", "--cached", "-r", ".");
      rmSync(join(dir, "file1"));
    }
    await both(t.native, t.ours, ["cherry-pick", "--ff", "first"]);
  });

  it("--ff refuses -s, -x, -n and --edit as git", async () => {
    const t = twins(t3506);
    for (const flag of ["-s", "-x", "-n", "--edit"]) {
      await both(t.native, t.ours, ["cherry-pick", "--ff", flag, "second"]);
    }
  });

  it("--ff in a sequence fast-forwards what it can and picks the rest", async () => {
    const t = twins(mergeGraph);
    inBoth(t, "reset", "-q", "--hard", "first");
    await both(t.native, t.ours, ["cherry-pick", "--ff", "A", "B", "second"]);
  });
});

describeGit("cherry-pick and revert -m as native git (t3502-cherry-pick-merge)", () => {
  const cases: [string, string, string[]][] = [
    ["cherry-pick explicit first parent of a non-merge", "A", ["cherry-pick", "-m", "1", "B"]],
    ["cherry pick a merge without -m should fail", "A", ["cherry-pick", "C"]],
    ["cherry pick a merge (1)", "A", ["cherry-pick", "-m", "1", "C"]],
    ["cherry pick a merge (2)", "B", ["cherry-pick", "-m", "2", "C"]],
    [
      "cherry pick a merge relative to nonexistent parent should fail",
      "B",
      ["cherry-pick", "-m", "3", "C"],
    ],
    ["revert explicit first parent of a non-merge", "C", ["revert", "--no-edit", "-m", "1", "B"]],
    ["revert a merge without -m should fail", "C", ["revert", "C"]],
    ["revert a merge (1)", "C", ["revert", "--no-edit", "-m", "1", "C"]],
    ["revert a merge (2)", "C", ["revert", "--no-edit", "-m", "2", "C"]],
    ["revert a merge relative to nonexistent parent should fail", "C", ["revert", "-m", "3", "C"]],
  ];
  for (const [title, start, args] of cases) {
    it(`t3502-cherry-pick-merge.sh: "${title}"`, async () => {
      const t = twins(mergeGraph);
      inBoth(t, "reset", "-q", "--hard", start);
      await both(t.native, t.ours, args);
    });
  }

  it("-m 2 on a non-merge is refused, -m 1 -n of a merge writes MERGE_MSG", async () => {
    const t = twins(mergeGraph);
    inBoth(t, "reset", "-q", "--hard", "A");
    await both(t.native, t.ours, ["cherry-pick", "-m", "2", "B"]);
    await both(t.native, t.ours, ["cherry-pick", "-n", "-m", "1", "C"]);
    inBoth(t, "reset", "-q", "--hard", "C");
    await both(t.native, t.ours, ["revert", "-n", "-m", "1", "C"]);
  });
});

// ---------------------------------------------------------------------------------------
// t3501-revert-cherry-pick.sh, t3503-cherry-pick-root.sh

describeGit(
  "revert titles, --reference and signoff as native git (t3501-revert-cherry-pick)",
  () => {
    function twoCommits(dir: string): void {
      testCommit(dir, "A", "file1", "A");
      testCommit(dir, "B", "file1", "B");
    }

    it('t3501-revert-cherry-pick.sh: "titles of fresh reverts"', async () => {
      const t = twins(twoCommits);
      for (let k = 0; k < 3; k++) await both(t.native, t.ours, ["revert", "--no-edit", "HEAD"]);
    });

    it('t3501-revert-cherry-pick.sh: "title of legacy double revert"', async () => {
      const t = twins(twoCommits);
      for (const dir of [t.native, t.ours]) {
        put(dir, "file1", "X\n");
        gitOk(root, dir, "commit", "-q", "-a", "-m", 'Revert "Revert "B""');
      }
      await both(t.native, t.ours, ["revert", "--no-edit", "HEAD"]);
    });

    it('t3501-revert-cherry-pick.sh: "identification of reverted commit (default)"', async () => {
      const t = twins(twoCommits);
      await both(t.native, t.ours, ["revert", "--no-edit", "HEAD"]);
    });

    it('t3501-revert-cherry-pick.sh: "identification of reverted commit (--reference)"', async () => {
      const t = twins(twoCommits);
      await both(t.native, t.ours, ["revert", "--reference", "--no-edit", "HEAD"]);
    });

    it('t3501-revert-cherry-pick.sh: "git revert --reference with core.commentChar"', async () => {
      const t = twins(twoCommits);
      inBoth(t, "config", "core.commentChar", "%");
      await both(t.native, t.ours, ["revert", "--edit", "--reference", "HEAD"]);
    });

    it('t3501-revert-cherry-pick.sh: "identification of reverted commit (revert.reference)"', async () => {
      const t = twins(twoCommits);
      inBoth(t, "config", "revert.reference", "true");
      await both(t.native, t.ours, ["revert", "--no-edit", "HEAD"]);
    });

    it("--reference of a merge names both commits; -s and -n of a revert", async () => {
      const t = twins(mergeGraph);
      inBoth(t, "reset", "-q", "--hard", "C");
      await both(t.native, t.ours, ["revert", "--reference", "--no-edit", "-m", "1", "C"]);
      await both(t.native, t.ours, ["revert", "-s", "--no-edit", "B"]);
      await both(t.native, t.ours, ["revert", "-n", "--reference", "A"]);
    });

    it('t3501-revert-cherry-pick.sh: "cherry-pick on unborn branch"', async () => {
      const t = twins(twoCommits);
      for (const dir of [t.native, t.ours]) {
        gitOk(root, dir, "switch", "-q", "--orphan", "unborn");
      }
      await both(t.native, t.ours, ["cherry-pick", "A"]);
    });
  },
);

describeGit("root commits as native git (t3503-cherry-pick-root)", () => {
  function roots(dir: string): void {
    put(dir, "file1", "first\n");
    gitOk(root, dir, "add", "file1");
    gitOk(root, dir, "commit", "-q", "-m", "first");
    gitOk(root, dir, "symbolic-ref", "HEAD", "refs/heads/second");
    rmSync(join(dir, ".git/index"));
    rmSync(join(dir, "file1"));
    put(dir, "file2", "second\n");
    gitOk(root, dir, "add", "file2");
    gitOk(root, dir, "commit", "-q", "-m", "second");
    gitOk(root, dir, "checkout", "-q", "second^0");
  }

  it('t3503-cherry-pick-root.sh: "cherry-pick a root commit", "revert a root commit"', async () => {
    const t = twins(roots);
    await both(t.native, t.ours, ["cherry-pick", "-x", "main"]);
    await both(t.native, t.ours, ["revert", "--no-edit", "-s", "main"]);
  });
});

describeGit("sequences onto an unborn branch as native git", () => {
  /** t3506's history, then an unborn branch with an empty index and worktree. */
  function unborn(dir: string): void {
    t3506(dir);
    // a root commit of second's tree: picked after first and second, it becomes empty
    const tree = gitOk(root, dir, "rev-parse", "second^{tree}").trim();
    gitOk(root, dir, "tag", "again", commitTree(dir, tree, [], "again"));
    gitOk(root, dir, "checkout", "-q", "--orphan", "unborn");
    gitOk(root, dir, "rm", "-q", "--cached", "-r", ".");
    rmSync(join(dir, "file1"));
  }

  it("a multi-commit cherry-pick onto an unborn branch commits every pick", async () => {
    const t = twins(unborn);
    await both(t.native, t.ours, ["cherry-pick", "first", "second"]);
  });

  it("a multi-commit cherry-pick onto an unborn branch stopped saves the null head; --abort refuses", async () => {
    const t = twins(unborn);
    // `again` on top of second is empty: the sequence stops with sequencer/head null
    await both(t.native, t.ours, ["cherry-pick", "first", "second", "again"]);
    await both(t.native, t.ours, ["cherry-pick", "--abort"]);
    await both(t.native, t.ours, ["cherry-pick", "--skip"]);
  });

  it("a commit named twice is picked once, as git's revision walk lists it", async () => {
    const t = twins(unborn);
    await both(t.native, t.ours, ["cherry-pick", "first", "second", "second"]);
  });

  it("a multi-commit revert onto an unborn branch refuses as git (can't revert as initial commit)", async () => {
    const t = twins(unborn);
    await both(t.native, t.ours, ["revert", "--no-edit", "second", "first"]);
  });
});
