/**
 * The hooks of rebase, cherry-pick and revert against native git: pre-rebase (builtin/rebase.c,
 * told the upstream as given; a refusal stops the rebase, `--no-verify` skips it), the
 * post-checkout of the checkout of onto, the sequencer's prepare-commit-msg and post-commit
 * around each pick (sequencer.c `try_to_commit`), and post-rewrite told "rebase" with the
 * rewritten list on stdin. Each case runs native git in one copy of a repository with
 * logging hooks and ours (with the Node hook runner) in the other.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Git, RebaseOperation, RebaseStatus } from "../src/index.js";
import {
  type HookTwin,
  hookEdit,
  hookExit,
  hookLines,
  hookLog,
  hookTwins,
  installHooks,
  nativeIn,
  oursIn,
} from "./hooks-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const HOOKS = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "post-rewrite",
  "post-checkout",
  "pre-rebase",
  "post-merge",
];

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/** main: a, b; side (off a): c, d (checked out). */
function base(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  const commit = (name: string) => {
    putFile(dir, name, `${name}\n`);
    git(dir, ["add", name]);
    git(dir, ["commit", "-qm", name]);
  };
  commit("a");
  git(dir, ["branch", "side"]);
  commit("b");
  git(dir, ["checkout", "-q", "side"]);
  commit("c");
  commit("d");
  installHooks(join(dir, ".git/hooks"), HOOKS);
}

async function expectTwins(
  dir: string,
  args: string[],
  run: (git: Git) => Promise<{ output: string; failed: boolean; message?: string }>,
  label: string,
  prepare?: (twin: HookTwin) => void,
): Promise<void> {
  const [theirs, mine] = hookTwins(root, dir);
  prepare?.(theirs);
  prepare?.(mine);
  const native = nativeIn(theirs, root, args);
  const ours = await run(await oursIn(mine));
  expect(hookLog(mine), `${label}: log`).toBe(hookLog(theirs));
  expect(hookLines(ours.output), `${label}: output`).toBe(hookLines(native.stderr));
  expect(ours.failed, `${label}: failed (${native.stderr})`).toBe(native.status !== 0);
  if (ours.message?.includes("The pre-rebase")) {
    expect(native.stderr).toContain(ours.message);
  }
  for (const rev of ["HEAD", "side", "main"]) {
    expect(git(mine.dir, ["rev-parse", rev]), `${label}: ${rev}`).toBe(
      git(theirs.dir, ["rev-parse", rev]),
    );
  }
}

const rebase =
  (setup: (r: ReturnType<Git["rebase"]>) => void = () => {}) =>
  async (g: Git) => {
    const command = g.rebase().setUpstream("main");
    setup(command);
    const result = await command.call();
    return {
      output: command.getHookOutput(),
      failed: result.status === RebaseStatus.FAILED,
      ...(result.message ? { message: result.message } : {}),
    };
  };

describeGit("rebase, cherry-pick and revert hooks: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-rebase-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("rebase: pre-rebase, post-checkout, the picks' hooks and post-rewrite", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectTwins(dir, ["rebase", "-q", "main"], rebase(), "rebase main");
  });

  it("rebase: a refusing pre-rebase stops it; --no-verify skips the hook", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectTwins(dir, ["rebase", "-q", "main"], rebase(), "pre-rebase exit 1", (t) =>
      hookExit(t, "pre-rebase", 1),
    );
    await expectTwins(
      dir,
      ["rebase", "-q", "--no-verify", "main"],
      rebase((r) => r.setNoVerify(true)),
      "--no-verify",
      (t) => hookExit(t, "pre-rebase", 1),
    );
  });

  it("rebase: a fast-forward runs pre-rebase and post-checkout", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["reset", "-q", "--hard", "HEAD~1"]);
    git(dir, ["checkout", "-q", "side"]);
    git(dir, ["branch", "-f", "main", "side"]);
    git(dir, ["reset", "-q", "--hard", "HEAD~1"]);
    await expectTwins(dir, ["rebase", "-q", "main"], rebase(), "fast-forward");
  });

  it("cherry-pick and revert: prepare-commit-msg and post-commit per commit", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["checkout", "-q", "main"]);
    await expectTwins(
      dir,
      ["cherry-pick", "side~1", "side"],
      async (g) => {
        const command = g.cherryPick().include("side~1").include("side");
        const result = await command.call();
        return { output: command.getHookOutput(), failed: result.status !== "ok" };
      },
      "cherry-pick",
    );
    await expectTwins(
      dir,
      ["revert", "--no-edit", "HEAD"],
      async (g) => {
        const command = g.revert().include("HEAD");
        const result = await command.call();
        return { output: command.getHookOutput(), failed: result.status !== "ok" };
      },
      "revert",
    );
  });
});

