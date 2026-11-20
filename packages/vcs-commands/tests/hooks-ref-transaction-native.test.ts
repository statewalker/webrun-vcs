/**
 * The reference-transaction hook against native git (refs.c `run_transaction_hook`): the
 * states of a ref store batch (`preparing` in 2.5x only, `prepared`, `committed`) with an
 * `<old> <new> <ref>` line per update (2.43 also lists HEAD, the symbolic ref a commit goes
 * through), a refusal in `prepared` aborting the update (the `aborted` state, git's fatal
 * message). Each case runs native git in one copy of a repository with a logging hook and
 * ours (with the Node hook runner) in the other.
 *
 * The root refs git updates in transactions run it too: a commit deletes AUTO_MERGE (git
 * 2.5x only: 2.43 removes the file), whether it exists or not.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RefTransactionAbortedError, type RefTransactionHook } from "@statewalker/vcs-core";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Git,
  HookSession,
  RebaseOperation,
  ResetMode,
  refTransactionHookOf,
  SequencerOperation,
} from "../src/index.js";
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
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

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
  expect(hookLog(mine), `${label}: log`).toBe(hookLog(theirs));
  expect(ours.error !== undefined, `${label}: failed (${native.stderr})`).toBe(native.status !== 0);
  if (ours.error) {
    expect(ours.error).toBeInstanceOf(RefTransactionAbortedError);
    expect(native.stderr).toContain(`fatal: ${ours.error.message}`);
  } else {
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
if [ "$1" = committed ] && [ -z "$NESTED" ]; then
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
          // (git 2.43's delete_refs drops a packed ref before it finds its loose ref locked)
          expect(git(mine.dir, ["for-each-ref"]), name).toBe(git(theirs.dir, ["for-each-ref"]));
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

/**
 * What a ref deletion leaves in a git directory: the refs, packed-refs (absent, or its ref
 * lines: git writes a fuller header and peel lines), the reflogs and the lock files.
 */
function refState(dir: string): string {
  const packedPath = join(dir, ".git/packed-refs");
  const packed = existsSync(packedPath)
    ? readFileSync(packedPath, "latin1")
        .split("\n")
        .filter((l) => l && !l.startsWith("#") && !l.startsWith("^"))
        .join("\n")
    : "(no packed-refs)";
  const files = (args: string[]) =>
    spawnSync("find", [".git", ...args], { cwd: dir })
      .stdout.toString()
      .split("\n")
      .sort();
  const logs = files(["-path", ".git/logs/*", "-type", "f"])
    .filter(Boolean)
    .map((f) => `${f}:\n${readFileSync(join(dir, f), "latin1")}`);
  return [
    git(dir, ["for-each-ref"]),
    `packed-refs:\n${packed}`,
    `logs:\n${logs.join("")}`,
    `locks:${files(["-name", "*.lock"]).join(" ")}`,
  ].join("\n");
}

