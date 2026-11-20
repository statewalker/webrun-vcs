/**
 * `git commit` against native git (builtin/commit.c): `COMMIT_EDITMSG` as prepare_to_commit
 * writes it for every commit (`-m` in each cleanup mode, `--amend --no-edit`, a merge's
 * prepared message with and without `--no-edit`, `cherry-pick --continue`, `merge
 * --continue`), the order of the nothing-to-commit, empty-message and untouched-template
 * refusals, the commands that write none (a clean merge, cherry-pick, revert, rebase, am),
 * `commit -i` / `--include` and its refusals, and a `diff.submodule` without a value failing
 * the commands that read `git_diff_ui_config`. Each case runs native git in one copy of a
 * repository and ours in the other.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CleanupMode,
  type CommitCommand,
  EmptyCommitError,
  MergeOperation,
  MergeStatus,
  SequencerOperation,
} from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const is25x = (() => {
  if (!nativeGitAvailable()) return false;
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return !!m && (Number(m[1]) > 2 || Number(m[2]) >= 50);
})();

let root: string;
const git = (cwd: string, args: string[], extra?: Record<string, string>) =>
  gitOut(root, cwd, args, extra);

function base(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, "a.txt", "a\n");
  putFile(dir, "b.txt", "b\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base\n\nwith a body"]);
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

const editmsg = (d: string) => {
  const path = join(d, ".git/COMMIT_EDITMSG");
  return existsSync(path) ? readFileSync(path).toString("latin1") : undefined;
};

/**
 * Native `git commit <args>` and ours (`setup`) on two copies of `dir`: exit status, an
 * abort message, COMMIT_EDITMSG and HEAD agree.
 */
async function expectCommit(
  dir: string,
  args: string[],
  setup: (c: CommitCommand) => void,
  label: string,
  extra?: Record<string, string>,
): Promise<Error | undefined> {
  const [theirs, mine] = twins(dir);
  const native = gitRun(root, theirs, ["commit", ...args], extra);
  const command = (await openRepo(root, mine)).commit();
  setup(command);
  let error: Error | undefined;
  try {
    await command.call();
  } catch (e) {
    error = e as Error;
  }
  expect(error === undefined, `${label}: ${String(error)} / ${native.stderr}`).toBe(
    native.status === 0,
  );
  if (error && native.stderr.startsWith("Aborting")) {
    expect(`${error.message}\n`, `${label}: message`).toBe(native.stderr);
  }
  expect(editmsg(mine), `${label}: COMMIT_EDITMSG`).toBe(editmsg(theirs));
  expect(git(mine, ["rev-parse", "HEAD"]), `${label}: HEAD`).toBe(
    git(theirs, ["rev-parse", "HEAD"]),
  );
  return error;
}

