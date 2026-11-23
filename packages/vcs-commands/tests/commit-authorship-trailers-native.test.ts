/**
 * `git commit`'s sign-off, trailers and authorship options against native git: `-s`
 * (sequencer.c `append_signoff`), `--trailer` (trailer.c `amend_file_with_trailers`),
 * `--author` as a string, a pattern included (builtin/commit.c `find_author_by_nickname`),
 * `--date` (`parse_force_date`), `-C` and `--reset-author` (`determine_author_info`), and
 * `--allow-empty` / `--allow-empty-message`. Each case builds the same repository twice with
 * native git (same ids), runs native `git commit <args>` in one and ours in the other with the
 * same `GIT_AUTHOR_*` / `GIT_COMMITTER_*`, and compares the commits made (`cat-file -p`, ids)
 * or the refusals (git's stderr, our error's message).
 *
 * Inputs from t7500-commit-template-squash-signoff.sh, t7501-commit-basic-functionality.sh,
 * t7502-commit-porcelain.sh, t7509-commit-authorship.sh and t7513-interpret-trailers.sh.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CleanupMode, type CommitCommand } from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

type Env = Record<string, string | undefined>;

let root = "";
let home = "";
let counter = 0;

/** The identities of the commits made (the base repository has others). */
const OP: Env = {
  GIT_AUTHOR_NAME: "Ann Author",
  GIT_AUTHOR_EMAIL: "ann@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0200",
  GIT_COMMITTER_NAME: "Cid Committer",
  GIT_COMMITTER_EMAIL: "cid@example.com",
  GIT_COMMITTER_DATE: "1700000500 -0700",
};