describeGit("reference-transaction hook: several refs deleted at once (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-reftx-multi-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  type Run = (g: Git) => Promise<unknown>;

  /** Runs native git and ours in twins of `dir`; compares the logs, outcomes and refs. */
  async function compare(
    dir: string,
    label: string,
    args: string[],
    run: Run,
    prepare?: (twin: HookTwin) => void,
  ): Promise<void> {
    const [theirs, mine] = hookTwins(root, dir);
    prepare?.(theirs);
    prepare?.(mine);
    const native = nativeIn(theirs, root, args);
    let failed = false;
    try {
      await run(await oursIn(mine));
    } catch {
      failed = true;
    }
    expect(hookLog(mine), `${label}: log`).toBe(hookLog(theirs));
    expect(failed, `${label}: failed (${native.stderr})`).toBe(native.status !== 0);
    expect(refState(mine.dir), `${label}: refs`).toBe(refState(theirs.dir));
  }

  function repo(name: string, packedRefs: boolean): string {
    const dir = join(root, name);
    base(dir);
    git(dir, ["branch", "a"]);
    git(dir, ["branch", "b"]);
    git(dir, ["tag", "t1"]);
    git(dir, ["tag", "-a", "-m", "annotated", "t2"]);
    if (packedRefs) {
      git(dir, ["pack-refs", "--all"]);
      // a loose one beside the packed ones
      git(dir, ["branch", "c"]);
      git(dir, ["tag", "t3"]);
    } else {
      git(dir, ["branch", "c"]);
      git(dir, ["tag", "t3"]);
    }
    return dir;
  }

  it("branch -d, branch -D and tag -d of several refs: one transaction (2.5x), packed-refs first then each ref (2.43)", async () => {
    for (const packedRefs of [false, true]) {
      const dir = repo(`r-${packedRefs}`, packedRefs);
      const cases: Array<[string[], Run]> = [
        [["branch", "-d", "a", "c"], (g) => g.branchDelete().setBranchNames("a", "c").call()],
        [
          ["branch", "-D", "c", "b", "a"],
          (g) => g.branchDelete().setBranchNames("c", "b", "a").setForce(true).call(),
        ],
        [["tag", "-d", "t1", "t3", "t2"], (g) => g.tagDelete().setTags("t1", "t3", "t2").call()],
        // a name that cannot be deleted is reported, the others still go
        [
          ["branch", "-d", "a", "nope", "b"],
          (g) => g.branchDelete().setBranchNames("a", "nope", "b").call(),
        ],
      ];
      for (const [args, run] of cases) {
        await compare(dir, `packed=${packedRefs} ${args.join(" ")}`, args, run);
      }
    }
  }, 60_000);

  it("a refusal of the hook: nothing deleted", async () => {
    for (const packedRefs of [false, true]) {
      const dir = repo(`r-${packedRefs}`, packedRefs);
      for (const state of ["prepared", "committed"]) {
        await compare(
          dir,
          `packed=${packedRefs} refused`,
          ["branch", "-D", "a", "c"],
          (g) => g.branchDelete().setBranchNames("a", "c").setForce(true).call(),
          (t) => {
            // refuses in `prepared` (and so aborts); `committed` changes nothing
            const hook = join(t.dir, ".git/hooks/reference-transaction");
            writeFileSync(
              hook,
              readFileSync(hook, "latin1").replace(
                "exit 0\n",
                `[ "$1" = ${state} ] && exit 1\nexit 0\n`,
              ),
            );
          },
        );
      }
    }
  }, 60_000);

  it("a held ref lock or packed-refs.lock: as each git version fails", async () => {
    for (const packedRefs of [false, true]) {
      for (const [i, held] of [
        "refs/heads/c.lock",
        "refs/heads/a.lock",
        "packed-refs.lock",
      ].entries()) {
        const dir = repo(`r-${packedRefs}-${i}`, packedRefs);
        git(dir, ["config", "core.packedRefsTimeout", "0"]);
        git(dir, ["config", "core.filesRefLockTimeout", "0"]);
        await compare(
          dir,
          `packed=${packedRefs} held ${held}`,
          ["branch", "-D", "a", "c", "b"],
          (g) => g.branchDelete().setBranchNames("a", "c", "b").setForce(true).call(),
          (t) => writeFileSync(join(t.dir, ".git", held), ""),
        );
      }
    }
  }, 60_000);

  it("remote remove: the remote-tracking refs in one deletion", async () => {
    for (const packedRefs of [false, true]) {
      const dir = join(root, `r-${packedRefs}`);
      base(dir);
      git(dir, ["remote", "add", "origin", "https://example.invalid/r.git"]);
      for (const n of ["main", "x", "y/z"]) {
        git(dir, ["update-ref", `refs/remotes/origin/${n}`, "HEAD"]);
      }
      if (packedRefs) {
        git(dir, ["pack-refs", "--all"]);
        git(dir, ["update-ref", "refs/remotes/origin/w", "HEAD"]);
      }
      await compare(
        dir,
        `packed=${packedRefs} remote remove`,
        ["remote", "remove", "origin"],
        (g) => g.remoteRemove().setRemoteName("origin").call(),
      );
    }
  }, 60_000);

  it("a batch without deletions while packed-refs.lock is held: committed loose, as native", async () => {
    const dir = repo("r", true);
    const [theirs, mine] = hookTwins(root, dir);
    for (const t of [theirs, mine]) writeFileSync(join(t.dir, ".git/packed-refs.lock"), "");
    const head = git(dir, ["rev-parse", "HEAD"]).trim();
    const native = spawnSync("git", ["update-ref", "--stdin"], {
      cwd: theirs.dir,
      env: theirs.env,
      input: `update refs/heads/a ${head}\ncreate refs/heads/new ${head}\n`,
    });
    expect(native.status).toBe(0);
    const g = await oursIn(mine);
    const store = g.workingCopy.history.refs as unknown as {
      setTransactionHook(hook: RefTransactionHook | undefined): void;
      batch(
        commands: Array<{ name: string; new: string }>,
        options: { ident: string },
      ): Promise<{ ok: boolean }>;
    };
    store.setTransactionHook(refTransactionHookOf(new HookSession(g.workingCopy)));
    const {
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: date,
    } = mine.env;
    const result = await store.batch(
      [
        { name: "refs/heads/a", new: head },
        { name: "refs/heads/new", new: head },
      ],
      { ident: `${name} <${email}> ${date}` },
    );
    store.setTransactionHook(undefined);
    expect(result.ok).toBe(true);
    expect(hookLog(mine)).toBe(hookLog(theirs));
    expect(refState(mine.dir)).toBe(refState(theirs.dir));
  });
});