describeGit("COMMIT_EDITMSG and the message checks: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "commit-editmsg-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("-m: the message so far, whitespace cleaned unless verbatim, in every cleanup mode", async () => {
    const dir = join(root, "r");
    base(dir);
    putFile(dir, "a.txt", "a2\n");
    git(dir, ["add", "a.txt"]);
    const message = "\n\nSubject  \n\n\n# a comment\nbody\t\n\n";
    const modes: [string | undefined, CleanupMode | undefined][] = [
      [undefined, undefined],
      ["default", CleanupMode.DEFAULT],
      ["whitespace", CleanupMode.WHITESPACE],
      ["strip", CleanupMode.STRIP],
      ["verbatim", CleanupMode.VERBATIM],
      ["scissors", CleanupMode.SCISSORS],
    ];
    for (const [name, mode] of modes) {
      const args = name ? [`--cleanup=${name}`] : [];
      await expectCommit(
        dir,
        [...args, "-m", message],
        (c) => {
          c.setMessage(message);
          if (mode) c.setCleanupMode(mode);
        },
        `-m ${name ?? "(none)"}`,
      );
      // two paragraphs (-m -m)
      await expectCommit(
        dir,
        [...args, "-m", "first ", "-m", "# second"],
        (c) => {
          c.addMessage("first ").addMessage("# second");
          if (mode) c.setCleanupMode(mode);
        },
        `-m -m ${name ?? "(none)"}`,
      );
      // empty after the cleanup: aborted, COMMIT_EDITMSG written
      await expectCommit(
        dir,
        [...args, "-m", "# only a comment\n"],
        (c) => {
          c.setMessage("# only a comment\n");
          if (mode) c.setCleanupMode(mode);
        },
        `-m comment ${name ?? "(none)"}`,
      );
      await expectCommit(
        dir,
        [...args, "-m", "  \n"],
        (c) => {
          c.setMessage("  \n");
          if (mode) c.setCleanupMode(mode);
        },
        `-m blank ${name ?? "(none)"}`,
      );
    }
    // commit.cleanup, and a sign-off alone is an empty message
    git(dir, ["config", "commit.cleanup", "strip"]);
    await expectCommit(dir, ["-m", message], (c) => c.setMessage(message), "commit.cleanup");
    await expectCommit(
      dir,
      ["-m", "Signed-off-by: A <a@b>"],
      (c) => c.setMessage("Signed-off-by: A <a@b>"),
      "sign-off only",
    );
  }, 120_000);

  it("nothing to commit is refused before the message is checked, after COMMIT_EDITMSG", async () => {
    const dir = join(root, "r");
    base(dir);
    for (const message of ["", "Subject"]) {
      const error = await expectCommit(
        dir,
        ["-m", message],
        (c) => c.setMessage(message),
        `nothing, -m '${message}'`,
      );
      expect(error).toBeInstanceOf(EmptyCommitError);
    }
    await expectCommit(
      dir,
      ["--allow-empty", "-m", ""],
      (c) => c.setMessage("").setAllowEmpty(true),
      "--allow-empty -m ''",
    );
  }, 60_000);

  it("--amend --no-edit, -v cutting a -m message at the scissors line", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectCommit(dir, ["--amend", "--no-edit"], (c) => c.setAmend(true), "--amend --no-edit");
    await expectCommit(
      dir,
      ["--amend", "--no-edit", "--cleanup=verbatim"],
      (c) => c.setAmend(true).setCleanupMode(CleanupMode.VERBATIM),
      "--amend --no-edit verbatim",
    );
    putFile(dir, "a.txt", "a2\n");
    git(dir, ["add", "a.txt"]);
    const cut = "Kept\n# ------------------------ >8 ------------------------\nDropped\n";
    await expectCommit(dir, ["-v", "-m", cut], (c) => c.setMessage(cut).setVerbose(1), "-v -m");
    await expectCommit(dir, ["-m", cut], (c) => c.setMessage(cut), "-m with a scissors line");
  }, 60_000);

  it("a merge's prepared message: taken as an editor leaves it, or --no-edit", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["checkout", "-q", "-b", "side"]);
    putFile(dir, "b.txt", "side\n");
    git(dir, ["commit", "-qam", "side"]);
    git(dir, ["checkout", "-q", "main"]);
    putFile(dir, "b.txt", "main\n");
    git(dir, ["commit", "-qam", "main"]);
    gitRun(root, dir, ["merge", "side"]);
    putFile(dir, "b.txt", "resolved\n");
    git(dir, ["add", "b.txt"]);
    rmSync(join(dir, ".git/COMMIT_EDITMSG"), { force: true });
    // an editor accepting the message (no status in the template)
    await expectCommit(dir, ["--no-status"], () => {}, "accepted", { GIT_EDITOR: "true" });
    await expectCommit(dir, [], (c) => c.setIncludeStatus(true), "accepted, with the status", {
      GIT_EDITOR: "true",
    });
    // --no-edit: whitespace cleanup, the "# Conflicts:" comments kept
    await expectCommit(dir, ["--no-edit"], (c) => c.setEdit(false), "--no-edit");
  }, 60_000);
});

