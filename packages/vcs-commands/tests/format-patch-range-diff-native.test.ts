/**
 * `git format-patch --interdiff`/`--range-diff`/`--creation-factor` against native git: the
 * blocks in the cover letter, after a single patch (git 2.46 and later) or as commentary
 * below its `---` (before), the titles by reroll count, the notes compared, and the deaths.
 * Inputs from t4014-format-patch's interdiff and range-diff cases and t3206-range-diff's
 * format-patch cases (its history in `fixtures/t3206-history.export`); mails compared byte
 * for byte with `--stdout`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type FormatPatchCommand, Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

type Env = Record<string, string>;
let root = "";
let home = "";
let version = "";

const IDENT: Env = {
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_COMMITTER_DATE: "1700000500 -0700",
};

const envOf = (over: Env = {}): Env => ({ ...nativeGitEnv(home), ...IDENT, ...over });

function git(cwd: string, args: string[], env: Env = {}, input?: string) {
  const r = spawnSync("git", args, {
    cwd,
    env: envOf(env),
    maxBuffer: 64 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr.toString() };
}

function gitOk(cwd: string, args: string[], env: Env = {}, input?: string): string {
  const r = git(cwd, args, env, input);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
}

let tick = 1700000000;
function ticked(): Env {
  tick += 60;
  return { GIT_AUTHOR_DATE: `${tick} -0700`, GIT_COMMITTER_DATE: `${tick} -0700` };
}

/** git's test_commit <message> <file>: the file holds the message, committed and tagged. */
function testCommit(repo: string, message: string, file = `${message}.t`): void {
  writeFileSync(join(repo, file), `${message}\n`);
  gitOk(repo, ["add", file]);
  gitOk(repo, ["commit", "-q", "-m", message], ticked());
  gitOk(repo, ["tag", message]);
}

async function open(repo: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: envOf() });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** format-patch's options as our command takes them. */
function configure(command: FormatPatchCommand, args: string[]): FormatPatchCommand {
  for (const a of args) {
    if (a === "--cover-letter") command.setCoverLetter(true);
    else if (a === "--no-cover-letter") command.setCoverLetter(false);
    else if (a === "--notes") command.setNotes(true);
    else if (a === "--no-notes") command.setNotes(false);
    else if (a.startsWith("--notes=")) command.setNotes(a.slice(8));
    else if (a.startsWith("--interdiff=")) command.setInterdiff(a.slice(12));
    else if (a.startsWith("--range-diff=")) command.setRangeDiff(a.slice(13));
    else if (a.startsWith("--creation-factor=")) command.setCreationFactor(Number(a.slice(18)));
    else if (a.startsWith("-v")) command.setRerollCount(a.slice(2));
    else if (/^-\d+$/.test(a)) command.setMaxCount(Number(a.slice(1)));
    else command.addRevision(a);
  }
  return command;
}

/** Native `git format-patch --stdout <args>` (with `config` set in the repository) against ours. */
async function expectSame(repo: string, args: string[], config: Env = {}): Promise<void> {
  for (const [k, v] of Object.entries(config)) gitOk(repo, ["config", k, v]);
  try {
    await compare(repo, args, config);
  } finally {
    for (const k of Object.keys(config)) gitOk(repo, ["config", "--unset", k]);
  }
}

async function compare(repo: string, args: string[], config: Env): Promise<void> {
  const native = git(repo, ["format-patch", "--stdout", ...args]);
  const g = await open(repo);
  let ours: { status: number; out: string };
  try {
    const r = await configure(
      g.formatPatch().setStdout(true).setVersionString(version),
      args,
    ).call();
    ours = { status: 0, out: Buffer.from(r.output).toString("latin1") };
  } catch (error) {
    const message = (error as Error).message;
    // git's death: its message is ours
    expect([args, native.stderr]).toEqual([args, `fatal: ${message}\n`]);
    ours = { status: 128, out: "" };
  } finally {
    g.close();
  }
  expect([args, config, ours]).toEqual([
    args,
    config,
    { status: native.status, out: native.stdout.toString("latin1") },
  ]);
}