describeGit(
  "reference-transaction hook: the root refs git updates in transactions (as native git)",
  () => {
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "hooks-reftx-root-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    /** main: base, m (a.txt "m"); side (off base): s (a.txt "s"): their picks conflict. */
    function conflicting(dir: string): void {
      base(dir);
      git(dir, ["checkout", "-q", "-b", "side"]);
      putFile(dir, "a.txt", "s\n");
      git(dir, ["commit", "-qam", "s"]);
      git(dir, ["checkout", "-q", "main"]);
      putFile(dir, "a.txt", "m\n");
      git(dir, ["commit", "-qam", "m"]);
    }

    /** Runs a command in twins of `dir` (both left as they end, for the next step). */
    async function step(
      twins: [HookTwin, HookTwin],
      label: string,
      args: string[],
      run: (g: Git) => Promise<unknown>,
    ): Promise<void> {
      const [theirs, mine] = twins;
      rmSync(theirs.log, { force: true });
      rmSync(mine.log, { force: true });
      nativeIn(theirs, root, args);
      await run(await oursIn(mine)).catch(() => undefined);
      expect(hookLog(mine), `${label}: log`).toBe(hookLog(theirs));
      expect(refState(mine.dir), `${label}: refs`).toBe(refState(theirs.dir));
      for (const file of ["ORIG_HEAD", "CHERRY_PICK_HEAD", "AUTO_MERGE"]) {
        expect(existsSync(join(mine.dir, ".git", file)), `${label}: ${file}`).toBe(
          existsSync(join(theirs.dir, ".git", file)),
        );
      }
    }

    it("cherry-pick stopped at a conflict, then --abort: CHERRY_PICK_HEAD, AUTO_MERGE, ORIG_HEAD", async () => {
      const dir = join(root, "r");
      conflicting(dir);
      const twins = hookTwins(root, dir);
      await step(twins, "cherry-pick", ["cherry-pick", "side"], (g) =>
        g.cherryPick().include("side").call(),
      );
      await step(twins, "cherry-pick --abort", ["cherry-pick", "--abort"], (g) =>
        g.cherryPick().setOperation(SequencerOperation.ABORT).call(),
      );
    });

    it("merge stopped at a conflict, then reset --hard: ORIG_HEAD and AUTO_MERGE", async () => {
      const dir = join(root, "r");
      conflicting(dir);
      const twins = hookTwins(root, dir);
      await step(twins, "merge", ["merge", "side"], (g) => g.merge().include("side").call());
      await step(twins, "reset --hard", ["reset", "-q", "--hard", "HEAD"], (g) =>
        g.reset().setRef("HEAD").setMode(ResetMode.HARD).call(),
      );
    });
  },
);

