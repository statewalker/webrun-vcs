/**
 * `git commit -C/-c` and `--fixup=[amend:|reword:]` / `--squash` against native git
 * (builtin/commit.c parse_and_validate_options, prepare_to_commit, prepare_amend_commit,
 * check_fixup_reword_options). Scenarios from t7500-commit-template-squash-signoff.sh,
 * t7501-commit-basic-functionality.sh and t3437-rebase-fixup-options.sh: each case runs native
 * git in one copy of a repository and ours in the other and compares the commit made (its
 * id: tree, parents, author, committer and message) or the refusal (stderr and exit code).
 * The fixup commits ours makes are then folded by native and by our `rebase -i --autosquash`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CommitCommand, type GitApiError, RebaseStatus } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const git = (cwd: string, args: string[], extra?: Record<string, string>) =>
  gitOut(root, cwd, args, extra);

/** Commits authored by someone else at other dates, so reused authorship shows. */
const OTHER = {
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_AUTHOR_DATE: "1112912053 -0700",
  GIT_COMMITTER_DATE: "1112912053 -0700",
};

/** No editor: the prepared message is taken as it is (ours without `setEditor`). */
const NO_EDITOR = { GIT_EDITOR: ":" };
/** An editor that puts `E ` before the first line (ours: {@link prefixEditor}). */
const PREFIX_EDITOR = { GIT_EDITOR: "sed -i -e '1s/^/E /'" };
const prefixEditor = async (_path: string, text: string) => `E ${text}`;

function base(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, "a.txt", "a\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "initial"], OTHER);
  putFile(dir, "a.txt", "a2\n");
  git(dir, ["commit", "-qam", "Second subject\ncontinued\n\nThe body of\nthe second.\n"], OTHER);
  putFile(dir, "b.txt", "b\n");
  git(dir, ["add", "b.txt"]);
  git(dir, ["commit", "-qm", "third"], { ...OTHER, GIT_AUTHOR_DATE: "1112912113 +0200" });
  git(dir, ["tag", "-a", "-m", "tagged", "v3"]);
  // something staged for the next commit
  putFile(dir, "a.txt", "a3\n");
  git(dir, ["add", "a.txt"]);
}

/** Two copies of `dir`: native git works in one, ours in the other. */
function twins(dir: string): [string, string] {
  const out: [string, string] = [`${dir}-native`, `${dir}-ours`];
  for (const copy of out) {
    rmSync(copy, { recursive: true, force: true });
    execFileSync("cp", ["-a", dir, copy]);
    gitRun(root, copy, ["update-index", "-q", "--refresh"]);
  }
  return out;
}

const head = (d: string) => git(d, ["rev-parse", "HEAD"]).trim();

/**
 * Native `git commit <args>` and ours (`setup`) on two copies of `dir`: the same outcome,
 * the same commit (or the same stderr and exit code), the same index. Returns the copies.
 */
async function expectCommit(
  dir: string,
  args: string[],
  setup: (c: CommitCommand) => void,
  label: string,
  extra: Record<string, string> = NO_EDITOR,
): Promise<[string, string]> {
  const [theirs, mine] = twins(dir);
  const native = gitRun(root, theirs, ["commit", "-q", ...args], extra);
  const command = (await openRepo(root, mine)).commit();
  let error: GitApiError | undefined;
  try {
    setup(command);
    await command.call();
  } catch (e) {
    error = e as GitApiError;
  }
  expect(error === undefined, `${label}: ${String(error)} / ${native.stderr}`).toBe(
    native.status === 0,
  );
  if (error) {
    expect(error.exitCode, `${label}: exit code`).toBe(native.status);
    if (native.status !== 1 || native.stderr.startsWith("Aborting")) {
      expect(`${error.message}\n`, `${label}: stderr`).toBe(native.stderr);
    }
  } else {
    expect(git(mine, ["cat-file", "commit", "HEAD"]), `${label}: commit`).toBe(
      git(theirs, ["cat-file", "commit", "HEAD"]),
    );
  }
  expect(head(mine), `${label}: HEAD`).toBe(head(theirs));
  expect(git(mine, ["ls-files", "-s"]), `${label}: index`).toBe(git(theirs, ["ls-files", "-s"]));
  return [theirs, mine];
}