describeGit("rebase -i hooks: reword and edit (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-rebase-i-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A sequence editor turning the pick of `subject` (`# subject` in 2.5x) into `action`. */
  function sequenceEditor(action: string, subject: string): string {
    const path = join(root, `seq-${action}-${subject}.sh`);
    writeFileSync(
      path,
      `#!/bin/sh\nsed -i 's/^pick \\([0-9a-f]*\\) \\(# \\)\\{0,1\\}${subject}$/${action} \\1 ${subject}/' "$1"\n`,
      { mode: 0o755 },
    );
    return path;
  }

  /** Our interactive rebase onto main with the todo edited as the sequence editor does. */
  function interactive(g: Git, action: string, subject: string) {
    const command = g.rebase().setUpstream("main");
    command.runInteractively({
      editTodo: (text) =>
        text.replace(
          new RegExp(`^pick ([0-9a-f]+) (?:# )?${subject}$`, "m"),
          `${action} $1 ${subject}`,
        ),
      modifyCommitMessage: (text) => text,
    });
    return command;
  }

  /** The editor of both sides: `true` (a hook given `GIT_EDITOR=:` shows no editor ran). */
  const EDITOR = { GIT_EDITOR: "true" };

  it("reword: the pick's hooks, then git commit --amend -e's (pre-commit, prepare-commit-msg [commit HEAD], commit-msg, post-commit, post-rewrite [amend])", async () => {
    const dir = join(root, "r");
    base(dir);
    const [theirs, mine] = hookTwins(root, dir);
    for (const t of [theirs, mine]) {
      hookEdit(t, "commit-msg", "\nSigned-off-by: Hook <hook@example.com>\n");
    }
    const native = nativeIn(theirs, root, ["rebase", "-q", "-i", "main"], {
      GIT_SEQUENCE_EDITOR: sequenceEditor("reword", "d"),
      ...EDITOR,
    });
    expect(native.status, native.stderr).toBe(0);
    const command = interactive(await oursIn(mine, EDITOR), "reword", "d");
    const result = await command.call();
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    expect(hookLog(mine), "log").toBe(hookLog(theirs));
    expect(hookLines(command.getHookOutput()), "output").toBe(hookLines(native.stderr));
    for (const args of [
      ["rev-parse", "HEAD"],
      ["log", "-1", "--format=%B"],
    ]) {
      expect(git(mine.dir, args), args.join(" ")).toBe(git(theirs.dir, args));
    }
  });

  it("edit, then --continue with staged changes: git commit --amend's hooks (no pre-commit or commit-msg: -n)", async () => {
    const dir = join(root, "r");
    base(dir);
    const [theirs, mine] = hookTwins(root, dir);
    const env = { GIT_SEQUENCE_EDITOR: sequenceEditor("edit", "c"), ...EDITOR };
    const stopped = nativeIn(theirs, root, ["rebase", "-q", "-i", "main"], env);
    expect(stopped.status, stopped.stderr).toBe(0);
    const first = interactive(await oursIn(mine, EDITOR), "edit", "c");
    expect((await first.call()).status).toBe(RebaseStatus.EDIT);
    for (const t of [theirs, mine]) {
      putFile(t.dir, "c", "c edited\n");
      git(t.dir, ["add", "c"]);
    }
    const native = nativeIn(theirs, root, ["rebase", "--continue"], env);
    expect(native.status, native.stderr).toBe(0);
    const command = (await oursIn(mine, EDITOR)).rebase().setOperation(RebaseOperation.CONTINUE);
    command.runInteractively({ modifyCommitMessage: (text) => text });
    const result = await command.call();
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    expect(hookLog(mine), "log").toBe(hookLog(theirs));
    expect(hookLines(first.getHookOutput() + command.getHookOutput()), "output").toBe(
      hookLines(stopped.stderr + native.stderr),
    );
    expect(git(mine.dir, ["rev-parse", "HEAD"])).toBe(git(theirs.dir, ["rev-parse", "HEAD"]));
  });
});