describeGit("branch -d and tag -d with several refusals: each reported (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-reftx-refusals-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** main (checked out), merged and gone (in it), side (not merged), origin/x remote-tracking. */
  function repo(): string {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["branch", "merged"]);
    git(dir, ["branch", "gone"]);
    git(dir, ["checkout", "-q", "-b", "side"]);
    putFile(dir, "b.txt", "b\n");
    git(dir, ["add", "b.txt"]);
    git(dir, ["commit", "-qm", "side"]);
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["update-ref", "refs/remotes/origin/x", "main"]);
    git(dir, ["tag", "t1"]);
    return dir;
  }

  /** git's stderr without the hook's lines. */
  const refusalLines = (stderr: string) =>
    stderr
      .split("\n")
      .filter((l) => l !== "" && !/^hook \S+ (out|err)$/.test(l))
      .join("\n");

  async function compare(
    args: string[],
    run: (g: Git) => Promise<unknown>,
    setup?: (dir: string) => void,
  ): Promise<void> {
    const dir = repo();
    setup?.(dir);
    const [theirs, mine] = hookTwins(root, dir);
    const native = nativeIn(theirs, root, args);
    let error: unknown;
    try {
      await run(await oursIn(mine));
    } catch (e) {
      error = e;
    }
    const label = args.join(" ");
    expect(native.status, `${label}: native fails`).toBe(1);
    expect(error, label).toBeInstanceOf(Error);
    const thrown = error as { messages?: string[]; refusals?: Error[]; exitCode?: number };
    expect(thrown.exitCode, `${label}: exit code`).toBe(1);
    expect(
      (thrown.messages ?? []).join("\n").replaceAll(mine.dir, "<twin>"),
      `${label}: stderr`,
    ).toBe(refusalLines(native.stderr).replaceAll(theirs.dir, "<twin>"));
    expect(thrown.refusals?.[0], `${label}: first refusal`).toBe(error);
    expect(hookLog(mine), `${label}: log`).toBe(hookLog(theirs));
    expect(refState(mine.dir), `${label}: refs`).toBe(refState(theirs.dir));
    rmSync(dir, { recursive: true, force: true });
  }

  // (the checked-out branch is left out: without linked worktrees our working copy cannot
  // tell git's "used by worktree at '<path>'")
  it("branch -d: not merged, not found and a remote-tracking name, the rest deleted", async () => {
    await compare(["branch", "-d", "side", "nope", "merged", "origin/x", "gone"], (g) =>
      g.branchDelete().setBranchNames("side", "nope", "merged", "origin/x", "gone").call(),
    );
  });

  it("branch -d with advice.forceDeleteBranch off, and branch -D", async () => {
    await compare(
      ["branch", "-d", "side", "merged", "nope"],
      (g) => g.branchDelete().setBranchNames("side", "merged", "nope").call(),
      (dir) => git(dir, ["config", "advice.forceDeleteBranch", "false"]),
    );
    await compare(["branch", "-D", "nope", "side", "nope2"], (g) =>
      g.branchDelete().setBranchNames("nope", "side", "nope2").setForce(true).call(),
    );
  });

  it("tag -d: each missing tag reported, the others deleted", async () => {
    await compare(["tag", "-d", "nope", "t1", "nope2"], (g) =>
      g.tagDelete().setTags("nope", "t1", "nope2").call(),
    );
  });
});