describeGit("commit -C/-c and --fixup/--squash: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "commit-reuse-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("-C and -c: the message and the authorship of the named commit (t7501)", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectCommit(dir, ["-C", "HEAD~1"], (c) => c.setReuseMessage("HEAD~1"), "-C HEAD~1");
    await expectCommit(dir, ["-C", "v3"], (c) => c.setReuseMessage("v3"), "-C <tag>");
    await expectCommit(
      dir,
      ["-C", "HEAD~1", "--reset-author"],
      (c) => c.setReuseMessage("HEAD~1").setResetAuthor(true),
      "-C --reset-author",
    );
    await expectCommit(
      dir,
      ["-C", "HEAD~1", "--author", "New Name <new@example.com>"],
      (c) => c.setReuseMessage("HEAD~1").setAuthor("New Name", "new@example.com"),
      "-C --author",
    );
    await expectCommit(
      dir,
      ["--amend", "-C", "HEAD~2"],
      (c) => c.setAmend(true).setReuseMessage("HEAD~2"),
      "--amend -C",
    );
    await expectCommit(dir, ["-c", "HEAD~1"], (c) => c.setReeditMessage("HEAD~1"), "-c :");
    await expectCommit(
      dir,
      ["-c", "HEAD~1"],
      (c) => c.setReeditMessage("HEAD~1").setEditor(prefixEditor),
      "-c editor",
      PREFIX_EDITOR,
    );
    await expectCommit(
      dir,
      ["-C", "HEAD~1", "-e"],
      (c) => c.setReuseMessage("HEAD~1").setEdit(true).setEditor(prefixEditor),
      "-C -e",
      PREFIX_EDITOR,
    );
    await expectCommit(
      dir,
      ["-c", "HEAD~1", "--no-edit"],
      (c) => c.setReeditMessage("HEAD~1").setEdit(false).setEditor(prefixEditor),
      "-c --no-edit",
      PREFIX_EDITOR,
    );
  });

  it("-C/-c refusals: a missing commit, a tree, -m and each other (t7501)", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectCommit(dir, ["-C", "nope"], (c) => c.setReuseMessage("nope"), "-C missing");
    await expectCommit(dir, ["-c", "nope"], (c) => c.setReeditMessage("nope"), "-c missing");
    await expectCommit(
      dir,
      ["-C", "HEAD^{tree}"],
      (c) => c.setReuseMessage("HEAD^{tree}"),
      "-C tree",
    );
    await expectCommit(
      dir,
      ["-m", "x", "-C", "HEAD"],
      (c) => c.setMessage("x").setReuseMessage("HEAD"),
      "-m -C",
    );
    await expectCommit(
      dir,
      ["-m", "x", "-c", "HEAD"],
      (c) => c.setMessage("x").setReeditMessage("HEAD"),
      "-m -c",
    );
    await expectCommit(
      dir,
      ["-C", "HEAD", "-c", "HEAD"],
      (c) => c.setReuseMessage("HEAD").setReeditMessage("HEAD"),
      "-C -c",
    );
    await expectCommit(
      dir,
      ["-C", "HEAD", "-c", "HEAD", "--fixup", "HEAD"],
      (c) => c.setReuseMessage("HEAD").setReeditMessage("HEAD").setFixup("HEAD"),
      "-C -c --fixup",
    );
  });

  it("--fixup=<commit>: `fixup! <subject>`, with -m appended, -e (t7500)", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectCommit(dir, ["--fixup", "HEAD~1"], (c) => c.setFixup("HEAD~1"), "--fixup");
    await expectCommit(
      dir,
      ["--fixup", "HEAD~1", "-m", "log message"],
      (c) => c.setFixup("HEAD~1").setMessage("log message"),
      "--fixup -m",
    );
    await expectCommit(
      dir,
      ["--fixup", "HEAD~1", "-e"],
      (c) => c.setFixup("HEAD~1").setEdit(true).setEditor(prefixEditor),
      "--fixup -e",
      PREFIX_EDITOR,
    );
    await expectCommit(
      dir,
      ["--fixup", "HEAD~1"],
      (c) => c.setFixup("HEAD~1").setEditor(prefixEditor),
      "--fixup ignores the editor",
      PREFIX_EDITOR,
    );
    await expectCommit(
      dir,
      ["--amend", "--fixup", "HEAD~1"],
      (c) => c.setAmend(true).setFixup("HEAD~1"),
      "--amend --fixup",
    );
    // nothing to commit: refused unless --allow-empty
    const [, clean] = await expectCommit(
      dir,
      ["-m", "staged"],
      (c) => c.setMessage("staged"),
      "-m",
    );
    await expectCommit(clean, ["--fixup", "HEAD~1"], (c) => c.setFixup("HEAD~1"), "empty fixup");
    await expectCommit(
      clean,
      ["--fixup", "HEAD~1", "--allow-empty"],
      (c) => c.setFixup("HEAD~1").setAllowEmpty(true),
      "empty fixup --allow-empty",
    );
  });

  it("--fixup refusals: -C, -c, --squash, a missing commit, unknown suboptions (t7500)", async () => {
    const dir = join(root, "r");
    base(dir);
    for (const [flag, set] of [
      ["-C", (c: CommitCommand) => c.setReuseMessage("HEAD")],
      ["-c", (c: CommitCommand) => c.setReeditMessage("HEAD")],
    ] as const) {
      await expectCommit(
        dir,
        ["--fixup", "HEAD~1", flag, "HEAD"],
        (c) => set(c.setFixup("HEAD~1")),
        `--fixup ${flag}`,
      );
    }
    await expectCommit(
      dir,
      ["--fixup", "HEAD~1", "--squash", "HEAD~2"],
      (c) => c.setFixup("HEAD~1").setSquash("HEAD~2"),
      "--fixup --squash",
    );
    await expectCommit(dir, ["--fixup", "nope"], (c) => c.setFixup("nope"), "--fixup missing");
    await expectCommit(
      dir,
      ["--fixup", "wrong:HEAD"],
      (c) => c.setFixup("wrong:HEAD"),
      "--fixup=wrong:",
    );
    await expectCommit(
      dir,
      ["--fixup", "amend:nope"],
      (c) => c.setFixup("amend:nope"),
      "--fixup=amend:missing",
    );
    // not letters before the colon: a revision (HEAD^1:a.txt is a blob)
    await expectCommit(
      dir,
      ["--fixup", "HEAD^1:a.txt"],
      (c) => c.setFixup("HEAD^1:a.txt"),
      "--fixup=<rev>:<path>",
    );
  });

  it("--fixup=amend: `amend! <subject>` and the whole message, through the editor (t7500)", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectCommit(
      dir,
      ["--fixup", "amend:HEAD~1"],
      (c) => c.setFixup("amend:HEAD~1"),
      "amend: :",
    );
    await expectCommit(
      dir,
      ["--fixup", "amend:HEAD~1"],
      (c) => c.setFixup("amend:HEAD~1").setEditor(prefixEditor),
      "amend: editor",
      PREFIX_EDITOR,
    );
    await expectCommit(
      dir,
      ["--fixup", "amend:HEAD~1", "--no-edit"],
      (c) => c.setFixup("amend:HEAD~1").setEdit(false),
      "amend: --no-edit",
    );
    // the staged change is committed; with nothing staged the commit is allowed to be empty
    const [, clean] = await expectCommit(
      dir,
      ["-m", "staged"],
      (c) => c.setMessage("staged"),
      "-m",
    );
    await expectCommit(
      clean,
      ["--fixup", "amend:HEAD~1"],
      (c) => c.setFixup("amend:HEAD~1"),
      "amend: empty",
    );
    // with paths: a partial commit of them
    putFile(dir, "b.txt", "b2\n");
    await expectCommit(
      dir,
      ["--fixup", "amend:HEAD~1", "--", "b.txt"],
      (c) => c.setFixup("amend:HEAD~1").setOnly("b.txt"),
      "amend: <paths>",
    );
    await expectCommit(
      dir,
      ["--fixup", "amend:HEAD~1", "-m", "x"],
      (c) => c.setFixup("amend:HEAD~1").setMessage("x"),
      "amend: -m",
    );
    await expectCommit(
      dir,
      ["--fixup", "amend:HEAD~1", "-a"],
      (c) => c.setFixup("amend:HEAD~1").setAll(true),
      "amend: -a",
    );
  });

  it("--fixup=amend: of an `amend!` commit takes its body; an empty body is refused (t7500)", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["commit", "-q", "-m", "amend! third\n\nthe new message"], OTHER);
    putFile(dir, "c.txt", "c\n");
    git(dir, ["add", "c.txt"]);
    await expectCommit(
      dir,
      ["--fixup", "amend:HEAD"],
      (c) => c.setFixup("amend:HEAD"),
      "amend: of amend!",
    );
    git(dir, ["commit", "-q", "-m", "amend! third"], OTHER);
    putFile(dir, "c.txt", "c2\n");
    git(dir, ["add", "c.txt"]);
    await expectCommit(
      dir,
      ["--fixup", "amend:HEAD"],
      (c) => c.setFixup("amend:HEAD"),
      "amend: empty body",
    );
    await expectCommit(
      dir,
      ["--fixup", "amend:HEAD", "--allow-empty-message"],
      (c) => c.setFixup("amend:HEAD").setAllowEmptyMessage(true),
      "amend: empty body --allow-empty-message",
    );
  });

  it("--fixup=reword: HEAD's tree with the new message; its refusals (t7500)", async () => {
    const dir = join(root, "r");
    base(dir);
    const [, mine] = await expectCommit(
      dir,
      ["--fixup", "reword:HEAD~1"],
      (c) => c.setFixup("reword:HEAD~1"),
      "reword:",
    );
    // the staged change stays staged
    expect(git(mine, ["diff", "--cached", "--name-only"])).toBe("a.txt\n");
    await expectCommit(
      dir,
      ["--fixup", "reword:HEAD~1"],
      (c) => c.setFixup("reword:HEAD~1").setEditor(prefixEditor),
      "reword: editor",
      PREFIX_EDITOR,
    );
    await expectCommit(
      dir,
      ["--fixup", "reword:HEAD~1", "-m", "x"],
      (c) => c.setFixup("reword:HEAD~1").setMessage("x"),
      "reword: -m",
    );
    await expectCommit(
      dir,
      ["--fixup", "reword:HEAD~1", "--", "a.txt"],
      (c) => c.setFixup("reword:HEAD~1").setOnly("a.txt"),
      "reword: <paths>",
    );
    await expectCommit(
      dir,
      ["--fixup", "reword:HEAD~1", "-a"],
      (c) => c.setFixup("reword:HEAD~1").setAll(true),
      "reword: -a",
    );
    await expectCommit(
      dir,
      ["--fixup", "reword:HEAD~1", "-i", "a.txt"],
      (c) => c.setFixup("reword:HEAD~1").setInclude("a.txt"),
      "reword: -i <paths>",
    );
    // during a merge
    const merging = join(root, "m");
    base(merging);
    git(merging, ["commit", "-qm", "staged"]);
    git(merging, ["checkout", "-q", "-b", "side", "HEAD~2"]);
    putFile(merging, "s.txt", "s\n");
    git(merging, ["add", "s.txt"]);
    git(merging, ["commit", "-qm", "side"]);
    git(merging, ["checkout", "-q", "main"]);
    git(merging, ["merge", "-q", "--no-commit", "side"]);
    await expectCommit(
      merging,
      ["--fixup", "reword:HEAD~1"],
      (c) => c.setFixup("reword:HEAD~1"),
      "reword: merging",
    );
  });

  it("--squash: `squash! <subject>` before -m, -C, -c and the editor's message (t7500)", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectCommit(
      dir,
      ["--squash", "HEAD~1", "-m", "log message"],
      (c) => c.setSquash("HEAD~1").setMessage("log message"),
      "--squash -m",
    );
    await expectCommit(
      dir,
      ["--squash", "HEAD~1", "-C", "HEAD~1"],
      (c) => c.setSquash("HEAD~1").setReuseMessage("HEAD~1"),
      "--squash -C same",
    );
    await expectCommit(
      dir,
      ["--squash", "HEAD~1", "-C", "HEAD"],
      (c) => c.setSquash("HEAD~1").setReuseMessage("HEAD"),
      "--squash -C other",
    );
    await expectCommit(
      dir,
      ["--squash", "HEAD~1", "-c", "HEAD"],
      (c) => c.setSquash("HEAD~1").setReeditMessage("HEAD").setEditor(prefixEditor),
      "--squash -c",
      PREFIX_EDITOR,
    );
    await expectCommit(dir, ["--squash", "HEAD~1"], (c) => c.setSquash("HEAD~1"), "--squash :");
    await expectCommit(
      dir,
      ["--squash", "HEAD~1"],
      (c) => c.setSquash("HEAD~1").setEditor(prefixEditor),
      "--squash editor",
      PREFIX_EDITOR,
    );
    await expectCommit(dir, ["--squash", "nope"], (c) => c.setSquash("nope"), "--squash missing");
  });

  it("fixup!, amend! and squash! commits made by ours fold as git's under --autosquash (t3437)", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["commit", "-qm", "fourth"]);
    const steps: Array<[string[], (c: CommitCommand) => void, string]> = [
      [["--fixup", "HEAD~2"], (c) => c.setFixup("HEAD~2"), "f.txt"],
      [["--fixup", "amend:HEAD~3", "-e"], (c) => c.setFixup("amend:HEAD~3"), "g.txt"],
      [["--fixup", "reword:HEAD~3"], (c) => c.setFixup("reword:HEAD~3"), ""],
      [
        ["--squash", "HEAD~4", "-m", "more"],
        (c) => c.setSquash("HEAD~4").setMessage("more"),
        "h.txt",
      ],
    ];
    const [theirs, mine] = twins(dir);
    for (const [args, setup, file] of steps) {
      for (const d of [theirs, mine]) {
        if (file) {
          putFile(d, file, `${file}\n`);
          git(d, ["add", file]);
        }
      }
      gitRun(root, theirs, ["commit", "-q", ...args], NO_EDITOR);
      const command = (await openRepo(root, mine)).commit();
      setup(command);
      await command.call();
      expect(head(mine), args.join(" ")).toBe(head(theirs));
    }
    // native autosquash over ours' commits, and ours over the native ones
    const env = { GIT_SEQUENCE_EDITOR: ":", GIT_EDITOR: ":" };
    const nativeOfOurs = `${mine}-native-rebase`;
    execFileSync("cp", ["-a", mine, nativeOfOurs]);
    for (const d of [theirs, nativeOfOurs]) {
      const r = gitRun(root, d, ["rebase", "-i", "--autosquash", "HEAD~7"], env);
      expect(r.status, r.stderr).toBe(0);
    }
    const rebase = (await openRepo(root, mine)).rebase();
    rebase.runInteractively({ editTodo: (text) => text, modifyCommitMessage: (text) => text });
    rebase.setAutosquash(true);
    await rebase.setUpstreamBranch("HEAD~7");
    const result = await rebase.call();
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    expect(head(nativeOfOurs)).toBe(head(theirs));
    expect(head(mine)).toBe(head(theirs));
    expect(git(theirs, ["log", "--format=%s", "main"])).not.toMatch(/fixup!|amend!|squash!/);
  });
});
