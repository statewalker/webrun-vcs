/**
 * `cherry-pick -e` and `revert -e` against native git: the sequencer commits each pick that
 * applies cleanly by running `git commit -n -e` (sequencer.c `run_git_commit` with EDIT_MSG
 * and without VERIFY_MSG), so the message goes through the editor in git commit's template,
 * prepare-commit-msg is told `merge` (MERGE_MSG), post-commit runs and pre-commit and
 * commit-msg do not, with GIT_REFLOG_ACTION set for the hooks. Each case runs native git
 * (an editor script in GIT_EDITOR) in one copy of a repository with logging hooks and ours
 * (an editor callback doing the same) in the other.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Git, SequencerOperation } from "../src/index.js";
import {
  type HookTwin,
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
  "reference-transaction",
];

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/** main: a, b (checked out); side (off a): c, d. */
function base(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  const commit = (name: string) => {
    putFile(dir, name, `${name}\n`);
    git(dir, ["add", name]);
    git(dir, ["commit", "-qm", `add ${name}`]);
  };
  commit("a");
  git(dir, ["branch", "side"]);
  commit("b");
  git(dir, ["checkout", "-q", "side"]);
  commit("c");
  commit("d");
  git(dir, ["checkout", "-q", "main"]);
  installHooks(join(dir, ".git/hooks"), HOOKS);
}

/**
 * Native git's editor: logs the file's name and text, then appends a line (`$EDIT_LINE`, or
 * empties the file when it is `EMPTY`).
 */
function editorScript(): string {
  const path = join(root, "editor.sh");
  writeFileSync(
    path,
    `#!/bin/sh
{ echo "== editor $(basename "$1")"; cat "$1"; } >> "$HOOK_LOG"
if [ "$EDIT_LINE" = EMPTY ]; then : > "$1"; else echo "$EDIT_LINE" >> "$1"; fi
`,
  );
  chmodSync(path, 0o755);
  return path;
}

/** Ours: the same as {@link editorScript}, as an editor callback. */
const editorOf =
  (twin: HookTwin, line: string) =>
  async (path: string, text: string): Promise<string> => {
    appendFileSync(twin.log, `== editor ${path.split("/").pop()}\n${text}`);
    return line === "EMPTY" ? "" : `${text}${line}\n`;
  };

type Picker = (
  g: Git,
  edit: ReturnType<typeof editorOf>,
) => Promise<{ output: string; ok: boolean }>;

async function expectTwins(
  dir: string,
  args: string[],
  run: Picker,
  label: string,
  line = "edited line",
): Promise<void> {
  const [theirs, mine] = hookTwins(root, dir);
  const extra = { GIT_EDITOR: editorScript(), EDIT_LINE: line };
  const native = nativeIn(theirs, root, args, extra);
  const ours = await run(await oursIn(mine, extra), editorOf(mine, line));
  expect(hookLog(mine), `${label}: log`).toBe(hookLog(theirs));
  expect(hookLines(ours.output), `${label}: output`).toBe(hookLines(native.stderr));
  expect(ours.ok, `${label}: ok (${native.stderr})`).toBe(native.status === 0);
  const show = (d: string) =>
    git(d, ["log", "-1", "--format=%H%n%an <%ae> %ad%n%B", "HEAD"]) +
    git(d, ["reflog", "-2", "--format=%gs"]);
  expect(show(mine.dir), `${label}: HEAD`).toBe(show(theirs.dir));
  for (const file of ["CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_MSG", "AUTO_MERGE"]) {
    expect(existsSync(join(mine.dir, ".git", file)), `${label}: ${file}`).toBe(
      existsSync(join(theirs.dir, ".git", file)),
    );
  }
}