describeGit("reset: an ORIG_HEAD that cannot be written (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-reftx-orighead-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function repo(): string {
    const dir = join(root, "r");
    base(dir);
    putFile(dir, "b.txt", "b\n");
    git(dir, ["add", "b.txt"]);
    git(dir, ["commit", "-qm", "second"]);
    return dir;
  }

  async function compare(label: string, prepare: (twin: HookTwin) => void): Promise<string[]> {
    const [theirs, mine] = hookTwins(root, repo());
    prepare(theirs);
    prepare(mine);
    const native = nativeIn(theirs, root, ["reset", "--soft", "HEAD~1"]);
    const command = (await oursIn(mine)).reset().setRef("HEAD~1").setMode(ResetMode.SOFT);
    await command.call();
    expect(native.status, `${label}: native succeeds (${native.stderr})`).toBe(0);
    expect(hookLog(mine), `${label}: log`).toBe(hookLog(theirs));
    expect(refState(mine.dir), `${label}: refs`).toBe(refState(theirs.dir));
    const errors = (text: string) =>
      text
        .split("\n")
        .filter((l) => l.startsWith("error: "))
        .map((l) => l.replace(/cannot lock ref 'ORIG_HEAD': .*/, "cannot lock ref 'ORIG_HEAD':"));
    expect(errors(command.getWarnings().join("\n")), `${label}: errors`).toEqual(
      errors(native.stderr),
    );
    return command.getWarnings();
  }

  it("ORIG_HEAD.lock held: an error for ORIG_HEAD, HEAD moved all the same", async () => {
    const warnings = await compare("held", (t) =>
      writeFileSync(join(t.dir, ".git/ORIG_HEAD.lock"), ""),
    );
    expect(warnings.join("\n")).toContain("update_ref failed for ref 'ORIG_HEAD'");
  });

  it("ORIG_HEAD a symbolic ref: written through it, HEAD moved", async () => {
    await compare("symbolic", (t) => git(t.dir, ["symbolic-ref", "ORIG_HEAD", "refs/heads/foo"]));
  });
});

describeGit("reset: a symbolic ORIG_HEAD written through to its target (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-reftx-orighead-sym-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** main at "second", tag t at "base". */
  function repo(): string {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["tag", "t"]);
    putFile(dir, "b.txt", "b\n");
    git(dir, ["add", "b.txt"]);
    git(dir, ["commit", "-qm", "second"]);
    return dir;
  }

  /** `reset --hard HEAD~1` in both twins, ORIG_HEAD naming `target`. */
  async function compare(target: string): Promise<void> {
    const [theirs, mine] = hookTwins(root, repo());
    for (const t of [theirs, mine])
      writeFileSync(join(t.dir, ".git/ORIG_HEAD"), `ref: ${target}\n`);
    const native = nativeIn(theirs, root, ["reset", "-q", "--hard", "HEAD~1"]);
    const command = (await oursIn(mine)).reset().setRef("HEAD~1").setMode(ResetMode.HARD);
    await command.call();
    expect(native.status, `${target}: native succeeds (${native.stderr})`).toBe(0);
    expect(hookLog(mine), `${target}: hook log`).toBe(hookLog(theirs));
    expect(refState(mine.dir), `${target}: refs`).toBe(refState(theirs.dir));
    expect(git(mine.dir, ["rev-parse", "HEAD"]), `${target}: HEAD`).toBe(
      git(theirs.dir, ["rev-parse", "HEAD"]),
    );
    expect(readFileSync(join(mine.dir, ".git/ORIG_HEAD"), "latin1"), `${target}: ORIG_HEAD`).toBe(
      readFileSync(join(theirs.dir, ".git/ORIG_HEAD"), "latin1"),
    );
    const stderr = native.stderr
      .split("\n")
      .filter((l) => l !== "" && !/^hook \S+ (out|err)$/.test(l));
    expect(command.getWarnings(), `${target}: stderr`).toEqual(stderr);
  }

  it("naming an existing branch (HEAD's): written through, no error", async () => {
    await compare("refs/heads/main");
  });

  it("naming an existing tag: the tag moved to the HEAD left", async () => {
    await compare("refs/tags/t");
  });

  it("naming a missing branch: created, git's dangling symref warning", async () => {
    await compare("refs/heads/foo");
  });

  it("naming HEAD: written through to HEAD's branch", async () => {
    await compare("HEAD");
  });
});

