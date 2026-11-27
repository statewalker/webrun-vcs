/**
 * The sequence editor as a program (git's `launch_sequence_editor`): without an interactive
 * handler's `editTodo`, `git rebase -i` runs `$GIT_SEQUENCE_EDITOR`, else `sequence.editor`,
 * else git's editor (`$GIT_EDITOR`, `core.editor`, ...), over `rebase-merge/git-rebase-todo`
 * through the host's hook runner. The order follows t7005-editor.sh's for the commit editor,
 * the sequence editor's own variable first (t3404-rebase-interactive.sh drives every
 * interactive rebase through `GIT_SEQUENCE_EDITOR`). Native git and ours each rebase their
 * own copy of one history.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RebaseStatus } from "../src/index.js";
import { type HookTwin, hookTwins, nativeIn, oursIn } from "./hooks-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, putFile } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() ? describe : describe.skip;

let root: string;

/** Three commits `c1`..`c3` on `main`. */
function history(name: string): [HookTwin, HookTwin] {
  const dir = join(root, name);
  gitOut(root, root, ["init", "-q", "-b", "main", dir]);
  for (const n of [1, 2, 3]) {
    putFile(dir, `f${n}`, `${n}\n`);
    gitOut(root, dir, ["add", "."]);
    gitOut(root, dir, ["commit", "-q", "-m", `c${n}`]);
  }
  return hookTwins(root, dir);
}

const subjects = (twin: HookTwin) => gitOut(root, twin.dir, ["log", "--format=%s"]);

/** Drops the first todo line: a sed script as GIT_SEQUENCE_EDITOR would name it */
const DROP_FIRST = "sed -i 1s/^pick/drop/";
/** Rewords nothing, but marks the second line `drop` */
const DROP_SECOND = "sed -i 2s/^pick/drop/";

/** Our `rebase -i HEAD~2` in a twin with `extra` variables. */
async function oursRebase(twin: HookTwin, extra: Record<string, string>) {
  const git = await oursIn(twin, extra);
  return git.rebase().setUpstream("HEAD~2").runInteractively({}).call();
}

describeGit("sequence editor program twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sequence-editor-twins-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it("GIT_SEQUENCE_EDITOR edits the todo list", async () => {
    const [native, ours] = history("sequence-env");
    const env = { GIT_SEQUENCE_EDITOR: DROP_FIRST, GIT_EDITOR: "false" };
    const r = nativeIn(native, root, ["rebase", "-i", "HEAD~2"], env);
    expect(r.status).toBe(0);
    const result = await oursRebase(ours, env);
    expect(result.status).toBe(RebaseStatus.OK);
    expect(subjects(ours)).toBe(subjects(native));
    expect(subjects(ours)).toBe("c3\nc1\n");
  });

  it("GIT_SEQUENCE_EDITOR wins over sequence.editor, which wins over GIT_EDITOR", async () => {
    const [native, ours] = history("sequence-order");
    for (const twin of [native, ours]) {
      gitOut(root, twin.dir, ["config", "sequence.editor", DROP_SECOND]);
    }
    // sequence.editor over GIT_EDITOR
    const env = { GIT_EDITOR: DROP_FIRST };
    expect(nativeIn(native, root, ["rebase", "-i", "HEAD~2"], env).status).toBe(0);
    expect((await oursRebase(ours, env)).status).toBe(RebaseStatus.OK);
    expect(subjects(ours)).toBe(subjects(native));
    expect(subjects(ours)).toBe("c2\nc1\n");
  });

  it("GIT_SEQUENCE_EDITOR wins over sequence.editor", async () => {
    const [native, ours] = history("sequence-env-over-config");
    for (const twin of [native, ours]) {
      gitOut(root, twin.dir, ["config", "sequence.editor", "false"]);
    }
    const env = { GIT_SEQUENCE_EDITOR: DROP_FIRST };
    expect(nativeIn(native, root, ["rebase", "-i", "HEAD~2"], env).status).toBe(0);
    expect((await oursRebase(ours, env)).status).toBe(RebaseStatus.OK);
    expect(subjects(ours)).toBe(subjects(native));
  });

  it("GIT_EDITOR edits the todo list without a sequence editor", async () => {
    const [native, ours] = history("git-editor");
    const env = { GIT_EDITOR: DROP_FIRST };
    expect(nativeIn(native, root, ["rebase", "-i", "HEAD~2"], env).status).toBe(0);
    expect((await oursRebase(ours, env)).status).toBe(RebaseStatus.OK);
    expect(subjects(ours)).toBe(subjects(native));
    expect(subjects(ours)).toBe("c3\nc1\n");
  });

  it("a failing sequence editor stops the rebase before it starts", async () => {
    const [native, ours] = history("failing-editor");
    const env = { GIT_SEQUENCE_EDITOR: "false" };
    const r = nativeIn(native, root, ["rebase", "-i", "HEAD~2"], env);
    expect(r.status).not.toBe(0);
    const result = await oursRebase(ours, env);
    expect(result.status).toBe(RebaseStatus.FAILED);
    expect(result.message).toBe(r.stderr.trim());
    expect(subjects(ours)).toBe(subjects(native));
    for (const twin of [native, ours]) {
      expect(gitOut(root, twin.dir, ["status", "--porcelain=v2", "--branch"])).not.toContain(
        "rebase",
      );
    }
  });
});
