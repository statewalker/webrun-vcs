/**
 * `git am`'s options against native git, scenario by scenario from git's t/ scripts (each
 * test names its script and titles: am, am-options, am-keep-cr-dos, am-quoted-cr) and
 * `git mailsplit` (mailinfo's script): twins copied from one repository built by native git under fixed dates,
 * one driven by native `git am`, the other by our AmCommand, compared after each step by
 * exit status, stdout, stderr, HEAD and its commit's bytes, ORIG_HEAD, the reflog, the index,
 * the worktree and `.git/rebase-apply/`; mailsplit by its output files.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AmCommand, Git, type MailsplitOptions, mailsplitFiles } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

type Env = Record<string, string | undefined>;
let root = "";
let home = "";
let counter = 0;
let modern = true;

const IDENT: Env = {
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_AUTHOR_DATE: "1112911993 -0700",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_COMMITTER_DATE: "1112912053 -0700",
};

function envOf(over: Env = {}): Record<string, string> {
  const env: Env = { ...nativeGitEnv(home), ...IDENT, ...over };
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

function git(cwd: string, args: string[], env: Env = {}, input: string | Buffer = "") {
  const r = spawnSync("git", args, {
    cwd,
    env: envOf(env),
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? Buffer.alloc(0)).toString("utf8"),
    stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

function gitOk(cwd: string, args: string[], env: Env = {}): string {
  const r = git(cwd, args, env);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const put = (dir: string, path: string, content: string | Buffer) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

const crlf = (s: string) => s.replace(/\n/g, "\r\n");

async function open(repo: string, env: Env = {}): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: envOf(env) });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** A new repository built by `build` (native git), with an inputs directory beside it. */
function source(build: (repo: string) => void): string {
  const repo = join(root, `src${counter++}`);
  mkdirSync(repo, { recursive: true });
  gitOk(repo, ["init", "-q", "-b", "main"]);
  build(repo);
  return repo;
}

function commitAll(repo: string, msg: string, env: Env = {}) {
  gitOk(repo, ["add", "-A"], env);
  gitOk(repo, ["commit", "-q", "--allow-empty", "-m", msg], env);
}

/** A file of the inputs directory (where the mailboxes live), its path. */
function input(name: string, content: string | Buffer): string {
  const path = join(root, "inputs", `${counter++}-${name}`);
  put(path, "", content);
  return path;
}

interface Pair {
  native: string;
  ours: string;
}

/** Two copies of `src`, each prepared by the same native commands. */
function twins(src: string, prepare: string[][] = []): Pair {
  const n = counter++;
  const make = (side: string) => {
    const repo = join(root, `t${n}-${side}`);
    cpSync(src, repo, { recursive: true });
    for (const args of prepare) gitOk(repo, args);
    return repo;
  };
  return { native: make("native"), ours: make("ours") };
}

/** Masks the timestamps of `who` lines (git's clock and ours read "now"). */
function maskNow(text: string, who: string[]): string {
  let out = text;
  for (const w of who)
    out = out.replace(new RegExp(`^(${w} .*> )\\d+( [+-]\\d{4})$`, "gm"), "$1<now>$2");
  return out;
}

function snapshot(repo: string, maskDates: string[] = []): string {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const d of readdirSync(join(repo, rel), { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (!rel && d.name === ".git") continue;
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(p);
      else {
        const mode = statSync(join(repo, p)).mode & 0o111 ? "x" : "-";
        out.push(`${p} ${mode} ${readFileSync(join(repo, p)).toString("base64")}`);
      }
    }
  };
  walk("");
  const state = join(repo, ".git", "rebase-apply");
  if (existsSync(state)) {
    for (const f of readdirSync(state).sort())
      if (f !== "patch-merge-index")
        out.push(`STATE ${f}: ${readFileSync(join(state, f)).toString("latin1")}`);
  }
  const head = git(repo, ["rev-parse", "-q", "--verify", "HEAD"]).stdout;
  if (head) {
    out.push(`COMMIT ${maskNow(gitOk(repo, ["cat-file", "commit", "HEAD"]), maskDates)}`);
    const parent = git(repo, ["rev-parse", "-q", "--verify", "HEAD^"]).stdout;
    if (parent)
      out.push(`PARENT ${maskNow(gitOk(repo, ["cat-file", "commit", "HEAD^"]), maskDates)}`);
  }
  if (!maskDates.length) {
    out.push(`HEAD ${head}`);
    out.push(`ORIG_HEAD ${git(repo, ["rev-parse", "-q", "--verify", "ORIG_HEAD"]).stdout}`);
    out.push(`REFLOG ${git(repo, ["reflog", "--format=%H %gs"]).stdout}`);
  }
  out.push(`SYMREF ${git(repo, ["symbolic-ref", "-q", "HEAD"]).stdout}`);
  out.push(`INDEX ${gitOk(repo, ["ls-files", "-s"])}`);
  out.push(`STATUS ${gitOk(repo, ["status", "--porcelain"])}`);
  return out.join("\n");
}

interface StepOptions {
  env?: Env;
  stdin?: string | Buffer;
  maskDates?: string[];
}

/** One `git am` run in each twin, then everything compared. */
async function step(
  pair: Pair,
  args: string[],
  configure: (c: AmCommand) => AmCommand,
  label: string,
  options: StepOptions = {},
) {
  const native = git(pair.native, ["am", ...args], options.env, options.stdin ?? "");
  const g = await open(pair.ours, options.env);
  const r = await configure(g.am().setLegacyMessages(!modern)).call();
  g.close();
  expect({ label, status: r.exitCode, stdout: r.output, stderr: r.errors }).toEqual({
    label,
    status: native.status,
    stdout: native.stdout,
    stderr: native.stderr,
  });
  expect(snapshot(pair.ours, options.maskDates)).toBe(snapshot(pair.native, options.maskDates));
  return native;
}