describeGit("reference-transaction hook: symbolic refs written (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-reftx-symref-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // git 2.5x writes a symbolic ref in a transaction of its own (refs_update_symref:
  // `<zero> ref:<target> <ref>`); git 2.43 writes it outside any, telling the hook nothing
  it("switch -c and checkout of a branch: HEAD repointed", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectTwins(
      dir,
      ["switch", "-q", "-c", "topic"],
      (g) => attempt(g.switch().setCreateBranch("topic")),
      "switch -c",
    );
    git(dir, ["branch", "other"]);
    await expectTwins(
      dir,
      ["checkout", "-q", "other"],
      (g) => attempt(g.checkout().setName("other")),
      "checkout",
    );
  });

  it("remote set-head: refs/remotes/<remote>/HEAD written", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["remote", "add", "origin", "https://example.invalid/r.git"]);
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await expectTwins(
      dir,
      ["remote", "set-head", "origin", "main"],
      (g) => attempt(g.remoteSetHead().setRemoteName("origin").setBranch("main")),
      "remote set-head",
    );
  });

  it("a refusal aborts the symbolic ref's update (2.5x)", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["branch", "other"]);
    const [theirs, mine] = hookTwins(root, dir);
    for (const t of [theirs, mine]) hookExit(t, "reference-transaction", 1);
    const native = nativeIn(theirs, root, ["symbolic-ref", "HEAD", "refs/heads/other"]);
    const g = await oursIn(mine);
    const store = g.workingCopy.history.refs as unknown as {
      setTransactionHook(hook: RefTransactionHook | undefined): void;
      setSymbolic(name: string, target: string): Promise<void>;
    };
    store.setTransactionHook(refTransactionHookOf(new HookSession(g.workingCopy)));
    const error = await store.setSymbolic("HEAD", "refs/heads/other").then(
      () => undefined,
      (e: unknown) => e,
    );
    store.setTransactionHook(undefined);
    expect(hookLog(mine)).toBe(hookLog(theirs));
    expect(error !== undefined).toBe(native.status !== 0);
    if (error) {
      expect(error).toBeInstanceOf(RefTransactionAbortedError);
      expect(native.stderr).toContain(`fatal: ${(error as Error).message}`);
    }
    expect(git(mine.dir, ["symbolic-ref", "HEAD"])).toBe(git(theirs.dir, ["symbolic-ref", "HEAD"]));
  });

  it("rebase --abort: HEAD back on its branch", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["checkout", "-q", "-b", "topic"]);
    putFile(dir, "a.txt", "topic\n");
    git(dir, ["commit", "-qam", "topic"]);
    git(dir, ["checkout", "-q", "main"]);
    putFile(dir, "a.txt", "main\n");
    git(dir, ["commit", "-qam", "main"]);
    git(dir, ["checkout", "-q", "topic"]);
    gitRun(root, dir, ["rebase", "-q", "main"], testEnv(root));
    await expectTwins(
      dir,
      ["rebase", "--abort"],
      (g) => attempt(g.rebase().setOperation(RebaseOperation.ABORT)),
      "rebase --abort",
    );
  });
});