describeGit("cherry-pick -e and revert -e: git commit -n -e (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-pick-edit-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("cherry-pick -e: the editor in git commit's template, its hooks, the pick's author", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectTwins(
      dir,
      ["cherry-pick", "-e", "side~1"],
      async (g, edit) => {
        const command = g.cherryPick().include("side~1").setEdit(true).setEditor(edit);
        const result = await command.call();
        return { output: command.getHookOutput(), ok: result.status === "ok" };
      },
      "cherry-pick -e",
    );
  });

  it("cherry-pick -e of two commits: each committed by git commit -e", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectTwins(
      dir,
      ["cherry-pick", "-e", "side~1", "side"],
      async (g, edit) => {
        const command = g
          .cherryPick()
          .include("side~1")
          .include("side")
          .setEdit(true)
          .setEditor(edit);
        const result = await command.call();
        return { output: command.getHookOutput(), ok: result.status === "ok" };
      },
      "cherry-pick -e two",
    );
  });

  it("revert -e and revert --no-edit", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectTwins(
      dir,
      ["revert", "-e", "HEAD"],
      async (g, edit) => {
        const command = g.revert().include("HEAD").setEdit(true).setEditor(edit);
        const result = await command.call();
        return { output: command.getHookOutput(), ok: result.status === "ok" };
      },
      "revert -e",
    );
    await expectTwins(
      dir,
      ["revert", "--no-edit", "HEAD"],
      async (g) => {
        const command = g.revert().include("HEAD").setEdit(false);
        const result = await command.call();
        return { output: command.getHookOutput(), ok: result.status === "ok" };
      },
      "revert --no-edit",
    );
  });

  it("an editor that empties the message: nothing committed, the pick left in progress", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectTwins(
      dir,
      ["cherry-pick", "-e", "side~1"],
      async (g, edit) => {
        const command = g.cherryPick().include("side~1").setEdit(true).setEditor(edit);
        const result = await command.call();
        return { output: command.getHookOutput(), ok: result.status === "ok" };
      },
      "emptied",
      "EMPTY",
    );
  });
});

/**
 * main: x (1), y, x (3), checked out; side (off the first commit): c, x (2), d. Picking
 * side~2..side conflicts on side~1, reverting main~2 (x two) on x.
 */
function conflictBase(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  const commit = (name: string, text: string, subject: string) => {
    putFile(dir, name, text);
    git(dir, ["add", name]);
    git(dir, ["commit", "-qm", subject]);
  };
  commit("x", "1\n", "x one");
  git(dir, ["branch", "side"]);
  commit("x", "2\n", "x two");
  commit("y", "y\n", "add y");
  commit("x", "3\n", "x three");
  git(dir, ["checkout", "-q", "side"]);
  commit("c", "c\n", "add c");
  commit("x", "side\n", "x side");
  commit("d", "d\n", "add d");
  git(dir, ["checkout", "-q", "main"]);
  installHooks(join(dir, ".git/hooks"), HOOKS);
}

type Starter = (g: Git, edit: ReturnType<typeof editorOf>) => Promise<{ output: string }>;

/**
 * A run that stops at a conflict (`args` in native git, `start` in ours), `x` resolved and
 * added in both, then `--continue` (`command` names cherry-pick or revert): the opts saved,
 * the hook logs (the editor's texts in them), hook output, the commits and their reflog.
 */
async function expectContinueTwins(
  dir: string,
  command: "cherry-pick" | "revert",
  args: string[],
  start: Starter,
  label: string,
): Promise<void> {
  const [theirs, mine] = hookTwins(root, dir);
  const line = "edited line";
  const extra = { GIT_EDITOR: editorScript(), EDIT_LINE: line };
  const native = nativeIn(theirs, root, args, extra);
  const g = await oursIn(mine, extra);
  const ours = await start(g, editorOf(mine, line));
  expect(native.status, `${label}: native stops (${native.stderr})`).not.toBe(0);
  const opts = (d: string) => {
    const path = join(d, ".git/sequencer/opts");
    return existsSync(path) ? readFileSync(path, "latin1") : "<none>";
  };
  expect(opts(mine.dir), `${label}: sequencer/opts`).toBe(opts(theirs.dir));
  for (const twin of [theirs, mine]) {
    putFile(twin.dir, "x", "resolved\n");
    git(twin.dir, ["add", "x"]);
  }
  const nativeContinue = nativeIn(theirs, root, [command, "--continue"], extra);
  const g2 = await oursIn(mine, extra);
  const next = command === "cherry-pick" ? g2.cherryPick() : g2.revert();
  next.setOperation(SequencerOperation.CONTINUE).setEditor(editorOf(mine, line));
  const result = await next.call();
  expect(hookLog(mine), `${label}: log`).toBe(hookLog(theirs));
  expect(hookLines(ours.output + next.getHookOutput()), `${label}: output`).toBe(
    hookLines(native.stderr + nativeContinue.stderr),
  );
  expect(result.status === "ok", `${label}: ok (${nativeContinue.stderr})`).toBe(
    nativeContinue.status === 0,
  );
  const show = (d: string) =>
    git(d, ["log", "-4", "--format=%H%n%an <%ae> %ad%n%B", "HEAD"]) +
    git(d, ["reflog", "-4", "--format=%gs"]);
  expect(show(mine.dir), `${label}: HEAD`).toBe(show(theirs.dir));
  for (const file of ["CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_MSG", "AUTO_MERGE", "sequencer"]) {
    expect(existsSync(join(mine.dir, ".git", file)), `${label}: ${file}`).toBe(
      existsSync(join(theirs.dir, ".git", file)),
    );
  }
}