describeGit(
  "commit: nothing to commit without a first parent, -i in a dry run, amend checks",
  () => {
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "commit-p451-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    const headOf = (d: string) => gitRun(root, d, ["rev-parse", "-q", "--verify", "HEAD"]).stdout;

    it("an initial commit, or --amend of a root commit, with an empty index: nothing to commit", async () => {
      const dir = join(root, "e");
      mkdirSync(dir, { recursive: true });
      git(dir, ["init", "-q", "-b", "main"]);
      putFile(dir, "a.txt", "a\n");
      const cases: [string, (d: string) => void, string[], (c: CommitCommand) => CommitCommand][] =
        [
          ["initial, empty index", () => {}, ["-m", "x"], (c) => c.setMessage("x")],
          [
            "initial, an intent-to-add entry only",
            (d) => git(d, ["add", "-N", "a.txt"]),
            ["-m", "x"],
            (c) => c.setMessage("x"),
          ],
          [
            "--amend of a root commit, the index emptied",
            (d) => {
              git(d, ["add", "a.txt"]);
              git(d, ["commit", "-qm", "root"]);
              git(d, ["rm", "-q", "--cached", "a.txt"]);
            },
            ["--amend", "-m", "y"],
            (c) => c.setAmend(true).setMessage("y"),
          ],
        ];
      for (const [label, setup, args, ours] of cases) {
        const [theirs, mine] = twins(dir);
        setup(theirs);
        setup(mine);
        const native = gitRun(root, theirs, ["commit", ...args]);
        expect(native.status, label).toBe(1);
        const error = await ours((await openRepo(root, mine)).commit())
          .call()
          .then(
            () => undefined,
            (e: Error) => e,
          );
        expect(error, label).toBeInstanceOf(EmptyCommitError);
        expect((error as EmptyCommitError).exitCode, label).toBe(1);
        expect(error?.message.toLowerCase(), label).toContain("nothing to commit");
        expect(headOf(mine), label).toBe(headOf(theirs));
        // allowed with --allow-empty
        const allowedNative = gitRun(root, theirs, ["commit", "--allow-empty", ...args]);
        expect(allowedNative.status, label).toBe(0);
        await ours((await openRepo(root, mine)).commit())
          .setAllowEmpty(true)
          .call();
        expect(git(mine, ["log", "--format=%s %T"]), label).toBe(
          git(theirs, ["log", "--format=%s %T"]),
        );
      }
    }, 60_000);

    it("--dry-run with -i: the named tracked paths staged on a held index, the index kept", async () => {
      const dir = join(root, "r");
      base(dir);
      putFile(dir, "a.txt", "a2\n");
      putFile(dir, "b.txt", "b2\n");
      const index = (d: string) => readFileSync(join(d, ".git/index")).toString("latin1");
      const before = index(dir);
      for (const format of ["short", "porcelain", "long"] as const) {
        const native = gitRun(root, dir, ["commit", "--dry-run", `--${format}`, "-i", "a.txt"]);
        const ours = await (await openRepo(root, dir))
          .commit()
          .setInclude("a.txt")
          .setStatusFormat(format)
          .callDryRun();
        expect(ours.text, format).toBe(native.stdout);
        expect(ours.exitCode, format).toBe(native.status);
        expect(index(dir), format).toBe(before);
      }
      // the refusals of a commit
      for (const [args, setup] of [
        [["-i", "-a"], (c: CommitCommand) => c.setInclude("a.txt").setAll(true)],
        [["-i"], (c: CommitCommand) => c.setInclude()],
      ] as const) {
        const native = gitRun(root, dir, ["commit", "--dry-run", ...args]);
        expect(native.status).toBe(128);
        await expect(setup((await openRepo(root, dir)).commit()).callDryRun()).rejects.toThrow(
          native.stderr.trimEnd(),
        );
      }
    }, 60_000);

    it("an editor's commit without the status in the template: index_differs_from HEAD (HEAD^1 amending)", async () => {
      const dir = join(root, "r");
      base(dir);
      putFile(dir, "a.txt", "a2\n");
      git(dir, ["commit", "-qam", "second"]);
      // --amend with nothing new staged: the index differs from HEAD^1, so it amends
      await expectCommit(
        dir,
        ["--amend", "--no-status"],
        (c) =>
          c
            .setAmend(true)
            .setIncludeStatus(false)
            .setEditor(async (_p, t) => t),
        "--amend --no-status",
        { GIT_EDITOR: "true" },
      );
      // a squash merge's SQUASH_MSG, nothing staged beyond HEAD: nothing to commit
      git(dir, ["checkout", "-q", "-b", "side", "HEAD~1"]);
      putFile(dir, "c.txt", "c\n");
      git(dir, ["add", "c.txt"]);
      git(dir, ["commit", "-qm", "side"]);
      git(dir, ["checkout", "-q", "main"]);
      git(dir, ["merge", "-q", "--squash", "side"]);
      await expectCommit(
        dir,
        ["--no-status"],
        (c) => c.setIncludeStatus(false).setEditor(async (_p, t) => t),
        "SQUASH_MSG, staged",
        { GIT_EDITOR: "true" },
      );
      git(dir, ["reset", "-q", "--hard"]);
      writeFileSync(join(dir, ".git/SQUASH_MSG"), "squashed\n");
      await expectCommit(
        dir,
        ["--no-status"],
        (c) => c.setIncludeStatus(false).setEditor(async (_p, t) => t),
        "SQUASH_MSG, nothing staged",
        { GIT_EDITOR: "true" },
      );
      // an initial commit of intent-to-add entries only: `cache_nr - ita_nr` is 0, nothing
      // to commit (whatever a status run would count)
      const fresh = join(root, "fresh");
      mkdirSync(fresh, { recursive: true });
      git(fresh, ["init", "-q", "-b", "main"]);
      putFile(fresh, "a.txt", "a\n");
      git(fresh, ["add", "-N", "a.txt"]);
      writeFileSync(join(fresh, ".git/SQUASH_MSG"), "squashed\n");
      const [theirs, mine] = twins(fresh);
      const native = gitRun(root, theirs, ["commit", "--no-status"], { GIT_EDITOR: "true" });
      expect(native.status).toBe(1);
      const error = await (await openRepo(root, mine))
        .commit()
        .setIncludeStatus(false)
        .setEditor(async (_p, t) => t)
        .call()
        .then(
          () => undefined,
          (e: Error) => e,
        );
      expect(error).toBeInstanceOf(EmptyCommitError);
      expect(editmsg(mine)).toBe(editmsg(theirs));

      // the cheap check: the index against the parent's tree, no status run (no worktree
      // directory is listed for untracked files)
      const counted = join(root, "counted");
      base(counted);
      putFile(counted, "a.txt", "a3\n");
      putFile(counted, "untracked/u.txt", "u\n");
      git(counted, ["add", "a.txt"]);
      writeFileSync(join(counted, ".git/SQUASH_MSG"), "squashed\n");
      let listed = 0;
      // every FilesApi call on the worktree (its lstat-cached views too), outside `.git`
      const counting = <T extends object>(files: T): T =>
        new Proxy(files, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            if (typeof value !== "function") return value;
            if (key === "withLstatCache") return () => counting(value.call(target));
            return (path: unknown, ...rest: unknown[]) => {
              if ((key === "list" || key === "listKinds") && typeof path === "string") {
                if (!path.includes(".git")) listed++;
              }
              return value.call(target, path, ...rest);
            };
          },
        });
      const repo = await openOurs(
        counted,
        createNodeGitHostEnvironment({ env: testEnv(root) }),
        counting,
      );
      await repo
        .commit()
        .setIncludeStatus(false)
        .setEditor(async (_p, t) => t)
        .call();
      expect(git(counted, ["log", "-1", "--format=%s"])).toBe("squashed\n");
      expect(listed).toBe(0);
    }, 60_000);
  },
);