const file = (path: string) => readFileSync(path);

// ---------------------------------------------------------------------------------------
// The am script's history: `first`, `second` (with a long message), `third`
// ---------------------------------------------------------------------------------------

const MSG = `second

Lorem ipsum dolor sit amet, consectetuer sadipscing elitr, sed diam nonumy
eirmod tempor invidunt ut labore et dolore magna aliquyam erat.

 \tDuis autem vel eum iriure dolor in hendrerit in vulputate velit
 \tesse molestie consequat.

  git
  ---
  +++

Reported-by: A N Other <a.n.other@example.com>
`;

function t4150Source(): string {
  return source((repo) => {
    put(repo, "file", "hello\n");
    commitAll(repo, "first");
    gitOk(repo, ["tag", "first"]);
    put(repo, "file", "hello\nworld\n");
    commitAll(repo, MSG.trimEnd());
    gitOk(repo, ["tag", "second"]);
    // expected-for-scissors / expected-for-no-scissors
    put(repo, "file", "file\n");
    commitAll(
      repo,
      "This line should not be included in the commit message with --scissors enabled.\n\n - - >8 - - remove everything above this line - - >8 - -\n\nSubject: Test that git-am --scissors cuts at the scissors line\n\nThis line should be included in the commit message.",
    );
    gitOk(repo, ["tag", "expected-for-no-scissors"]);
    gitOk(repo, ["reset", "-q", "--hard", "second"]);
    put(repo, "file", `${MSG.split("\n").slice(2).join("\n")}`);
    commitAll(repo, "third");
    gitOk(repo, ["tag", "third"]);
  });
}