describeGit("cherry-pick -e and revert -e through a conflict (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-pick-edit-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("cherry-pick -e: options.edit saved, --continue commits the conflict with git commit's editor", async () => {
    const dir = join(root, "r");
    conflictBase(dir);
    await expectContinueTwins(
      dir,
      "cherry-pick",
      ["cherry-pick", "-e", "side~2", "side~1", "side"],
      async (g, edit) => {
        const command = g
          .cherryPick()
          .include("side~2")
          .include("side~1")
          .include("side")
          .setEdit(true)
          .setEditor(edit);
        await command.call();
        return { output: command.getHookOutput() };
      },
      "cherry-pick -e continue",
    );
  });

  it("cherry-pick --no-edit: options.edit = false, --continue without the editor", async () => {
    const dir = join(root, "r");
    conflictBase(dir);
    await expectContinueTwins(
      dir,
      "cherry-pick",
      ["cherry-pick", "--no-edit", "side~2", "side~1", "side"],
      async (g, edit) => {
        const command = g
          .cherryPick()
          .include("side~2")
          .include("side~1")
          .include("side")
          .setEdit(false)
          .setEditor(edit);
        await command.call();
        return { output: command.getHookOutput() };
      },
      "cherry-pick --no-edit continue",
    );
  });

  it("revert -e: --continue commits the conflict with git commit's editor, then edits the rest", async () => {
    const dir = join(root, "r");
    conflictBase(dir);
    await expectContinueTwins(
      dir,
      "revert",
      ["revert", "-e", "HEAD~2", "HEAD~1"],
      async (g, edit) => {
        const command = g
          .revert()
          .include("HEAD~2")
          .include("HEAD~1")
          .setEdit(true)
          .setEditor(edit);
        await command.call();
        return { output: command.getHookOutput() };
      },
      "revert -e continue",
    );
  });
});

describeGit("a clean pick whose commit fails: HEAD's lock held (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-pick-locked-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function compare(
    args: string[],
    run: (g: Git) => Promise<unknown>,
    setup?: (dir: string) => void,
  ): Promise<void> {
    const dir = join(root, "r");
    base(dir);
    setup?.(dir);
    const [theirs, mine] = hookTwins(root, dir);
    for (const t of [theirs, mine]) writeFileSync(join(t.dir, ".git/refs/heads/main.lock"), "");
    const native = nativeIn(theirs, root, args);
    let error: unknown;
    try {
      await run(await oursIn(mine));
    } catch (e) {
      error = e;
    }
    const label = args.join(" ");
    expect(native.status, `${label}: native fails`).not.toBe(0);
    expect(error, label).toBeInstanceOf(Error);
    const thrown = error as Error & { exitCode?: number };
    expect(thrown.name, `${label}: error`).toBe("GitApiError");
    expect(thrown.exitCode, `${label}: exit code`).toBe(native.status);
    const stderr = native.stderr
      .split("\n")
      .filter((l) => !/^hook \S+ (out|err)$/.test(l))
      .join("\n")
      .replace(/\n+$/, "")
      .replaceAll(theirs.dir, "<twin>");
    expect(thrown.message.replaceAll(mine.dir, "<twin>"), `${label}: stderr`).toBe(stderr);
    expect(hookLog(mine), `${label}: log`).toBe(hookLog(theirs));
    for (const file of ["CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_MSG", "ORIG_HEAD"]) {
      const read = (d: string) => {
        const path = join(d, ".git", file);
        return existsSync(path) ? readFileSync(path, "latin1") : "(none)";
      };
      expect(read(mine.dir), `${label}: ${file}`).toBe(read(theirs.dir));
    }
    const state = (d: string) =>
      git(d, ["status", "--porcelain"]) + git(d, ["for-each-ref"]) + git(d, ["rev-parse", "HEAD"]);
    expect(state(mine.dir), `${label}: state`).toBe(state(theirs.dir));
    expect(existsSync(join(mine.dir, ".git/refs/heads/main.lock")), `${label}: lock kept`).toBe(
      true,
    );
  }

  it("cherry-pick: CHERRY_PICK_HEAD and MERGE_MSG left, git's lock error", async () => {
    await compare(["cherry-pick", "side"], (g) => g.cherryPick().include("side").call());
  });

  it("revert: MERGE_MSG left, git's lock error", async () => {
    await compare(["revert", "HEAD"], (g) => g.revert().include("HEAD").call());
  });
});