describeGit("COMMIT_EDITMSG of the commands that commit: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "commit-editmsg-ops-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A conflict of `side` with `main` on b.txt. */
  function conflicted(dir: string): void {
    base(dir);
    git(dir, ["checkout", "-q", "-b", "side"]);
    putFile(dir, "b.txt", "side\n");
    git(dir, ["commit", "-qam", "side\n\nbody of side"]);
    git(dir, ["checkout", "-q", "main"]);
    putFile(dir, "b.txt", "main\n");
    git(dir, ["commit", "-qam", "main"]);
    rmSync(join(dir, ".git/COMMIT_EDITMSG"), { force: true });
  }

  it("cherry-pick --continue and merge --continue write git commit's", async () => {
    const dir = join(root, "r");
    conflicted(dir);
    const [theirs, mine] = twins(dir);
    for (const d of [theirs, mine]) {
      gitRun(root, d, ["cherry-pick", "side"]);
      putFile(d, "b.txt", "resolved\n");
      git(d, ["add", "b.txt"]);
    }
    expect(gitRun(root, theirs, ["cherry-pick", "--continue"]).status).toBe(0);
    await (await openRepo(root, mine))
      .cherryPick()
      .setOperation(SequencerOperation.CONTINUE)
      .call();
    expect(editmsg(mine), "cherry-pick --continue").toBe(editmsg(theirs));
    expect(editmsg(theirs)).toContain("# Conflicts:");
    expect(git(mine, ["rev-parse", "HEAD"])).toBe(git(theirs, ["rev-parse", "HEAD"]));

    const [theirs2, mine2] = twins(dir);
    for (const d of [theirs2, mine2]) {
      gitRun(root, d, ["merge", "side"]);
      putFile(d, "b.txt", "resolved\n");
      git(d, ["add", "b.txt"]);
    }
    expect(gitRun(root, theirs2, ["merge", "--continue"], { GIT_EDITOR: "true" }).status).toBe(0);
    const merged = await (await openRepo(root, mine2))
      .merge()
      .setOperation(MergeOperation.CONTINUE)
      .call();
    expect(merged.status).toBe(MergeStatus.MERGED);
    expect(editmsg(mine2), "merge --continue").toBe(editmsg(theirs2));
    expect(git(mine2, ["rev-parse", "HEAD"])).toBe(git(theirs2, ["rev-parse", "HEAD"]));
  }, 60_000);

  it("a clean merge, cherry-pick, revert and rebase write none", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["checkout", "-q", "-b", "side"]);
    putFile(dir, "s.txt", "s\n");
    git(dir, ["add", "s.txt"]);
    git(dir, ["commit", "-qm", "side"]);
    git(dir, ["checkout", "-q", "main"]);
    putFile(dir, "m.txt", "m\n");
    git(dir, ["add", "m.txt"]);
    git(dir, ["commit", "-qm", "main"]);
    rmSync(join(dir, ".git/COMMIT_EDITMSG"), { force: true });
    const [theirs, mine] = twins(dir);
    git(theirs, ["merge", "-q", "--no-edit", "side"]);
    git(theirs, ["revert", "--no-edit", "side"]);
    const repo = await openRepo(root, mine);
    const side = git(mine, ["rev-parse", "side"]).trim();
    await repo.merge().include(side).call();
    await repo.revert().include(side).call();
    expect(editmsg(mine)).toBe(editmsg(theirs));
    expect(editmsg(theirs)).toBeUndefined();
    const [theirs2, mine2] = twins(dir);
    git(theirs2, ["cherry-pick", "side"]);
    git(theirs2, ["checkout", "-q", "side"]);
    git(theirs2, ["rebase", "-q", "main"]);
    const repo2 = await openRepo(root, mine2);
    await repo2.cherryPick().include(side).call();
    git(mine2, ["checkout", "-q", "side"]);
    await (await openRepo(root, mine2))
      .rebase()
      .setUpstream(git(mine2, ["rev-parse", "main"]).trim())
      .call();
    expect(editmsg(mine2)).toBe(editmsg(theirs2));
    expect(editmsg(theirs2)).toBeUndefined();
  }, 60_000);
});