describeGit("git am options as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "am-options-native-"));
    home = join(root, "home");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(root, "inputs"), { recursive: true });
    modern = gitAtLeast(gitOk(root, ["--version"]), 2, 46);
  });
  afterAll(async () => {
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  it('t4150-am.sh: "am --scissors cuts the message at the scissors line", "am --no-scissors overrides mailinfo.scissors"', async () => {
    const src = t4150Source();
    const mbox = input(
      "scissors.eml",
      gitOk(src, [
        "format-patch",
        "--stdout",
        "expected-for-no-scissors^..expected-for-no-scissors",
      ]),
    );
    const bytes = file(mbox);
    let pair = twins(src, [["checkout", "-q", "second"]]);
    await step(pair, ["--scissors", mbox], (c) => c.addMbox(bytes, mbox).setScissors(true), "-c");
    pair = twins(src, [
      ["checkout", "-q", "second"],
      ["config", "mailinfo.scissors", "true"],
    ]);
    await step(
      pair,
      ["--no-scissors", mbox],
      (c) => c.addMbox(bytes, mbox).setScissors(false),
      "--no-scissors over mailinfo.scissors",
    );
    // mailinfo.scissors alone cuts
    pair = twins(src, [
      ["checkout", "-q", "second"],
      ["config", "mailinfo.scissors", "true"],
    ]);
    await step(pair, [mbox], (c) => c.addMbox(bytes, mbox), "mailinfo.scissors");
    // a bad mailinfo.scissors dies after the split
    pair = twins(src, [
      ["checkout", "-q", "second"],
      ["config", "mailinfo.scissors", "maybe"],
    ]);
    await step(pair, [mbox], (c) => c.addMbox(bytes, mbox), "bad mailinfo.scissors");
  }, 120_000);

  it('t4150-am.sh: "am --signoff adds Signed-off-by: line", "am --signoff does not add Signed-off-by: line if already there", "am --signoff adds Signed-off-by: if another author is preset", "am --signoff duplicates Signed-off-by: if it is not the last one"', async () => {
    const src = t4150Source();
    const patch2 = gitOk(src, ["format-patch", "--stdout", "first..third"]);
    const pair = twins(src, [["checkout", "-q", "-b", "topic_2", "first"]]);
    await step(pair, ["--signoff"], (c) => c.addMbox(patch2).setSignoff(true), "-s", {
      stdin: patch2,
    });
    // already there
    const patch3 = gitOk(pair.native, ["format-patch", "--stdout", "first"]);
    for (const repo of [pair.native, pair.ours]) gitOk(repo, ["reset", "-q", "--hard", "first"]);
    await step(pair, ["--signoff"], (c) => c.addMbox(patch3).setSignoff(true), "-s again", {
      stdin: patch3,
    });
    // another committer
    const other: Env = {
      GIT_COMMITTER_NAME: "A N Other",
      GIT_COMMITTER_EMAIL: "a.n.other@example.com",
    };
    for (const repo of [pair.native, pair.ours]) gitOk(repo, ["reset", "-q", "--hard", "first"]);
    await step(pair, ["--signoff"], (c) => c.addMbox(patch3).setSignoff(true), "-s other", {
      stdin: patch3,
      env: other,
    });
    // not the last one
    const patch4 = gitOk(pair.native, ["format-patch", "--stdout", "first"]);
    for (const repo of [pair.native, pair.ours]) gitOk(repo, ["reset", "-q", "--hard", "first"]);
    await step(pair, ["--signoff"], (c) => c.addMbox(patch4).setSignoff(true), "-s dup", {
      stdin: patch4,
    });
  }, 120_000);

  it('t4150-am.sh: "am without --keep removes Re: and [PATCH] stuff", "am --keep really keeps the subject", "am --keep-non-patch really keeps the non-patch part"', async () => {
    const src = t4150Source();
    const patch4 = gitOk(src, ["format-patch", "--stdout", "third^..third"]).replace(
      /^Subject: \[PATCH/m,
      "Subject: Re: Re: Re: [PATCH 1/5 v2] [foo",
    );
    const mbox = input("patch4", patch4);
    const bytes = file(mbox);
    let pair = twins(src, [["checkout", "-q", "second"]]);
    await step(pair, [], (c) => c.addMbox(bytes), "no -k", { stdin: bytes });
    pair = twins(src, [["checkout", "-q", "second"]]);
    await step(pair, ["--keep", mbox], (c) => c.addMbox(bytes, mbox).setKeep(true), "-k");
    pair = twins(src, [["checkout", "-q", "second"]]);
    await step(
      pair,
      ["--keep-non-patch", mbox],
      (c) => c.addMbox(bytes, mbox).setKeep("non-patch"),
      "--keep-non-patch",
    );
  }, 120_000);

  it('t4150-am.sh: "am -3 -p0 can read --no-prefix patch", "am with config am.threeWay overridden by --no-3way"', async () => {
    const src = t4150Source();
    gitOk(src, ["checkout", "-q", "-b", "lorem", "third"]);
    const lorem = `${MSG.split("\n").slice(10).join("\n")}${MSG.split("\n").slice(2, 10).join("\n")}\n`;
    put(src, "file", lorem);
    commitAll(src, "moved stuff");
    put(src, "another", "goodbye\n");
    commitAll(src, "added another file");
    const zero = input(
      "lorem-zero.patch",
      gitOk(src, ["format-patch", "--no-prefix", "--stdout", "third"]),
    );
    const move = input("lorem-move.patch", gitOk(src, ["format-patch", "--stdout", "third"]));
    gitOk(src, ["checkout", "-q", "-b", "base3way", "third"]);
    put(
      src,
      "file",
      `${MSG.split("\n").slice(2).join("\n")}${MSG.split("\n").slice(0, 9).join("\n")}\n`,
    );
    commitAll(src, "copied stuff");
    let pair = twins(src);
    await step(
      pair,
      ["-3", "-p0", zero],
      (c) => c.addMbox(file(zero), zero).setThreeWay(true).setApplyOptions({ strip: 0 }),
      "-3 -p0",
    );
    pair = twins(src, [["config", "am.threeWay", "1"]]);
    await step(
      pair,
      ["--no-3way", move],
      (c) => c.addMbox(file(move), move).setThreeWay(false),
      "--no-3way",
    );
    pair = twins(src, [["config", "am.threeWay", "1"]]);
    await step(pair, [move], (c) => c.addMbox(file(move), move), "am.threeWay");
  }, 120_000);

  it('t4150-am.sh: "am --committer-date-is-author-date", "am without --committer-date-is-author-date", "am --ignore-date"', async () => {
    const src = t4150Source();
    const patch1 = input("patch1", gitOk(src, ["format-patch", "--stdout", "first..second"]));
    let pair = twins(src, [["checkout", "-q", "first"]]);
    await step(
      pair,
      ["--committer-date-is-author-date", patch1],
      (c) => c.addMbox(file(patch1), patch1).setCommitterDateIsAuthorDate(true),
      "--committer-date-is-author-date",
    );
    pair = twins(src, [["checkout", "-q", "first"]]);
    await step(pair, [patch1], (c) => c.addMbox(file(patch1), patch1), "without");
    pair = twins(src, [["checkout", "-q", "first"]]);
    await step(
      pair,
      ["--ignore-date", patch1],
      (c) => c.addMbox(file(patch1), patch1).setIgnoreDate(true),
      "--ignore-date",
      { maskDates: ["author"] },
    );
    pair = twins(src, [["checkout", "-q", "first"]]);
    await step(
      pair,
      ["--ignore-date", "--committer-date-is-author-date", patch1],
      (c) => c.addMbox(file(patch1), patch1).setIgnoreDate(true).setCommitterDateIsAuthorDate(true),
      "--ignore-date --committer-date-is-author-date",
      { maskDates: ["author", "committer"] },
    );
  }, 120_000);

  it('t4150-am.sh: "am --message-id really adds the message id", "am.messageid really adds the message id", "am --message-id -s signs off after the message id"', async () => {
    const src = t4150Source();
    const eml = input(
      "patch1.eml",
      `Message-ID: <1226501681-24923-1-git-send-email-bda@mnsspb.ru>\nX-Fake-Field: Line One\nX-Fake-Field: Line Two\n${gitOk(
        src,
        ["format-patch", "--stdout", "first..second"],
      )
        .split("\n")
        .slice(1)
        .join("\n")}`,
    );
    const bytes = file(eml);
    let pair = twins(src, [["checkout", "-q", "first"]]);
    await step(pair, ["--message-id", eml], (c) => c.addMbox(bytes, eml).setMessageId(true), "-m");
    pair = twins(src, [
      ["checkout", "-q", "first"],
      ["config", "am.messageid", "true"],
    ]);
    await step(pair, [eml], (c) => c.addMbox(bytes, eml), "am.messageid");
    pair = twins(src, [["checkout", "-q", "first"]]);
    await step(
      pair,
      ["-s", "--message-id", eml],
      (c) => c.addMbox(bytes, eml).setSignoff(true).setMessageId(true),
      "-s -m",
    );
    // am.messageid overridden by --no-message-id
    pair = twins(src, [
      ["checkout", "-q", "first"],
      ["config", "am.messageid", "true"],
    ]);
    await step(
      pair,
      ["--no-message-id", eml],
      (c) => c.addMbox(bytes, eml).setMessageId(false),
      "--no-message-id",
    );
  }, 120_000);

  it('t4150-am.sh: "am applies patch e-mail not in a mbox with CRLF"', async () => {
    const src = t4150Source();
    const eml = input(
      "patch1-crlf.eml",
      crlf(
        `X-Fake-Field: Line One\n${gitOk(src, ["format-patch", "--stdout", "first..second"])
          .split("\n")
          .slice(1)
          .join("\n")}`,
      ),
    );
    const pair = twins(src, [["checkout", "-q", "first"]]);
    await step(pair, [eml], (c) => c.addMbox(file(eml), eml), "crlf");
  }, 60_000);

  // t4150-am.sh: `a message without a patch is an error where an explicit "--empty=stop" is given`
  // t4150-am.sh: `a message without a patch will be skipped when "--empty=drop" is given`
  // t4150-am.sh: "record as an empty commit when meeting e-mail message that lacks a patch"
  it("--empty=stop|drop|keep", async () => {
    const src = t4150Source();
    gitOk(src, ["checkout", "-q", "-b", "empty-commit", "third"]);
    gitOk(src, ["commit", "-q", "--allow-empty", "-m", "empty commit"]);
    const empty = input(
      "empty-commit.patch",
      gitOk(src, ["format-patch", "--always", "--stdout", "empty-commit^"]),
    );
    const bytes = file(empty);
    let pair = twins(src, [["checkout", "-q", "empty-commit^"]]);
    await step(
      pair,
      ["--empty=stop", empty],
      (c) => c.addMbox(bytes, empty).setEmpty("stop"),
      "--empty=stop",
    );
    await step(pair, ["--skip"], (c) => c.setResume("skip"), "--skip");
    pair = twins(src, [["checkout", "-q", "empty-commit^"]]);
    await step(
      pair,
      ["--empty=drop", empty],
      (c) => c.addMbox(bytes, empty).setEmpty("drop"),
      "--empty=drop",
    );
    pair = twins(src, [["checkout", "-q", "empty-commit^"]]);
    await step(
      pair,
      ["--empty=keep", empty],
      (c) => c.addMbox(bytes, empty).setEmpty("keep"),
      "--empty=keep",
    );
    // an empty patch amid others, kept
    const both = input(
      "two.patch",
      gitOk(src, ["format-patch", "--always", "--stdout", "second..empty-commit"]),
    );
    pair = twins(src, [["checkout", "-q", "second"]]);
    await step(
      pair,
      ["--empty=keep", both],
      (c) => c.addMbox(file(both), both).setEmpty("keep"),
      "--empty=keep in a series",
    );
  }, 120_000);

  it("-u / -n: the message recoded or kept as its bytes", async () => {
    const src = t4150Source();
    const base = gitOk(src, ["format-patch", "--stdout", "first..second"]);
    const latin = Buffer.concat([
      Buffer.from(
        base
          .replace(/^Subject: \[PATCH\] second$/m, "Subject: Café second")
          .replace(/^Date:/m, "Content-Type: text/plain; charset=ISO-8859-1\nDate:")
          .split("\n\n")[0] as string,
        "latin1",
      ),
      Buffer.from("\n\nCaf\xe9 au lait.\n", "latin1"),
      Buffer.from(base.slice(base.indexOf("\n---\n")), "utf8"),
    ]);
    const mbox = input("latin.mbox", latin);
    let pair = twins(src, [["checkout", "-q", "first"]]);
    await step(pair, ["-u", mbox], (c) => c.addMbox(file(mbox), mbox).setUtf8(true), "-u");
    pair = twins(src, [["checkout", "-q", "first"]]);
    await step(pair, ["-n", mbox], (c) => c.addMbox(file(mbox), mbox).setUtf8(false), "-n");
  }, 60_000);

  // -------------------------------------------------------------------------------------
  // am-options
  // -------------------------------------------------------------------------------------

  const amOptionsSource = () =>
    source((repo) => {
      put(repo, "file-1", "1\n2\n3\n4\n5\n6\n7\n");
      put(repo, "file-2", "1\n2\n3\n4\n5\n6\n7\n");
      commitAll(repo, "initial");
      gitOk(repo, ["tag", "initial"]);
    });

  const mail = (subject: string, body: string, diff: string) =>
    `From: A U Thor <au.thor@example.com>\nDate: Thu Dec 4 16:00:00 2008 -0800\nSubject: ${subject}\n\n${body}\n\n${diff}`;

  const hunk3 = (prefix: string, first: string, pre: string) =>
    `diff --git i/${prefix}file-1 w/${prefix}file-1\nindex 06e567b..10f8342 100644\n--- i/${prefix}file-1\n+++ w/${prefix}file-1\n@@ -1,6 +1,6 @@\n ${first}\n 2\n-${pre}\n+Three \n 4\n 5\n 6\n`;
  const hunk6 = (prefix: string, first: string, six = "Six") =>
    `diff --git i/${prefix}file-2 w/${prefix}file-2\nindex 06e567b..b6f3a16 100644\n--- i/${prefix}file-2\n+++ w/${prefix}file-2\n@@ -1,7 +1,7 @@\n ${first}\n 2\n-3\n+Three\n 4\n 5\n-6\n+${six}\n 7\n`;

  /** An interrupted am with `args`, then --skip, as the am-options script runs each. */
  async function interrupted(
    one: string,
    two: string,
    args: string[],
    apply: Parameters<AmCommand["setApplyOptions"]>[0],
    label: string,
  ) {
    const src = amOptionsSource();
    const a = input("am-test-1", one);
    const b = input("am-test-2", two);
    const pair = twins(src);
    await step(
      pair,
      [...args, a, b],
      (c) => c.addMbox(file(a), a).addMbox(file(b), b).setApplyOptions(apply),
      label,
    );
    await step(pair, ["--skip"], (c) => c.setResume("skip"), `${label} --skip`);
  }

  it('t4252-am-options.sh: "interrupted am --whitespace=fix"', async () => {
    await interrupted(
      mail("Three", "Application of this should be rejected.", hunk3("", "One", "3")),
      mail(
        "Six",
        "Applying this patch with --whitespace=fix should lose \nthe trailing whitespace.",
        hunk6("", "1", "Six "),
      ),
      ["--whitespace=fix"],
      { whitespace: "fix" },
      "--whitespace=fix",
    );
  }, 60_000);

  it('t4252-am-options.sh: "interrupted am -C1"', async () => {
    await interrupted(
      mail("Three", "Rejected even with -C1.", hunk3("", "1", "Tres")),
      mail("Six", "Applies with -C1.", hunk6("", "One")),
      ["-C1"],
      { context: 1 },
      "-C1",
    );
  }, 60_000);

  it('t4252-am-options.sh: "interrupted am -p2"', async () => {
    await interrupted(
      mail("Three", "Rejected even with -p2.", hunk3("junk/", "1", "Tres")),
      mail("Six", "Applies with -p2.", hunk6("junk/", "1")),
      ["-p2"],
      { strip: 2 },
      "-p2",
    );
  }, 60_000);

  it('t4252-am-options.sh: "interrupted am -C1 -p2"', async () => {
    await interrupted(
      mail("Three", "Rejected even with -C1 -p2.", hunk3("junk/", "1", "Tres")),
      mail("Six", "Applies with -C1 -p2.", hunk6("junk/", "One")),
      ["-C1", "-p2"],
      { context: 1, strip: 2 },
      "-C1 -p2",
    );
  }, 60_000);

  // t4252-am-options.sh: `interrupted am --directory="frotz nitfol"`, "apply to a funny path"
  it("--directory, a funny path", async () => {
    const newFile =
      "diff --git i/file-5 w/file-5\nnew file mode 100644\nindex 000000..1d6ed9f\n--- /dev/null\n+++ w/file-5\n@@ -0,0 +1,3 @@\n+One\n+two\n+three\n";
    await interrupted(
      mail("Six", "Should fail.", hunk6("junk/", "One")),
      mail("Six", "Should succeed.", newFile),
      ["--directory=frotz nitfol"],
      { directory: "frotz nitfol" },
      "--directory",
    );
    const src = amOptionsSource();
    const b = input("am-test-5-2", mail("Six", "Should succeed.", newFile));
    const pair = twins(src);
    await step(
      pair,
      ["--directory=with'sq", b],
      (c) => c.addMbox(file(b), b).setApplyOptions({ directory: "with'sq" }),
      "funny path",
    );
  }, 60_000);

  it('t4252-am-options.sh: "am --reject"', async () => {
    const src = amOptionsSource();
    const a = input(
      "am-test-6-1",
      mail(
        "Huh",
        "Should fail and leave rejects",
        "diff --git i/file-2 w/file-2\nindex 06e567b..b6f3a16 100644\n--- i/file-2\n+++ w/file-2\n@@ -1,3 +1,3 @@\n-0\n+One\n 2\n 3\n@@ -4,4 +4,4 @@\n 4\n 5\n-6\n+Six\n 7\n",
      ),
    );
    const pair = twins(src);
    await step(
      pair,
      ["--reject", a],
      (c) => c.addMbox(file(a), a).setApplyOptions({ reject: true }),
      "--reject",
    );
    // the options stay for --continue
    for (const repo of [pair.native, pair.ours]) {
      rmSync(join(repo, "file-2.rej"));
      gitOk(repo, ["add", "file-2"]);
    }
    await step(pair, ["--continue"], (c) => c.setResume("continue"), "--continue");
  }, 60_000);

  it("--exclude, --include, --ignore-whitespace, --ignore-space-change and -3 with the apply options", async () => {
    const src = amOptionsSource();
    const two = mail(
      "Two files",
      "Both files.",
      `${hunk3("", "1", "3").replace("+Three \n", "+Three\n")}${hunk6("", "1")}`,
    );
    const a = input("two-files", two);
    let pair = twins(src);
    await step(
      pair,
      ["--exclude=file-1", a],
      (c) => c.addMbox(file(a), a).setApplyOptions({ exclude: ["file-1"] }),
      "--exclude",
    );
    pair = twins(src);
    await step(
      pair,
      ["--include=file-1", a],
      (c) => c.addMbox(file(a), a).setApplyOptions({ include: ["file-1"] }),
      "--include",
    );
    // whitespace changed in the worktree's history: --ignore-whitespace matches it
    const ws = source((repo) => {
      put(repo, "file-1", "1\n2  \n3\n4\n5\n6\n7\n");
      put(repo, "file-2", "1\n2\n3\n4\n5\n6\n7\n");
      commitAll(repo, "initial");
    });
    pair = twins(ws);
    await step(
      pair,
      ["--ignore-whitespace", a],
      (c) => c.addMbox(file(a), a).setApplyOptions({ ignoreWhitespace: true }),
      "--ignore-whitespace",
    );
    pair = twins(ws);
    await step(
      pair,
      ["--ignore-space-change", a],
      (c) => c.addMbox(file(a), a).setApplyOptions({ ignoreSpaceChange: true }),
      "--ignore-space-change",
    );
    // -3 with --exclude: the fake ancestor and its apply leave the excluded path out too
    const hist = source((repo) => {
      put(repo, "file-1", "1\n2\n3\n4\n5\n6\n7\n");
      put(repo, "file-2", "1\n2\n3\n4\n5\n6\n7\n");
      commitAll(repo, "initial");
      gitOk(repo, ["tag", "initial"]);
      put(repo, "file-1", "1\n2\nThree\n4\n5\n6\n7\n");
      put(repo, "file-2", "1\n2\nThree\n4\n5\n6\nSeven\n");
      commitAll(repo, "change both");
      gitOk(repo, ["tag", "both"]);
      gitOk(repo, ["reset", "-q", "--hard", "initial"]);
      put(repo, "file-2", "0\n1\n2\n3\n4\n5\n6\n7\n");
      put(repo, "file-1", "zero\n1\n2\n3\n4\n5\n6\n7\n");
      commitAll(repo, "prepend");
    });
    const p = input("both", gitOk(hist, ["format-patch", "-k", "--stdout", "initial..both"]));
    pair = twins(hist, [["config", "am.threeWay", "true"]]);
    await step(
      pair,
      ["-3", "-C3", "--exclude=file-1", p],
      (c) =>
        c
          .addMbox(file(p), p)
          .setThreeWay(true)
          .setApplyOptions({ context: 3, exclude: ["file-1"] }),
      "-3 --exclude",
    );
  }, 120_000);

  // -------------------------------------------------------------------------------------
  // am-keep-cr-dos
  // -------------------------------------------------------------------------------------

  const dos = () =>
    source((repo) => {
      put(repo, "file", "line 1\r\n");
      commitAll(repo, "Initial");
      gitOk(repo, ["tag", "initial"]);
      put(repo, "file", "line 1\r\nline 2\r\n");
      commitAll(repo, "Second");
      put(repo, "file", "line 1\r\nline 2\r\nline 3\r\n");
      commitAll(repo, "Third");
    });

  /** format-patch's files of initial..main, with their paths (as `000*.patch`). */
  function patchFiles(src: string): string[] {
    const dir = join(root, "inputs", `fp${counter++}`);
    gitOk(src, ["format-patch", "-q", "-k", "-o", dir, "initial..main"]);
    return readdirSync(dir)
      .sort()
      .map((f) => join(dir, f));
  }

  const addAll = (c: AmCommand, paths: string[]) => {
    for (const p of paths) c.addMbox(file(p), p);
    return c;
  };

  it('t4253-am-keep-cr-dos.sh: "am with dos files without --keep-cr"', async () => {
    const src = dos();
    const paths = patchFiles(src);
    const pair = twins(src, [["checkout", "-q", "-b", "dosfiles", "initial"]]);
    await step(
      pair,
      ["-k", "-3", ...paths],
      (c) => addAll(c, paths).setKeep(true).setThreeWay(true),
      "no --keep-cr",
    );
    await step(pair, ["--abort"], (c) => c.setResume("abort"), "--abort");
  }, 60_000);

  it('t4253-am-keep-cr-dos.sh: "am with dos files with --keep-cr", "am with dos files config am.keepcr"', async () => {
    const src = dos();
    const output = input("output", gitOk(src, ["format-patch", "-k", "--stdout", "initial..main"]));
    let pair = twins(src, [["checkout", "-q", "-b", "dosfiles-keep-cr", "initial"]]);
    await step(
      pair,
      ["--keep-cr", "-k", "-3", output],
      (c) => c.addMbox(file(output), output).setKeepCr(true).setKeep(true).setThreeWay(true),
      "--keep-cr",
    );
    pair = twins(src, [
      ["config", "am.keepcr", "1"],
      ["checkout", "-q", "-b", "dosfiles-conf-keepcr", "initial"],
    ]);
    await step(
      pair,
      ["-k", "-3", output],
      (c) => c.addMbox(file(output), output).setKeep(true).setThreeWay(true),
      "am.keepcr",
    );
  }, 60_000);

  it('t4253-am-keep-cr-dos.sh: "am with dos files config am.keepcr overridden by --no-keep-cr"', async () => {
    const src = dos();
    const paths = patchFiles(src);
    const pair = twins(src, [
      ["config", "am.keepcr", "1"],
      ["checkout", "-q", "-b", "dosfiles-conf-keepcr-override", "initial"],
    ]);
    await step(
      pair,
      ["-k", "-3", "--no-keep-cr", ...paths],
      (c) => addAll(c, paths).setKeep(true).setThreeWay(true).setKeepCr(false),
      "--no-keep-cr",
    );
    await step(pair, ["--abort"], (c) => c.setResume("abort"), "--abort");
  }, 60_000);

  it('t4253-am-keep-cr-dos.sh: "am with dos files with --keep-cr continue"', async () => {
    const src = dos();
    const paths = patchFiles(src);
    const pair = twins(src, [["checkout", "-q", "-b", "dosfiles-keep-cr-continue", "initial"]]);
    for (const repo of [pair.native, pair.ours]) {
      put(repo, "file", "line 1\r\nline 4\r\n");
      gitOk(repo, ["commit", "-q", "-m", "different patch", "file"]);
    }
    await step(
      pair,
      ["--keep-cr", "-k", "-3", ...paths],
      (c) => addAll(c, paths).setKeepCr(true).setKeep(true).setThreeWay(true),
      "stop",
    );
    for (const repo of [pair.native, pair.ours]) {
      put(repo, "file", "line 1\r\nline 2\r\n");
      gitOk(repo, ["add", "file"]);
    }
    await step(
      pair,
      ["-3", "--resolved"],
      (c) => c.setThreeWay(true).setResume("resolved"),
      "--resolved",
    );
  }, 60_000);

  it('t4253-am-keep-cr-dos.sh: "am with unix files config am.keepcr overridden by --no-keep-cr"', async () => {
    const src = dos();
    const paths = patchFiles(src);
    const pair = twins(src, [
      ["config", "am.keepcr", "1"],
      ["checkout", "-q", "-b", "unixfiles-conf-keepcr-override", "initial"],
    ]);
    for (const repo of [pair.native, pair.ours]) {
      put(repo, "file", "line 1\n");
      gitOk(repo, ["commit", "-q", "-m", "line ending to unix", "file"]);
    }
    await step(
      pair,
      ["-k", "-3", "--no-keep-cr", ...paths],
      (c) => addAll(c, paths).setKeep(true).setThreeWay(true).setKeepCr(false),
      "unix --no-keep-cr",
    );
  }, 60_000);

  // -------------------------------------------------------------------------------------
  // am-quoted-cr
  // -------------------------------------------------------------------------------------

  const quotedCrSource = () =>
    source((repo) => {
      put(repo, "text", "one\ntwo\nthree\n");
      commitAll(repo, "one");
      gitOk(repo, ["tag", "one"]);
      put(repo, "text", "one\nowt\nthree\n");
      commitAll(repo, "two");
      gitOk(repo, ["tag", "two"]);
      gitOk(repo, ["reset", "-q", "--hard", "one"]);
    });

  /** A base64 mail whose body lines end in CRLF (the am-quoted-cr script's mbox). */
  function quotedCrMail(src: string): string {
    const patch = gitOk(src, ["diff", "one", "two"]);
    const body = crlf(
      `This is commit message.\n---\n text | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n\n${patch}-- \n2.31.1\n`,
    );
    const b64 = Buffer.from(`${body}\n`)
      .toString("base64")
      .replace(/(.{76})/g, "$1\n");
    return input(
      "quoted-cr.mbox",
      `From: A U Thor <mail@example.com>\nTo: list@example.org\nSubject: [PATCH v2] sample\nDate: Mon,  3 Aug 2020 22:40:55 +0700\nMessage-ID: <msg-id@example.com>\nContent-Type: text/plain; charset="utf-8"\nContent-Transfer-Encoding: base64\n\n${b64}\n`,
    );
  }

  it('t4258-am-quoted-cr.sh: "am warn if quoted-cr is found"', async () => {
    const src = quotedCrSource();
    const mbox = quotedCrMail(src);
    const pair = twins(src);
    await step(pair, [mbox], (c) => c.addMbox(file(mbox), mbox), "warn");
    await step(pair, ["--abort"], (c) => c.setResume("abort"), "--abort");
    await step(
      twins(src),
      ["--quoted-cr=nowarn", mbox],
      (c) => c.addMbox(file(mbox), mbox).setQuotedCr("nowarn"),
      "nowarn",
    );
    await step(
      twins(src),
      ["--quoted-cr=warn", mbox],
      (c) => c.addMbox(file(mbox), mbox).setQuotedCr("warn"),
      "explicit warn",
    );
  }, 60_000);

  it('t4258-am-quoted-cr.sh: "am --quoted-cr=strip"', async () => {
    const src = quotedCrSource();
    const mbox = quotedCrMail(src);
    await step(
      twins(src),
      ["--quoted-cr=strip", mbox],
      (c) => c.addMbox(file(mbox), mbox).setQuotedCr("strip"),
      "strip",
    );
    // the option overrides mailinfo.quotedCr, and stays for the session (--continue)
    const pair = twins(src, [["config", "mailinfo.quotedCr", "strip"]]);
    await step(
      pair,
      ["--quoted-cr=warn", mbox],
      (c) => c.addMbox(file(mbox), mbox).setQuotedCr("warn"),
      "warn over config",
    );
  }, 60_000);

  it('t4258-am-quoted-cr.sh: "am with config mailinfo.quotedCr=strip"', async () => {
    const src = quotedCrSource();
    const mbox = quotedCrMail(src);
    await step(
      twins(src, [["config", "mailinfo.quotedCr", "strip"]]),
      [mbox],
      (c) => c.addMbox(file(mbox), mbox),
      "config strip",
    );
    await step(
      twins(src, [["config", "mailinfo.quotedCr", "bogus"]]),
      [mbox],
      (c) => c.addMbox(file(mbox), mbox),
      "config bogus",
    );
  }, 60_000);

  it("am of a Maildir splits it as git mailsplit", async () => {
    const src = t4150Source();
    const dir = join(root, "inputs", `Maildir${counter++}`);
    gitOk(src, ["format-patch", "-q", "-o", join(dir, "cur"), "first..third"]);
    const curFiles = readdirSync(join(dir, "cur")).sort();
    // the second patch arrives in new/, with a numeric name
    mkdirSync(join(dir, "new"), { recursive: true });
    cpSync(join(dir, "cur", curFiles[1] as string), join(dir, "new", "10.msg"));
    rmSync(join(dir, "cur", curFiles[1] as string));
    const messages: { name: string; content: Buffer }[] = [];
    for (const sub of ["cur", "new"])
      for (const f of readdirSync(join(dir, sub)))
        messages.push({ name: `${sub}/${f}`, content: file(join(dir, sub, f)) });
    const pair = twins(src, [["checkout", "-q", "first"]]);
    await step(pair, [dir], (c) => c.addMaildir(messages, dir), "maildir");
  }, 60_000);
});

// ---------------------------------------------------------------------------------------
// git mailsplit (the mailinfo script)
// ---------------------------------------------------------------------------------------

describeGit("git mailsplit as native git", () => {
  let base = "";
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "mailsplit-native-"));
  });
  afterAll(() => removeTempDir(base), CLEANUP_TIMEOUT);

  function listFiles(dir: string): [string, string][] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .sort()
      .map((f) => [f, readFileSync(join(dir, f)).toString("base64")]);
  }

  /** `git mailsplit <args> <paths>` and ours, compared by output and the files written. */
  async function twin(
    paths: string[],
    args: string[],
    options: MailsplitOptions,
    stdin?: Buffer,
  ): Promise<{ status: number; stdout: string }> {
    const n = counter++;
    const nativeOut = join(base, `n${n}`);
    const oursOut = join(base, `o${n}`);
    mkdirSync(nativeOut);
    mkdirSync(oursOut);
    const r = spawnSync("git", ["mailsplit", `-o${nativeOut}`, ...args, ...paths], {
      cwd: base,
      env: nativeGitEnv(base),
      input: stdin ?? "",
    });
    const files = createNodeFilesApi({ rootDir: "/" });
    const ours = await mailsplitFiles(files, paths, oursOut, {
      ...options,
      ...(stdin ? { stdin } : {}),
    });
    expect({ status: ours.exitCode, stdout: ours.output, stderr: ours.errors }).toEqual({
      status: r.status,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    });
    expect(listFiles(oursOut)).toEqual(listFiles(nativeOut));
    expect(ours.files.map((f) => f.name)).toEqual(readdirSync(nativeOut).sort());
    return { status: r.status ?? 1, stdout: r.stdout.toString() };
  }

  const mboxFile = (name: string, content: string | Buffer) => {
    const p = join(base, `${counter++}-${name}`);
    writeFileSync(p, content);
    return p;
  };

  const MAIL = (n: number, extra = "") =>
    `From 1234567890123456789012345678901234567890 Mon Sep 17 00:00:00 2001\nFrom: A U Thor <a@example.com>\nDate: Fri, 9 Jun 2006 00:44:16 -0700\nSubject: [PATCH] message ${n}\n\nBody ${n}.\n${extra}---\n foo | 2 +-\n\ndiff --git a/foo b/foo\n--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-a\n+b\n`;

  it('t5100-mailinfo.sh: "split sample box"', async () => {
    const sample = mboxFile(
      "sample.mbox",
      `  \n\n${[1, 2, 3, 4, 5].map((n) => MAIL(n, n === 2 ? "From me, a line that is no separator\n" : "")).join("")}From nobody Mon Sep 17 00:00:00 2001\nFrom: bare <b@x>\nSubject: last\n\nbody\n`,
    );
    const r = await twin([sample], [], {});
    expect(r.stdout).toBe("6\n");
    // -b does not change a mailbox that starts with a separator; -f counts on
    await twin([sample], ["-b", "-f7"], { allowBare: true, skip: 7 });
    // two mailboxes go on numbering
    await twin([sample, sample], ["-d3"], { precision: 3 });
  }, 60_000);

  it('t5100-mailinfo.sh: "respect NULs", "Preserve NULs out of MIME encoded message"', async () => {
    const nul = mboxFile(
      "nul-plain",
      Buffer.concat([
        Buffer.from(MAIL(1).replace("Body 1.", "Body \0 with a NUL")),
        Buffer.from("\0\n"),
      ]),
    );
    await twin([nul], ["-d3"], { precision: 3 });
    const b64 = mboxFile(
      "nul-b64.in",
      `From 1234567890123456789012345678901234567890 Mon Sep 17 00:00:00 2001\nFrom: A <a@x>\nSubject: nul\nContent-Transfer-Encoding: base64\n\n${Buffer.from("a\0b\n").toString("base64")}\n`,
    );
    await twin([b64], ["-d5"], { precision: 5 });
  }, 60_000);

  it('t5100-mailinfo.sh: "mailinfo on from header without name works", "mailinfo finds headers after embedded From line"', async () => {
    const bare = mboxFile(
      "info-from.in",
      "From: bare@example.com\nSubject: no separator\n\nbody\n",
    );
    // no separator and no -b: a corrupt mailbox
    await twin([bare], [], {});
    await twin([bare], ["-b"], { allowBare: true });
    const embed = mboxFile(
      "embed-from.in",
      `${MAIL(1)}From bogus too many spaces Mon Sep 17 00:00:00 2001\nmore\n`,
    );
    await twin([embed], [], {});
  }, 60_000);

  it('t5100-mailinfo.sh: "mailinfo unescapes with --mboxrd"', async () => {
    const rd = mboxFile(
      "sample.mboxrd",
      `${MAIL(1, ">From quoted\n>>From twice\n>From\nFrom not a separator\n")}${MAIL(2, ">>>From thrice\n")}`,
    );
    const r = await twin([rd], ["--mboxrd"], { mboxrd: true });
    expect(r.stdout).toBe("2\n");
    const sp = Buffer.from(
      "From mboxrd Mon Sep 17 00:00:00 2001\nFrom: trailing spacer <sp@example.com>\nSubject: [PATCH] a commit with trailing space\n\nFrom \n>From \n\n",
    );
    await twin([], ["-f2", "--mboxrd"], { skip: 2, mboxrd: true }, sp);
    // without --mboxrd the quoting stays
    await twin([rd], [], {});
  }, 60_000);

  it('t5100-mailinfo.sh: "split base64 email with quoted-cr"', async () => {
    const box = mboxFile(
      "quoted-cr.mbox",
      crlf(`${MAIL(1)}${MAIL(2).replace("Body 2.", "Body\r with a lone CR")}`),
    );
    await twin([box], [], {});
    await twin([box], ["--keep-cr"], { keepCr: true });
  }, 60_000);

  it("splits Maildirs (cur/ then new/, numbers compared as numbers) and fails as git", async () => {
    const dir = join(base, `Maildir${counter++}`);
    for (const [name, n] of [
      ["cur/12.a", 1],
      ["cur/2.b", 2],
      ["cur/.hidden", 3],
      ["new/1.c", 4],
      ["new/1.c.2", 5],
    ] as const) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(
        join(dir, name),
        n === 5 ? MAIL(n).replace(/^From [^\n]*\n/, "") : `${MAIL(n)}${MAIL(9)}`,
      );
    }
    await twin([dir], ["-d3"], { precision: 3 });
    // a Maildir after an mbox
    const box = mboxFile("one.mbox", crlf(MAIL(7)));
    await twin([box, dir], ["-b"], { allowBare: true });
    // a Maildir with only new/
    const onlyNew = join(base, `Maildir${counter++}`);
    mkdirSync(join(onlyNew, "new"), { recursive: true });
    writeFileSync(join(onlyNew, "new", "x"), MAIL(1));
    await twin([onlyNew], [], {});
    // failures: an empty mbox, a missing path (files written before stay)
    const empty = mboxFile("empty", " \n\t\n");
    await twin([box, empty], [], {});
    await twin([box, join(base, "missing")], [], {});
    // empty standard input is no error
    await twin([], [], {}, Buffer.from(""));
  }, 60_000);
});