describeGit("reference-transaction hook: ORIG_HEAD and the other root refs (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-reftx-rootrefs-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** main and topic changing a.txt apart (conflicting unless `clean`), topic checked out. */
  function forked(clean = false): string {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["checkout", "-q", "-b", "topic"]);
    putFile(dir, clean ? "t.txt" : "a.txt", "topic\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "topic"]);
    git(dir, ["checkout", "-q", "main"]);
    putFile(dir, "a.txt", "main\n");
    git(dir, ["commit", "-qam", "main"]);
    git(dir, ["checkout", "-q", "topic"]);
    return dir;
  }

  const rebaseMain = (g: Git) => attempt(g.rebase().setUpstream("main"));

  it("rebase: a clean one, ORIG_HEAD written with its old value", async () => {
    const dir = forked(true);
    git(dir, ["update-ref", "ORIG_HEAD", "main"]);
    await expectTwins(dir, ["rebase", "-q", "main"], rebaseMain, "clean rebase");
  });

  it("rebase: stopped on a conflict (REBASE_HEAD, AUTO_MERGE), then --continue", async () => {
    const dir = forked();
    const [theirs, mine] = hookTwins(root, dir);
    const native = nativeIn(theirs, root, ["rebase", "-q", "main"]);
    const ours = await rebaseMain(await oursIn(mine));
    expect(native.status).not.toBe(0);
    expect(hookLog(mine), "stopped: log").toBe(hookLog(theirs));
    expect(ours.error).toBeUndefined();
    for (const t of [theirs, mine]) {
      putFile(t.dir, "a.txt", "resolved\n");
      gitRun(root, t.dir, ["add", "a.txt"], t.env);
      rmSync(t.log, { force: true });
    }
    const continued = nativeIn(theirs, root, ["rebase", "--continue"], { GIT_EDITOR: "true" });
    expect(continued.status, continued.stderr).toBe(0);
    await (await oursIn(mine, { GIT_EDITOR: "true" }))
      .rebase()
      .setOperation(RebaseOperation.CONTINUE)
      .call();
    expect(hookLog(mine), "continued: log").toBe(hookLog(theirs));
    expect(git(mine.dir, ["for-each-ref"])).toBe(git(theirs.dir, ["for-each-ref"]));
  });

  it("merge: a fast-forward and a merge commit, ORIG_HEAD with its old value", async () => {
    const dir = forked(true);
    git(dir, ["update-ref", "ORIG_HEAD", "main"]);
    await expectTwins(
      dir,
      ["merge", "-q", "--no-edit", "main"],
      (g) => attempt(g.merge().include("main")),
      "merge commit",
    );
    git(dir, ["checkout", "-q", "main"]);
    await expectTwins(
      dir,
      ["merge", "-q", "topic"],
      (g) => attempt(g.merge().include("topic")),
      "fast-forward",
    );
  });

  it("reset: --hard, --soft and --mixed with an ORIG_HEAD there", async () => {
    const dir = forked(true);
    git(dir, ["update-ref", "ORIG_HEAD", "main"]);
    for (const [mode, flag] of [
      [ResetMode.HARD, "--hard"],
      [ResetMode.SOFT, "--soft"],
      [ResetMode.MIXED, "--mixed"],
    ] as const) {
      await expectTwins(
        dir,
        ["reset", "-q", flag, "main"],
        (g) => attempt(g.reset().setRef("main").setMode(mode)),
        `reset ${flag}`,
      );
    }
  });

  it("am: two patches applied, ORIG_HEAD written", async () => {
    const dir = join(root, "r");
    base(dir);
    for (const n of ["b", "c"]) {
      putFile(dir, `${n}.txt`, `${n}\n`);
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", n]);
    }
    const mbox = join(root, "p.mbox");
    writeFileSync(mbox, git(dir, ["format-patch", "--stdout", "HEAD~2"]), "latin1");
    git(dir, ["reset", "-q", "--hard", "HEAD~2"]);
    git(dir, ["update-ref", "ORIG_HEAD", "HEAD"]);
    await expectTwins(
      dir,
      ["am", "-q", mbox],
      (g) => attempt(g.am().setLegacyMessages(!nativeIs25x).addMbox(readFileSync(mbox))),
      "am",
    );
  });
});