describeGit("commit -i / --include: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "commit-include-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("stages the tracked paths named, commits the whole index", async () => {
    const dir = join(root, "r");
    base(dir);
    putFile(dir, "a.txt", "a2\n");
    putFile(dir, "b.txt", "b2\n");
    putFile(dir, "d/c.txt", "c\n");
    git(dir, ["add", "d/c.txt"]);
    putFile(dir, "d/c.txt", "c2\n");
    putFile(dir, "new.txt", "n\n");
    const state = (d: string) =>
      `${git(d, ["show", "--name-status", "--format=%T%n%B", "HEAD"])}${git(d, ["status", "--porcelain"])}`;
    for (const spec of [["a.txt"], ["d"], ["*.txt"], [":(exclude)a.txt", "."]]) {
      await expectCommit(
        dir,
        ["-i", "-m", "include", "--", ...spec],
        (c) => c.setInclude(...spec).setMessage("include"),
        `-i ${spec.join(" ")}`,
      );
      const [theirs, mine] = twins(dir);
      gitRun(root, theirs, ["commit", "-q", "-i", "-m", "include", "--", ...spec]);
      await (await openRepo(root, mine))
        .commit()
        .setInclude(...spec)
        .setMessage("include")
        .call();
      expect(state(mine), spec.join(" ")).toBe(state(theirs));
    }
    // an untracked file is not added: git 2.5x reports the element (2.43 finds nothing to
    // commit)
    if (!is25x) return;
    git(dir, ["add", "-u"]);
    git(dir, ["commit", "-qm", "all"]);
    await expectCommit(
      dir,
      ["-i", "-m", "x", "--", "new.txt"],
      (c) => c.setInclude("new.txt").setMessage("x"),
      "-i untracked",
    );
  }, 120_000);

  it("refusals: with --only paths, with -a, without paths, an element matching nothing", async () => {
    const dir = join(root, "r");
    base(dir);
    putFile(dir, "a.txt", "a2\n");
    const repo = await openRepo(root, dir);
    const cases: [string[], (c: CommitCommand) => CommitCommand][] = [
      [["-i", "-o", "a.txt"], (c) => c.setInclude("a.txt").setOnly("a.txt")],
      [["-i", "-a"], (c) => c.setInclude("a.txt").setAll(true)],
      [["-i"], (c) => c.setInclude()],
    ];
    for (const [args, setup] of cases) {
      const native = gitRun(root, dir, ["commit", "-m", "x", ...args]);
      expect(native.status).toBe(128);
      await expect(setup(repo.commit().setMessage("x")).call(), args.join(" ")).rejects.toThrow(
        native.stderr.trimEnd(),
      );
    }
    const native = gitRun(root, dir, ["commit", "-m", "x", "-a", "a.txt"]);
    expect(native.status).toBe(128);
    expect(() => repo.commit().setAll(true).setOnly("a.txt")).toThrow(native.stderr.trimEnd());
    // git 2.5x reports an element matching no index entry (2.43 commits what is staged)
    if (is25x) {
      const unmatched = gitRun(root, dir, ["commit", "-m", "x", "-i", "nope"]);
      expect(unmatched.status).toBe(128);
      await expect(repo.commit().setMessage("x").setInclude("nope").call()).rejects.toThrow(
        unmatched.stderr.trimEnd(),
      );
      expect(git(dir, ["status", "--porcelain"])).toBe(" M a.txt\n");
    }
  }, 60_000);
});

