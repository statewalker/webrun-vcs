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
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RefTransactionAbortedError, type RefTransactionHook } from "@statewalker/vcs-core";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Git, HookSession, refTransactionHookOf } from "../src/index.js";
import {
  type HookTwin,
  hookExit,
  hookLines,
  hookLog,
  hookTwins,
  installHooks,
  nativeIn,
  nativeIs25x,
  oursIn,
} from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, putFile, testEnv } from "./status-native-support.js";

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

/**
 * A reference-transaction hook that logs its state and stdin; once `committed`, the lock
 * files of the git directory (git runs it after the locks are released: none) and, outside
 * a nested run, an update of HEAD to where it is (which a held lock would refuse) with its
 * exit status.
 */
const AFTER_LOCKS_HOOK = `#!/bin/sh
echo "== $1" >> "$HOOK_LOG"
input=$(cat)
echo "$input" >> "$HOOK_LOG"
# (not for git 2.5x's deletion of AUTO_MERGE, which ours makes without the hook)
if [ "$1" = committed ] && [ -z "$NESTED" ] && ! echo "$input" | grep -q AUTO_MERGE; then
  find .git -name '*.lock' | sort >> "$HOOK_LOG"
  NESTED=1 git update-ref HEAD "$(git rev-parse HEAD)" >> "$HOOK_LOG" 2>&1
  echo "update-ref: $?" >> "$HOOK_LOG"
fi
exit 0
`;

describeGit("reference-transaction hook: after the locks, and deletions (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-reftx2-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("committed runs once the ref locks are released: no lock file, HEAD can be updated", async () => {
    const dir = join(root, "r");
    base(dir);
    writeFileSync(join(dir, ".git/hooks/reference-transaction"), AFTER_LOCKS_HOOK, {
      mode: 0o755,
    });
    await expectTwins(
      dir,
      ["branch", "topic"],
      (g) => attempt(g.branchCreate().setName("topic")),
      "branch",
    );
    putFile(dir, "a.txt", "a2\n");
    git(dir, ["add", "a.txt"]);
    await expectTwins(
      dir,
      ["commit", "-qm", "two"],
      (g) => attempt(g.commit().setMessage("two")),
      "commit",
    );
  });

  it("branch -d, tag -d and remote set-head -d: git's deletion transactions, packed or loose", async () => {
    const dir = join(root, "r");
    base(dir);
    for (const name of ["packed", "loose-later"]) git(dir, ["branch", name]);
    git(dir, ["tag", "t-packed"]);
    git(dir, ["pack-refs", "--all"]);
    git(dir, ["branch", "loose"]);
    git(dir, ["tag", "t-loose"]);
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const cases: Array<[string[], (g: Git) => Promise<{ output: string; error?: Error }>]> = [
      [["branch", "-d", "loose"], (g) => attempt(g.branchDelete().setBranchNames("loose"))],
      [["branch", "-d", "packed"], (g) => attempt(g.branchDelete().setBranchNames("packed"))],
      [
        ["branch", "-D", "loose-later"],
        (g) => attempt(g.branchDelete().setBranchNames("loose-later").setForce(true)),
      ],
      [["tag", "-d", "t-loose"], (g) => attempt(g.tagDelete().setTags("t-loose"))],
      [["tag", "-d", "t-packed"], (g) => attempt(g.tagDelete().setTags("t-packed"))],
      [
        ["remote", "set-head", "origin", "-d"],
        (g) => attempt(g.remoteSetHead().setRemoteName("origin").setDelete(true)),
      ],
    ];
    for (const [args, run] of cases) await expectTwins(dir, args, run, args.join(" "));
  });

  it("a refusal in prepared aborts a deletion", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["branch", "topic"]);
    await expectTwins(
      dir,
      ["branch", "-d", "topic"],
      (g) => attempt(g.branchDelete().setBranchNames("topic")),
      "refused deletion",
      (t) => hookExit(t, "reference-transaction", 1),
    );
  });
});