describeGit("git format-patch --interdiff/--range-diff as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "format-patch-range-diff-native-"));
    home = join(root, "home");
    mkdirSync(home, { recursive: true });
    version = gitOk(root, ["--version"])
      .trim()
      .replace(/^git version /, "");
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('t4014-format-patch.sh "interdiff: setup", "interdiff: cover-letter", "interdiff: reroll-count", "interdiff: reroll-count with a non-integer", "interdiff: solo-patch", "range-diff: solo-patch", "interdiff: multi-patch, implicit --cover-letter", "interdiff: explicit --no-cover-letter defeats implied --cover-letter"', async () => {
    const repo = join(root, "t4014");
    mkdirSync(repo);
    gitOk(repo, ["init", "-q", "-b", "main"]);
    testCommit(repo, "first", "file");
    testCommit(repo, "second", "file");
    gitOk(repo, ["checkout", "-q", "-b", "boop", "main"]);
    // t4014 "interdiff: setup"
    testCommit(repo, "fnorp", "blorp");
    testCommit(repo, "fleep", "blorp");
    // t4014 "interdiff: cover-letter"
    await expectSame(repo, ["--cover-letter", "--interdiff=boop~2", "-1", "boop"]);
    // t4014 "interdiff: reroll-count"
    await expectSame(repo, ["--cover-letter", "--interdiff=boop~2", "-v2", "-1", "boop"]);
    // t4014 "interdiff: reroll-count with a non-integer"
    await expectSame(repo, ["--cover-letter", "--interdiff=boop~2", "-v2.2", "-1", "boop"]);
    // t4014 "interdiff: solo-patch"
    await expectSame(repo, ["--interdiff=boop~2", "-1", "boop"]);
    // t4014 "range-diff: solo-patch"
    await expectSame(repo, ["--creation-factor=999", "--range-diff=boop~2..boop~1", "-1", "boop"]);
    await expectSame(repo, ["--range-diff=boop~2..boop~1", "-1", "boop"]);
    await expectSame(repo, ["--range-diff=boop~1", "--interdiff=boop~1", "-1", "boop"]);
    // t4014 "interdiff: multi-patch, implicit --cover-letter"
    await expectSame(repo, ["--interdiff=boop~2", "-2", "-v23"]);
    // t4014 "interdiff: explicit --no-cover-letter defeats implied --cover-letter"
    await expectSame(repo, ["--no-cover-letter", "--interdiff=boop~2", "-2", "-v23"]);
    await expectSame(repo, ["--interdiff=boop~2", "-2", "-v23"], { "format.coverLetter": "no" });
    await expectSame(repo, ["--creation-factor=10", "-1", "boop"]);
  });

  it('t3206-range-diff.sh "format-patch --range-diff=$prev", "--range-diff implies --cover-letter for multi-patch series", "explicit --no-cover-letter defeats implied --cover-letter", "format-patch --range-diff as commentary", "format-patch --range-diff reroll-count with a non-integer", "format-patch --range-diff reroll-count with a integer", "format-patch --range-diff with v0", "format-patch --range-diff does not compare notes by default", "format-patch --notes=custom --range-diff --cover-letter only compares custom notes", "format-patch --notes=custom --range-diff on single commit only compares custom notes", "format-patch --range-diff with --no-notes", "format-patch --range-diff with --notes", "format-patch --range-diff with format.notes config"', async () => {
    const repo = join(root, "t3206");
    gitOk(root, ["init", "-q", "-b", "main", repo]);
    const history = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "t3206-history.export"),
      "latin1",
    );
    gitOk(repo, ["fast-import", "--quiet"], {}, history);
    gitOk(repo, ["checkout", "-q", "main"]);
    for (const prev of ["topic", "main..topic"]) {
      // t3206 "format-patch --range-diff=$prev"
      await expectSame(repo, ["--cover-letter", `--range-diff=${prev}`, "main..unmodified"]);
    }
    // t3206 "--range-diff implies --cover-letter for multi-patch series"
    await expectSame(repo, ["-v2", "--range-diff=topic", "main..unmodified"]);
    // t3206 "explicit --no-cover-letter defeats implied --cover-letter"
    await expectSame(repo, ["--no-cover-letter", "-v2", "--range-diff=topic", "main..unmodified"]);
    await expectSame(repo, ["-v2", "--range-diff=topic", "main..unmodified"], {
      "format.coverLetter": "no",
    });
    gitOk(repo, ["checkout", "-q", "changed-message"]);
    // t3206 "format-patch --range-diff as commentary"
    await expectSame(repo, ["--range-diff=HEAD~1", "HEAD~1"]);
    // t3206 "format-patch --range-diff reroll-count with a non-integer"
    await expectSame(repo, ["--range-diff=HEAD~1", "-v2.9", "HEAD~1"]);
    // t3206 "format-patch --range-diff reroll-count with a integer"
    await expectSame(repo, ["--range-diff=HEAD~1", "-v2", "HEAD~1"]);
    // t3206 "format-patch --range-diff with v0"
    await expectSame(repo, ["--range-diff=HEAD~1", "-v0", "HEAD~1"]);
    await expectSame(repo, ["--range-diff=changed", "--interdiff=changed", "-1"]);
    await expectSame(repo, ["--range-diff=topic...changed", "-1"]);

    gitOk(repo, ["notes", "add", "-m", "topic note", "topic"]);
    gitOk(repo, ["notes", "add", "-m", "unmodified note", "unmodified"]);
    gitOk(repo, ["notes", "--ref=custom", "add", "-m", "topic note (custom)", "topic"]);
    gitOk(repo, ["notes", "--ref=custom", "add", "-m", "unmodified note (custom)", "unmodified"]);
    for (const prev of ["topic", "main..topic"]) {
      // t3206 "format-patch --range-diff does not compare notes by default"
      await expectSame(repo, ["--cover-letter", `--range-diff=${prev}`, "main..unmodified"]);
      // t3206 "format-patch --notes=custom --range-diff --cover-letter only compares custom notes"
      await expectSame(repo, [
        "--notes=custom",
        "--cover-letter",
        `--range-diff=${prev}`,
        "main..unmodified",
      ]);
      // t3206 "format-patch --range-diff with --no-notes"
      await expectSame(repo, [
        "--no-notes",
        "--cover-letter",
        `--range-diff=${prev}`,
        "main..unmodified",
      ]);
      // t3206 "format-patch --range-diff with --notes"
      await expectSame(repo, [
        "--notes",
        "--cover-letter",
        `--range-diff=${prev}`,
        "main..unmodified",
      ]);
      // t3206 "format-patch --range-diff with format.notes config"
      await expectSame(repo, ["--cover-letter", `--range-diff=${prev}`, "main..unmodified"], {
        "format.notes": "true",
      });
    }
    // t3206 "format-patch --notes=custom --range-diff on single commit only compares custom notes"
    gitOk(repo, ["checkout", "-q", "unmodified"]);
    await expectSame(repo, ["--notes=custom", "--range-diff=topic", "-1"]);
    await expectSame(repo, ["--range-diff=topic", "-1"]);

    // a single patch's range-diff takes format-patch's notes options from git 2.52 on
    const notesOf = async (v: string) => {
      const g = await open(repo);
      try {
        const r = await g
          .formatPatch()
          .setStdout(true)
          .setVersionString(v)
          .setNotes("custom")
          .setRangeDiff("topic")
          .setMaxCount(1)
          .call();
        const text = Buffer.from(r.output).toString("latin1");
        return text.slice(text.indexOf("Range-diff:"));
      } finally {
        g.close();
      }
    };
    const before = await notesOf("2.50.0");
    expect(before).toContain(" ## Notes ##");
    expect(before).not.toContain("## Notes (custom) ##");
    const after = await notesOf("2.52.0");
    expect(after).toContain(" ## Notes (custom) ##");
    expect(after).not.toContain(" ## Notes ##");
  });
});