describeGit("diff.submodule without a value: as native git 2.5x", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "diff-submodule-nonbool-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("status, commit, log and merge die reading git_diff_ui_config (2.43 crashes)", async () => {
    const dir = join(root, "r");
    base(dir);
    writeFileSync(
      join(dir, ".git/config"),
      `${readFileSync(join(dir, ".git/config"), "latin1")}[diff]\n\tsubmodule\n`,
    );
    const repo = await openRepo(root, dir);
    const runs: [string[], () => Promise<unknown>][] = [
      [["status"], () => repo.status().call()],
      [
        ["commit", "--allow-empty", "-m", "x"],
        () => repo.commit().setAllowEmpty(true).setMessage("x").call(),
      ],
      [
        ["log"],
        async () => {
          for await (const _ of await repo.log().call()) {
            // walked
          }
        },
      ],
      [["merge", "HEAD"], () => repo.merge().include("HEAD").call()],
    ];
    for (const [args, ours] of runs) {
      const error = await ours().then(
        () => undefined,
        (e: Error) => e,
      );
      expect(error, args.join(" ")).toBeDefined();
      if (!is25x) continue;
      const native = gitRun(root, dir, args);
      expect(native.status, args.join(" ")).toBe(128);
      expect(`${error?.message}\n`, args.join(" ")).toBe(
        native.stderr.replace(`${dir}/.git/config`, ".git/config"),
      );
    }
  }, 60_000);
});