describeGit("reference-transaction hook: a deletion failing on a held lock (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-reftx-held-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // git frees the failed transaction without ref_transaction_abort: the hook hears no
  // `aborted` for it, only for the packed store's transaction files_transaction_cleanup
  // gives up when packed-refs.lock is held
  it("a held ref lock or packed-refs.lock: update-ref -d, branch -D and a batch of deletions", async () => {
    type Store = {
      setTransactionHook(hook: RefTransactionHook | undefined): void;
      remove(name: string): Promise<boolean>;
      batch(commands: Array<{ name: string; new: null }>): Promise<{ ok: boolean }>;
    };
    const ops: Array<[string, string[], string | undefined, (g: Git) => Promise<unknown>]> = [
      [
        "update-ref -d",
        ["update-ref", "-d", "refs/heads/topic"],
        undefined,
        (g) => (g.workingCopy.history.refs as unknown as Store).remove("refs/heads/topic"),
      ],
      [
        "branch -D",
        ["branch", "-D", "topic"],
        undefined,
        (g) => g.branchDelete().setBranchNames("topic").setForce(true).call(),
      ],
      [
        "update-ref --stdin",
        ["update-ref", "--stdin"],
        "delete refs/heads/topic\ndelete refs/heads/other\n",
        (g) =>
          (g.workingCopy.history.refs as unknown as Store).batch([
            { name: "refs/heads/topic", new: null },
            { name: "refs/heads/other", new: null },
          ]),
      ],
    ];
    for (const held of ["refs/heads/topic.lock", "packed-refs.lock"]) {
      for (const packed of [false, true]) {
        const dir = join(root, `r-${held.length}-${packed}`);
        base(dir);
        git(dir, ["branch", "topic"]);
        git(dir, ["branch", "other"]);
        if (packed) git(dir, ["pack-refs", "--all"]);
        // (native gives up on packed-refs.lock at once; ours waits its default second)
        git(dir, ["config", "core.packedRefsTimeout", "0"]);
        for (const [label, args, input, run] of ops) {
          const name = `${held} packed=${packed} ${label}`;
          const [theirs, mine] = hookTwins(root, dir);
          for (const t of [theirs, mine]) writeFileSync(join(t.dir, ".git", held), "");
          const native = spawnSync("git", args, {
            cwd: theirs.dir,
            env: theirs.env,
            input: input ?? "",
          });
          expect(native.status, name).not.toBe(0);
          const g = await oursIn(mine);
          const store = g.workingCopy.history.refs as unknown as Store;
          const session = new HookSession(g.workingCopy);
          store.setTransactionHook(refTransactionHookOf(session));
          let failed = false;
          try {
            const result = await run(g);
            failed = (result as { ok?: boolean } | undefined)?.ok === false;
          } catch {
            failed = true;
          }
          store.setTransactionHook(undefined);
          expect(failed, name).toBe(true);
          expect(hookLog(mine), name).toBe(hookLog(theirs));
          rmSync(join(theirs.dir, ".git", held));
          rmSync(join(mine.dir, ".git", held));
          // (git 2.43's delete_refs drops a packed ref before it finds its loose ref locked;
          // ours deletes nothing then)
          if (nativeIs25x || held === "packed-refs.lock" || label !== "branch -D") {
            expect(git(mine.dir, ["for-each-ref"]), name).toBe(git(theirs.dir, ["for-each-ref"]));
          }
        }
      }
    }
  }, 60_000);
});

describeGit("reference-transaction hook: installed only while the command runs", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-reftx3-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a ref written after the command ends runs no hook of that command", async () => {
    const dir = join(root, "r");
    base(dir);
    const [, mine] = hookTwins(root, dir);
    const g = await oursIn(mine);
    const command = g.branchCreate().setName("topic");
    await command.call();
    const logged = hookLog(mine);
    const outputBefore = command.getHookOutput();
    expect(logged).toContain("[committed]");
    const head = git(mine.dir, ["rev-parse", "HEAD"]).trim();
    await g.workingCopy.history.refs.set("refs/heads/later", head);
    expect(hookLog(mine)).toBe(logged);
    expect(command.getHookOutput()).toBe(outputBefore);
    const store = g.workingCopy.history.refs as { getTransactionHook?(): unknown };
    expect(store.getTransactionHook?.()).toBeUndefined();
  });

  it("a command without hooks leaves a hook someone else set on the store", async () => {
    const dir = join(root, "r");
    base(dir);
    const g = await openOurs(dir, createNodeGitHostEnvironment({ env: testEnv(root) }));
    const store = g.workingCopy.history.refs as unknown as {
      setTransactionHook(hook: RefTransactionHook | undefined): void;
      getTransactionHook(): RefTransactionHook | undefined;
    };
    const states: string[] = [];
    const foreign: RefTransactionHook = async (state) => {
      states.push(state);
      return true;
    };
    store.setTransactionHook(foreign);
    await g.branchCreate().setName("topic").call();
    expect(store.getTransactionHook()).toBe(foreign);
    expect(states).toContain("committed");
  });
});
