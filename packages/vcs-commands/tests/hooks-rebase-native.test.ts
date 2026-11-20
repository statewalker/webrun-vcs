/**
 * The hooks of rebase, cherry-pick and revert against native git: pre-rebase (builtin/rebase.c,
 * told the upstream as given; a refusal stops the rebase, `--no-verify` skips it), the
 * post-checkout of the checkout of onto, the sequencer's prepare-commit-msg and post-commit
 * around each pick (sequencer.c `try_to_commit`), and post-rewrite told "rebase" with the
 * rewritten list on stdin. Each case runs native git in one copy of a repository with
 * logging hooks and ours (with the Node hook runner) in the other.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Git, RebaseStatus } from "../src/index.js";
import {
  type HookTwin,
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