function envOf(over: Env = {}): Record<string, string> {
  const env: Env = { ...nativeGitEnv(home), ...OP, ...over };
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

function run(cwd: string, env: Env, args: string[]) {
  const r = spawnSync("git", args, { cwd, env: env as Record<string, string> });
  return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function gitOk(cwd: string, env: Env, ...args: string[]): string {
  const r = run(cwd, env, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/** A commit by `who` (`Name <email>`) dated `date` (author and committer). */
function commitAs(repo: string, who: string, date: string, message: string): void {
  const m = /^(.*) <(.*)>$/.exec(who) as RegExpExecArray;
  gitOk(
    repo,
    envOf({
      GIT_AUTHOR_NAME: m[1],
      GIT_AUTHOR_EMAIL: m[2],
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: m[1],
      GIT_COMMITTER_EMAIL: m[2],
      GIT_COMMITTER_DATE: date,
    }),
    "commit",
    "-q",
    "-m",
    message,
  );
}

/**
 * The repository both twins start from: main (c1 by Frotz Nitfol, c2 by A U Thor adding a
 * `.mailmap` that maps `old@example.com` to New Name), `side` (c1, s1 by Old Name, the
 * newest commit), and a.txt changed and staged.
 */
function base(dir: string, config: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  const repo = join(dir, "repo");
  gitOk(dir, envOf(), "init", "-q", "-b", "main", "repo");
  for (const [k, v] of Object.entries(config)) gitOk(repo, envOf(), "config", k, v);
  put(repo, "a.txt", "a\n");
  gitOk(repo, envOf(), "add", ".");
  commitAs(repo, "Frotz Nitfol <nitfol@example.com>", "1600000000 +0100", "c1");
  gitOk(repo, envOf(), "branch", "side");
  put(repo, ".mailmap", "New Name <new@example.com> <old@example.com>\n");
  put(repo, "a.txt", "a\nb\n");
  gitOk(repo, envOf(), "add", ".");
  commitAs(repo, "A U Thor <author@example.com>", "1600001000 -0500", "c2\n\nbody of c2");
  gitOk(repo, envOf(), "checkout", "-q", "side");
  put(repo, "s.txt", "s\n");
  gitOk(repo, envOf(), "add", ".");
  commitAs(repo, "Old Name <old@example.com>", "1600002000 +0000", "s1");
  gitOk(repo, envOf(), "checkout", "-q", "main");
  put(repo, "a.txt", "a\nb\nc\n");
  gitOk(repo, envOf(), "add", ".");
  return repo;
}

interface Twin {
  native: string;
  ours: string;
}

function twins(config: Record<string, string> = {}): Twin {
  const n = counter++;
  return {
    native: base(join(root, `t${n}-native`), config),
    ours: base(join(root, `t${n}-ours`), config),
  };
}

async function oursCommit(repo: string, env: Record<string, string>): Promise<CommitCommand> {
  const environment = createNodeGitHostEnvironment({
    env,
    hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
  });
  return (await openOurs(repo, environment)).commit();
}

const show = (repo: string) => {
  const id = gitOk(repo, envOf(), "rev-parse", "HEAD").trim();
  return { id, object: gitOk(repo, envOf(), "cat-file", "-p", id) };
};

/**
 * Native `git commit <args>` in one twin, ours (`setup`) in the other, with `over` on top of
 * the operation's variables: both make the same commit, or both refuse with git's lines.
 */
async function expectCommit(
  t: Twin,
  args: string[],
  setup: (c: CommitCommand) => CommitCommand,
  over: Env = {},
): Promise<{ failed: boolean; stderr: string }> {
  const env = envOf(over);
  const native = run(t.native, env, ["commit", "-q", ...args]);
  let error: Error | undefined;
  try {
    await setup(await oursCommit(t.ours, env)).call();
  } catch (e) {
    error = e as Error;
  }
  const label = `git commit ${args.join(" ")}`;
  expect(error === undefined, `${label}: ${String(error)} / ${native.stderr}`).toBe(
    native.status === 0,
  );
  if (error) {
    // git's refusal: the lines on stderr (the status it prints goes to stdout)
    if (native.stderr.trim() !== "") {
      expect(error.message.trimEnd(), label).toBe(native.stderr.trimEnd());
    }
  }
  expect(show(t.ours), label).toEqual(show(t.native));
  return { failed: native.status !== 0, stderr: native.stderr };
}

const message = (t: Twin) => gitOk(t.native, envOf(), "log", "-1", "--format=%B");

describeGit("commit -s, --trailer, --author, --date, -C: native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "commit-authorship-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  // t7500 "--signoff", t7501 "sign off (1)" / "sign off (2)", t7502 "-s and message"
  it("-s: the committer's sign-off, after a blank line unless the message ends with trailers", async () => {
    const cases: string[] = [
      "one",
      "subject\n\nbody text",
      "subject\n\nCc: Someone <some@example.com>",
      "subject\n\nSigned-off-by: Cid Committer <cid@example.com>",
      "subject\n\nSigned-off-by: Cid Committer <cid@example.com>\nCc: Other <o@example.com>",
      "subject\n\nSigned-off-by: Someone Else <else@example.com>",
      "subject\n\n(cherry picked from commit 0123456789abcdef0123456789abcdef01234567)",
      "subject\n\nNot a trailer line\nReviewed-by: R <r@example.com>",
      "Signed-off-by: Cid Committer <cid@example.com>",
    ];
    for (const m of cases) {
      const t = twins();
      await expectCommit(t, ["-s", "-m", m], (c) => c.setSignoff(true).setMessage(m));
    }
  });

  // t7502 "sign off and comments", t7500 "--signoff with -F" (verbatim keeps the comments)
  it("-s: before trailing comment lines and the scissors line (ignored_log_message_bytes)", async () => {
    for (const m of [
      "subject\n\n# a comment\n",
      "subject\n\nbody\n# ------------------------ >8 ------------------------\nbelow\n",
    ]) {
      const t = twins();
      await expectCommit(t, ["-s", "--cleanup=verbatim", "-m", m], (c) =>
        c.setSignoff(true).setCleanupMode(CleanupMode.VERBATIM).setMessage(m),
      );
    }
  });

  // t7501 "amend commit to fix author" / "--amend --signoff", t7502 "--amend -s"
  it("--amend -s: the reused message signed off once", async () => {
    const t = twins();
    await expectCommit(t, ["--amend", "-s", "--no-edit"], (c) =>
      c.setAmend(true).setSignoff(true).setEdit(false),
    );
    expect(message(t)).toContain("Signed-off-by: Cid Committer <cid@example.com>");
    // again: the sign-off is the last trailer already
    await expectCommit(t, ["--amend", "-s", "--no-edit"], (c) =>
      c.setAmend(true).setSignoff(true).setEdit(false),
    );
    // another committer signs off below it
    await expectCommit(
      t,
      ["--amend", "-s", "--no-edit"],
      (c) => c.setAmend(true).setSignoff(true).setEdit(false),
      { GIT_COMMITTER_NAME: "Second", GIT_COMMITTER_EMAIL: "second@example.com" },
    );
  });

  // t7501 "--allow-empty-message" with -s: a message of a sign-off alone is empty
  it("-s with an empty message: refused unless --allow-empty-message", async () => {
    const t = twins();
    await expectCommit(t, ["-s", "-m", ""], (c) => c.setSignoff(true).setMessage(""));
    await expectCommit(t, ["-s", "--allow-empty-message", "-m", ""], (c) =>
      c.setSignoff(true).setAllowEmptyMessage(true).setMessage(""),
    );
  });

  // t7513 "commit --trailer with -c and ..."; t7502 "commit --trailer"
  it("--trailer: added as interpret-trailers --no-divider adds them", async () => {
    const t = twins();
    await expectCommit(
      t,
      [
        "-m",
        "subject\n\nbody",
        "--trailer",
        "Reviewed-by: R <r@example.com>",
        "--trailer",
        "Helped-by=H",
      ],
      (c) =>
        c
          .setMessage("subject\n\nbody")
          .addTrailer("Reviewed-by: R <r@example.com>")
          .addTrailer("Helped-by=H"),
    );
    // -s first, then the trailers; a `---` line does not end the message
    const t2 = twins();
    const m = "subject\n\n---\nnot a divider\n\nCc: C <c@example.com>";
    await expectCommit(t2, ["-s", "-m", m, "--trailer", "Acked-by: A"], (c) =>
      c.setSignoff(true).setMessage(m).addTrailer("Acked-by: A"),
    );
    // the same trailer twice next to each other: addIfDifferentNeighbor
    const t3 = twins();
    await expectCommit(
      t3,
      ["-m", "x\n\nAcked-by: A", "--trailer", "Acked-by: A", "--trailer", "Acked-by: B"],
      (c) => c.setMessage("x\n\nAcked-by: A").addTrailer("Acked-by: A").addTrailer("Acked-by: B"),
    );
  });

  // t7513 "commit --trailer with trailer.<token>.key, .ifexists, trailer.where"
  it("--trailer: trailer.* configuration applies", async () => {
    const config = {
      "trailer.sign.key": "Signed-off-by: ",
      "trailer.sign.ifexists": "replace",
      "trailer.fix.key": "Fixes",
      "trailer.fix.where": "start",
      "trailer.separators": ":#",
    };
    const t = twins(config);
    const m = "subject\n\nSigned-off-by: Old <old@example.com>\nCc: X";
    await expectCommit(
      t,
      [
        "-m",
        m,
        "--trailer",
        "sign=New <new@example.com>",
        "--trailer",
        "fix#123",
        "--trailer",
        "Cc# Y",
      ],
      (c) =>
        c
          .setMessage(m)
          .addTrailer("sign=New <new@example.com>")
          .addTrailer("fix#123")
          .addTrailer("Cc# Y"),
    );
    const t2 = twins({ "trailer.ifexists": "addIfDifferent", "trailer.where": "start" });
    const m2 = "subject\n\nAcked-by: A\nCc: X";
    await expectCommit(
      t2,
      ["-m", m2, "--trailer", "Acked-by: A", "--trailer", "Acked-by: B"],
      (c) => c.setMessage(m2).addTrailer("Acked-by: A").addTrailer("Acked-by: B"),
    );
  });

  // t7513 "--trailer with an empty argument" / "missing key before separator": 2.5x refuses
  // them (validate_trailer_args), 2.43's child interpret-trailers took them
  it("--trailer: an empty argument and a missing key", async () => {
    for (const arg of ["", ":value"]) {
      const t = twins();
      const { failed } = await expectCommit(t, ["-m", "x", "--trailer", arg], (c) =>
        c.setMessage("x").addTrailer(arg),
      );
      expect(failed).toBe(nativeIs25x);
    }
  });

  // t7502 "--trailer with an editor": the trailers go into COMMIT_EDITMSG before the
  // comments of the template
  it("--trailer and -s with an editor: before the template's comments", async () => {
    const t = twins();
    await expectCommit(
      t,
      ["-e", "-s", "-m", "subject", "--trailer", "Cc: C <c@example.com>"],
      (c) =>
        c
          .setEditor(async () => undefined)
          .setEdit(true)
          .setSignoff(true)
          .setMessage("subject")
          .addTrailer("Cc: C <c@example.com>"),
      { GIT_EDITOR: "true" },
    );
  });

  // t7509 "--author 'Name <email>'", t7501 "--author with a pattern" / "...no match"
  it("--author: `Name <email>`, or the newest matching author of --all (mailmapped)", async () => {
    const cases: [string, string | undefined][] = [
      ["Xavier Yalgo <xy@example.com>", "Xavier Yalgo <xy@example.com>"],
      ["  ;Spaced  <  sp@example.com >", undefined],
      ["frotz", "Frotz Nitfol <nitfol@example.com>"],
      ["AUTHOR@", "A U Thor <author@example.com>"],
      ["^a u", "A U Thor <author@example.com>"],
      ["n.*ame", "New Name <new@example.com>"],
      ["new name", "New Name <new@example.com>"],
      ["Old Name", undefined],
      ["nobody", undefined],
      ["a b>", undefined],
      ["a <b", undefined],
    ];
    for (const [arg, expected] of cases) {
      const t = twins();
      const { failed } = await expectCommit(t, [`--author=${arg}`, "-m", "x"], (c) =>
        c.setAuthor(arg).setMessage("x"),
      );
      if (expected) {
        expect(failed).toBe(false);
        expect(gitOk(t.native, envOf(), "log", "-1", "--format=%an <%ae>").trim()).toBe(expected);
      }
    }
  });

  // t7509 "--amend option with --author", "--reset-author and --author" refused
  it("--author with --amend keeps HEAD's date; with --reset-author it is refused", async () => {
    const t = twins();
    await expectCommit(t, ["--amend", "--no-edit", "--author=frotz"], (c) =>
      c.setAmend(true).setEdit(false).setAuthor("frotz"),
    );
    await expectCommit(t, ["--amend", "--reset-author", "--author=frotz"], (c) =>
      c.setAmend(true).setResetAuthor(true).setAuthor("frotz"),
    );
    await expectCommit(t, ["--amend", "--reset-author", "--author=X <x@y>"], (c) =>
      c.setAmend(true).setResetAuthor(true).setAuthor("X <x@y>"),
    );
  });

  // t7509 "--date", t7501 "commit --date", t0006 forms
  it("--date: parse_date's forms, approxidate's, and refusals", async () => {
    const forms = [
      "@1234567890 +0300",
      "2005-04-07 22:13:13 +0200",
      "2005-04-07T22:13:13Z",
      "Thu, 07 Apr 2005 22:13:13 +0200",
      "Thu Apr 7 22:13:13 2005",
      "2005-04-07 noon",
      "April 7 2005 5pm",
      "3.days.ago",
      "yesterday",
      "garbage",
    ];
    for (const form of forms) {
      const t = twins();
      await expectCommit(
        t,
        [`--date=${form}`, "-m", "x"],
        (c) => c.setDate(form, { now: 1700000000 }).setMessage("x"),
        { GIT_TEST_DATE_NOW: "1700000000" },
      );
    }
    // --amend: the date given replaces HEAD's
    const t = twins();
    await expectCommit(t, ["--amend", "--date=@1111111111 -0130", "--no-edit"], (c) =>
      c.setAmend(true).setDate("@1111111111 -0130").setEdit(false),
    );
  });

  // t7509 "-C option copies authorship and message", "-C option with --reset-author",
  // "--reset-author makes the commit ours even with --amend option",
  // "--reset-author should be rejected without -c/-C/--amend"
  it("-C and --reset-author", async () => {
    const t = twins();
    await expectCommit(t, ["-C", "HEAD~1"], (c) => c.setReuseMessage("HEAD~1"));
    expect(gitOk(t.native, envOf(), "log", "-1", "--format=%an %ad").trim()).toBe(
      "Frotz Nitfol Sun Sep 13 13:26:40 2020 +0100",
    );
    const t2 = twins();
    await expectCommit(t2, ["-C", "side", "--reset-author"], (c) =>
      c.setReuseMessage("side").setResetAuthor(true),
    );
    const t3 = twins();
    await expectCommit(t3, ["-C", "HEAD", "--author=Xavier <x@example.com>"], (c) =>
      c.setReuseMessage("HEAD").setAuthor("Xavier <x@example.com>"),
    );
    const t4 = twins();
    await expectCommit(t4, ["-C", "HEAD~1", "--date=@1234567890 +0000", "-s"], (c) =>
      c.setReuseMessage("HEAD~1").setDate("@1234567890 +0000").setSignoff(true),
    );
    const t5 = twins();
    await expectCommit(t5, ["--amend", "--reset-author", "-C", "side"], (c) =>
      c.setAmend(true).setResetAuthor(true).setReuseMessage("side"),
    );
    const t6 = twins();
    await expectCommit(t6, ["--reset-author", "-m", "x"], (c) =>
      c.setResetAuthor(true).setMessage("x"),
    );
    await expectCommit(t6, ["-C", "nope"], (c) => c.setReuseMessage("nope"));
    await expectCommit(t6, ["-C", "HEAD", "-m", "x"], (c) =>
      c.setReuseMessage("HEAD").setMessage("x"),
    );
  });

  // t7501 "--allow-empty", "--allow-empty-message", "nothing to commit"
  it("--allow-empty and --allow-empty-message", async () => {
    const t = twins();
    gitOk(t.native, envOf(), "commit", "-q", "-m", "staged");
    gitOk(t.ours, envOf(), "commit", "-q", "-m", "staged");
    await expectCommit(t, ["-m", "nothing"], (c) => c.setMessage("nothing"));
    await expectCommit(t, ["--allow-empty", "-m", "empty"], (c) =>
      c.setAllowEmpty(true).setMessage("empty"),
    );
    await expectCommit(t, ["--allow-empty", "-m", ""], (c) => c.setAllowEmpty(true).setMessage(""));
    await expectCommit(t, ["--allow-empty", "--allow-empty-message", "-m", ""], (c) =>
      c.setAllowEmpty(true).setAllowEmptyMessage(true).setMessage(""),
    );
    put(t.native, "a.txt", "changed\n");
    put(t.ours, "a.txt", "changed\n");
    gitOk(t.native, envOf(), "add", ".");
    gitOk(t.ours, envOf(), "add", ".");
    await expectCommit(t, ["--allow-empty-message", "-m", "  \n\n"], (c) =>
      c.setAllowEmptyMessage(true).setMessage("  \n\n"),
    );
  });
});
