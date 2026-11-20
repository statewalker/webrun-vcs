/**
 * The reference-transaction hook against native git (refs.c `run_transaction_hook`): the
 * states of a ref store batch (`preparing` in 2.5x only, `prepared`, `committed`) with an
 * `<old> <new> <ref>` line per update (2.43 also lists HEAD, the symbolic ref a commit goes
 * through), a refusal in `prepared` aborting the update (the `aborted` state, git's fatal
 * message). Each case runs native git in one copy of a repository with a logging hook and
 * ours (with the Node hook runner) in the other.
 *
 * Only the files store's batches run the hook: native git 2.5x also runs it for the
 * deletion of AUTO_MERGE a commit makes (a transaction that ends `aborted`), which ours
 * writes without one, so those transactions are left out of native's log here.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RefTransactionAbortedError } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
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

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

function base(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, "a.txt", "a\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  installHooks(join(dir, ".git/hooks"), ["reference-transaction"]);
}

/** A log's entries (one per hook run), those about AUTO_MERGE left out. */
const entries = (log: string) =>
  log
    .split(/(?=^== )/m)
    .filter((e) => e && !/ AUTO_MERGE$/m.test(e))
    .join("");

async function expectTwins(
  dir: string,
  args: string[],
  run: (git: Git) => Promise<{ output: string; error?: Error }>,
  label: string,
  prepare?: (twin: HookTwin) => void,
): Promise<void> {
  const [theirs, mine] = hookTwins(root, dir);
  prepare?.(theirs);
  prepare?.(mine);
  const native = nativeIn(theirs, root, args);
  const ours = await run(await oursIn(mine));
  expect(entries(hookLog(mine)), `${label}: log`).toBe(entries(hookLog(theirs)));
  expect(ours.error !== undefined, `${label}: failed (${native.stderr})`).toBe(native.status !== 0);
  if (ours.error) {
    expect(ours.error).toBeInstanceOf(RefTransactionAbortedError);
    expect(native.stderr).toContain(`fatal: ${ours.error.message}`);
  } else if (!/AUTO_MERGE/.test(hookLog(theirs))) {
    expect(hookLines(ours.output), `${label}: output`).toBe(hookLines(native.stderr));
  }
  expect(git(mine.dir, ["for-each-ref"]), `${label}: refs`).toBe(git(theirs.dir, ["for-each-ref"]));
}

/** Runs a command, its hook output and its failure. */
async function attempt(command: {
  call(): Promise<unknown>;
  getHookOutput(): string;
}): Promise<{ output: string; error?: Error }> {
  try {
    await command.call();
    return { output: command.getHookOutput() };
  } catch (error) {
    return { output: command.getHookOutput(), error: error as Error };
  }
}

describeGit("reference-transaction hook: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-reftx-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a branch and a tag created: prepared and committed (preparing in 2.5x)", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectTwins(
      dir,
      ["branch", "topic"],
      (g) => attempt(g.branchCreate().setName("topic")),
      "branch",
    );
    await expectTwins(dir, ["tag", "v1"], (g) => attempt(g.tag().setName("v1")), "tag");
  });

  it("a commit: the update of HEAD (and the branch it names)", async () => {
    const dir = join(root, "r");
    base(dir);
    putFile(dir, "a.txt", "a2\n");
    git(dir, ["add", "a.txt"]);
    await expectTwins(
      dir,
      ["commit", "-qm", "two"],
      (g) => attempt(g.commit().setMessage("two")),
      "commit",
    );
  });

  it("a refusal in prepared aborts the update", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectTwins(
      dir,
      ["branch", "topic"],
      (g) => attempt(g.branchCreate().setName("topic")),
      "refused",
      (t) => hookExit(t, "reference-transaction", 1),
    );
  });
});
