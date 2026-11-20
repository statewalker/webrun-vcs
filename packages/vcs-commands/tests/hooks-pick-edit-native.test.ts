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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
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
