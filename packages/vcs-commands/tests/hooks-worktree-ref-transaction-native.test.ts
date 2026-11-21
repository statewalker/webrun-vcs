/**
 * The reference-transaction hook in a linked worktree, against native git: git's files
 * backend for a linked worktree routes HEAD, the root refs and `refs/bisect/`,
 * `refs/worktree/`, `refs/rewritten/` to the worktree's git directory and every other ref
 * to the repository's, and runs the repository's hook (`hooks/` of the common directory)
 * for both, in the worktree's top directory. A commit goes through the worktree's HEAD to
 * its branch; `pack-refs` and gc pack the repository's refs (never the worktree's own).
 *
 * Also packed-refs written from a linked worktree: the repository's file, peeled as the main
 * worktree writes it (`peeled fully-peeled sorted`, a `^` line per annotated tag).
 *
 * Each case copies a repository with a linked worktree (the links rewritten for the copy),
 * runs native git in one copy's worktree and ours in the other's.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RefTransactionAbortedError, type RefTransactionHook } from "@statewalker/vcs-core";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git, HookSession, ResetMode, refTransactionHookOf } from "../src/index.js";
import {
  type HookTwin,
  hookExit,
  hookLines,
  hookLog,
  hookTwins,
  installHooks,
  nativeIs25x,
} from "./hooks-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/**
 * `<dir>/repo` (main, two commits, a light and an annotated tag, the logging hook) and its
 * linked worktree `<dir>/wt` on `feat`.
 */
function base(dir: string): void {
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  putFile(repo, "a.txt", "a\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  putFile(repo, "a.txt", "a2\n");
  git(repo, ["commit", "-qam", "two"]);
  git(repo, ["branch", "other"]);
  git(repo, ["tag", "t1"]);
  git(repo, ["tag", "-a", "-m", "annotated", "t2"]);
  git(repo, ["worktree", "add", "-q", "-b", "feat", "../wt"]);
  installHooks(join(repo, ".git/hooks"), ["reference-transaction"]);
}

/** Two copies of `dir` (native, ours) with their worktree links rewritten for the copy. */
function twins(dir: string): [HookTwin, HookTwin] {
  const make = (suffix: string): HookTwin => {
    const copy = `${dir}-${suffix}`;
    rmSync(copy, { recursive: true, force: true });
    execFileSync("cp", ["-a", dir, copy]);
    writeFileSync(join(copy, "repo/.git/worktrees/wt/gitdir"), `${join(copy, "wt")}/.git\n`);
    writeFileSync(join(copy, "wt/.git"), `gitdir: ${join(copy, "repo/.git/worktrees/wt")}\n`);
    const log = `${copy}.hooklog`;
    const ctl = `${copy}.hookctl`;
    rmSync(log, { force: true });
    rmSync(ctl, { recursive: true, force: true });
    mkdirSync(ctl, { recursive: true });
    const env = testEnv(root, { HOOK_LOG: log, HOOK_CTL: ctl });
    for (const at of ["repo", "wt"]) {
      gitRun(root, join(copy, at), ["update-index", "-q", "--refresh"], env);
    }
    return { dir: copy, log, ctl, env };
  };
  return [make("native"), make("ours")];
}

/** Our working copy of the twin's linked worktree, hooks run by the Node runner. */
async function oursIn(twin: HookTwin): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: twin.dir });
  const { history } = await createGitFilesBackend({ files, gitDir: "repo/.git" });
  const environment = createNodeGitHostEnvironment({
    env: twin.env,
    hookRunner: createNodeHookRunner({
      env: twin.env,
      compatibility: nativeIs25x ? "2.56" : "2.43",
    }),
  });
  const worktrees = await openGitLinkedWorktrees({
    files,
    gitDir: "repo/.git/worktrees/wt",
    history,
    environment,
  });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

const nativeIn = (twin: HookTwin, args: string[]) =>
  gitRun(root, join(twin.dir, "wt"), args, twin.env);

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

/** The refs both worktrees see, the worktree's HEAD and its own refs, packed-refs. */
function refState(twin: HookTwin): string {
  const wt = join(twin.dir, "wt");
  const own = spawnSync("find", [".", "-path", "./logs", "-prune", "-o", "-type", "f", "-print"], {
    cwd: join(twin.dir, "repo/.git/worktrees/wt"),
  })
    .stdout.toString()
    .split("\n")
    .filter((p) => /^\.\/(refs\/|[A-Z_]+$)/.test(p))
    .sort()
    .join("\n");
  let packed = "";
  try {
    packed = readFileSync(join(twin.dir, "repo/.git/packed-refs"), "latin1");
  } catch {
    // none
  }
  return [git(wt, ["for-each-ref"]), git(wt, ["rev-parse", "HEAD"]), own, packed].join("\n");
}

async function expectTwins(
  dir: string,
  args: string[],
  run: (git: Git) => Promise<{ output: string; error?: Error }>,
  label: string,
  prepare?: (twin: HookTwin) => void,
): Promise<[HookTwin, HookTwin]> {
  const [theirs, mine] = twins(dir);
  prepare?.(theirs);
  prepare?.(mine);
  const native = nativeIn(theirs, args);
  const ours = await run(await oursIn(mine));
  expect(hookLog(mine), `${label}: log`).toBe(hookLog(theirs));
  expect(ours.error !== undefined, `${label}: failed (${native.stderr})`).toBe(native.status !== 0);
  if (ours.error) {
    expect(ours.error).toBeInstanceOf(RefTransactionAbortedError);
    expect(native.stderr).toContain(`fatal: ${ours.error.message}`);
  } else {
    expect(hookLines(ours.output), `${label}: output`).toBe(hookLines(native.stderr));
  }
  expect(refState(mine), `${label}: refs`).toBe(refState(theirs));
  return [theirs, mine];
}

describeGit("reference-transaction hook in a linked worktree (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-wt-reftx-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a commit: HEAD asked for, the branch it names written", async () => {
    const dir = join(root, "c");
    base(dir);
    putFile(join(dir, "wt"), "a.txt", "wt\n");
    git(join(dir, "wt"), ["add", "a.txt"]);
    await expectTwins(
      dir,
      ["commit", "-qm", "in wt"],
      (g) => attempt(g.commit().setMessage("in wt")),
      "commit",
    );
  });

  it("branch and tag created and deleted: the repository's refs", async () => {
    const dir = join(root, "c");
    base(dir);
    await expectTwins(
      dir,
      ["branch", "topic"],
      (g) => attempt(g.branchCreate().setName("topic")),
      "branch",
    );
    await expectTwins(dir, ["tag", "v1"], (g) => attempt(g.tag().setName("v1")), "tag");
    git(join(dir, "repo"), ["branch", "gone"]);
    await expectTwins(
      dir,
      ["branch", "-d", "gone"],
      (g) => attempt(g.branchDelete().setBranchNames("gone")),
      "branch -d",
    );
    await expectTwins(
      dir,
      ["tag", "-d", "t1"],
      (g) => attempt(g.tagDelete().setTags("t1")),
      "tag -d",
    );
  });

  it("checkout: the worktree's symbolic HEAD (2.5x's ref: line)", async () => {
    const dir = join(root, "c");
    base(dir);
    await expectTwins(
      dir,
      ["checkout", "-q", "other"],
      (g) => attempt(g.checkout().setName("other")),
      "checkout",
    );
  });

  it("reset --hard: ORIG_HEAD in the worktree, HEAD's branch in the repository", async () => {
    const dir = join(root, "c");
    base(dir);
    await expectTwins(
      dir,
      ["reset", "-q", "--hard", "HEAD~"],
      (g) => attempt(g.reset().setRef("HEAD~").setMode(ResetMode.HARD)),
      "reset",
    );
  });

  it("a refusal in prepared aborts a commit in the worktree", async () => {
    const dir = join(root, "c");
    base(dir);
    putFile(join(dir, "wt"), "a.txt", "wt\n");
    git(join(dir, "wt"), ["add", "a.txt"]);
    await expectTwins(
      dir,
      ["commit", "-qm", "in wt"],
      (g) => attempt(g.commit().setMessage("in wt")),
      "refused commit",
      (t) => hookExit(t, "reference-transaction", 1),
    );
  });

  it("update-ref of the worktree's own refs and of HEAD's branch", async () => {
    const dir = join(root, "c");
    base(dir);
    const cases: Array<[string[], (refs: StoreRefs, head: string) => Promise<unknown>]> = [
      [
        ["update-ref", "refs/worktree/x", "HEAD"],
        (refs, head) => refs.set("refs/worktree/x", head),
      ],
      [
        ["update-ref", "refs/bisect/bad", "HEAD"],
        (refs, head) => refs.set("refs/bisect/bad", head),
      ],
      [["update-ref", "ORIG_HEAD", "HEAD~"], (refs, head) => refs.set("ORIG_HEAD", head)],
      [
        ["update-ref", "refs/heads/feat", "HEAD~"],
        (refs, head) => refs.set("refs/heads/feat", head),
      ],
      [
        ["update-ref", "--no-deref", "HEAD", "HEAD~"],
        (refs, head) => refs.batch([{ name: "HEAD", new: head, noDeref: true }]),
      ],
      [
        ["symbolic-ref", "HEAD", "refs/heads/other"],
        (refs) => refs.setSymbolic("HEAD", "refs/heads/other"),
      ],
    ];
    for (const [args, run] of cases) {
      const [theirs, mine] = twins(dir);
      const native = nativeIn(theirs, args);
      expect(native.status, `${args.join(" ")}: ${native.stderr}`).toBe(0);
      const target = args.includes("HEAD~") ? "HEAD~" : "HEAD";
      const head = git(join(mine.dir, "wt"), ["rev-parse", target]).trim();
      const g = await oursIn(mine);
      const refs = g.workingCopy.history.refs as unknown as StoreRefs;
      refs.setTransactionHook(refTransactionHookOf(new HookSession(g.workingCopy)));
      await run(refs, head);
      refs.setTransactionHook(undefined);
      expect(hookLog(mine), args.join(" ")).toBe(hookLog(theirs));
      expect(refState(mine), args.join(" ")).toBe(refState(theirs));
    }
  });
});

/** The ref store calls the update-ref cases make. */
interface StoreRefs {
  setTransactionHook(hook: RefTransactionHook | undefined): void;
  set(name: string, id: string): Promise<void>;
  setSymbolic(name: string, target: string): Promise<void>;
  batch(commands: { name: string; new: string; noDeref?: boolean }[]): Promise<unknown>;
}

describeGit("pack-refs and gc in a linked worktree (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-wt-pack-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Loose refs of both kinds, some packed, and the worktree's own refs (never packed). */
  function packBase(dir: string): void {
    base(dir);
    const wt = join(dir, "wt");
    git(wt, ["pack-refs", "--all"]);
    git(wt, ["branch", "b2"]);
    git(wt, ["tag", "t3"]);
    git(wt, ["tag", "-a", "-m", "annotated", "t4"]);
    git(wt, ["update-ref", "refs/bisect/bad", "HEAD"]);
    git(wt, ["update-ref", "refs/worktree/w", "HEAD"]);
  }

  it("pack-refs --all, pack-refs: the repository's refs, peeled as the main worktree", async () => {
    const dir = join(root, "c");
    packBase(dir);
    await expectTwins(
      dir,
      ["pack-refs", "--all"],
      (g) => attempt(g.packRefs().setAll(true)),
      "pack-refs --all",
    );
    await expectTwins(dir, ["pack-refs"], (g) => attempt(g.packRefs()), "pack-refs");
  });

  it("gc packs the refs as pack-refs --all --prune", async () => {
    const dir = join(root, "c");
    packBase(dir);
    await expectTwins(dir, ["gc", "-q"], (g) => attempt(g.gc()), "gc");
  });

  it("tag -d and branch -d of packed refs: packed-refs rewritten with git's header", async () => {
    const dir = join(root, "c");
    packBase(dir);
    git(join(dir, "wt"), ["pack-refs", "--all"]);
    git(join(dir, "wt"), ["tag", "-a", "-m", "loose annotated", "t5"]);
    await expectTwins(
      dir,
      ["tag", "-d", "t3"],
      (g) => attempt(g.tagDelete().setTags("t3")),
      "tag -d",
    );
    await expectTwins(
      dir,
      ["branch", "-D", "b2"],
      (g) => attempt(g.branchDelete().setBranchNames("b2").setForce(true)),
      "branch -D",
    );
  });

  it("a branch created over a packed file written by the main worktree: still fully peeled", async () => {
    const dir = join(root, "c");
    packBase(dir);
    git(join(dir, "repo"), ["pack-refs", "--all"]);
    const [theirs, mine] = await expectTwins(
      dir,
      ["tag", "-d", "t4"],
      (g) => attempt(g.tagDelete().setTags("t4")),
      "tag -d",
    );
    const packed = readFileSync(join(mine.dir, "repo/.git/packed-refs"), "latin1");
    expect(packed.split("\n")[0]).toBe("# pack-refs with: peeled fully-peeled sorted ");
    expect(packed).toBe(readFileSync(join(theirs.dir, "repo/.git/packed-refs"), "latin1"));
  });
});

describeGit("GIT_DIR in hooks of linked worktrees and bare repositories (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-wt-gitdir-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Only the logging post-checkout hook in the repository's hooks directory. */
  const postCheckoutOnly = (twin: HookTwin) => {
    rmSync(join(twin.dir, "repo/.git/hooks/reference-transaction"), { force: true });
    installHooks(join(twin.dir, "repo/.git/hooks"), ["post-checkout"]);
  };

  it("worktree add from a linked worktree: post-checkout without GIT_DIR and GIT_WORK_TREE", async () => {
    const dir = join(root, "c");
    base(dir);
    const [theirs, mine] = await expectTwins(
      dir,
      ["worktree", "add", "-q", "--detach", "../wt2"],
      (g) => attempt(g.worktreeAdd().setPath("../wt2").setDetach(true)),
      "worktree add",
      postCheckoutOnly,
    );
    expect(hookLog(mine)).toContain("== post-checkout");
    expect(hookLog(mine)).not.toContain("GIT_DIR=");
    expect(existsSync(join(theirs.dir, "wt2/.git"))).toBe(true);
    // a checkout in the linked worktree exports the git directory its gitfile names
    await expectTwins(
      dir,
      ["checkout", "-q", "other"],
      (g) => attempt(g.checkout().setName("other")),
      "checkout",
      postCheckoutOnly,
    );
  });

  it("a gitfile reached through a symbolic link: GIT_DIR is the real path", async () => {
    const real = join(root, "real");
    const link = join(root, "lnk");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    const dir = join(real, "c");
    base(dir);
    const make = (suffix: string): HookTwin & { real: string } => {
      const copy = `${dir}-${suffix}`;
      execFileSync("cp", ["-a", dir, copy]);
      // the worktree and its gitfile named through the link
      const named = join(link, `c-${suffix}`);
      writeFileSync(join(copy, "repo/.git/worktrees/wt/gitdir"), `${join(named, "wt")}/.git\n`);
      writeFileSync(join(copy, "wt/.git"), `gitdir: ${join(named, "repo/.git/worktrees/wt")}\n`);
      const log = `${copy}.hooklog`;
      const ctl = `${copy}.hookctl`;
      mkdirSync(ctl, { recursive: true });
      const env = testEnv(root, { HOOK_LOG: log, HOOK_CTL: ctl });
      gitRun(root, join(named, "wt"), ["update-index", "-q", "--refresh"], env);
      const twin = { dir: named, log, ctl, env, real: copy };
      postCheckoutOnly({ ...twin, dir: copy });
      return twin;
    };
    const theirs = make("native");
    const mine = make("ours");
    const logOf = (t: HookTwin & { real: string }) =>
      existsSync(t.log)
        ? readFileSync(t.log, "latin1").replaceAll(t.real, "<real>").replaceAll(t.dir, "<lnk>")
        : "";
    const native = nativeIn(theirs, ["checkout", "-q", "other"]);
    expect(native.status, native.stderr).toBe(0);
    const ours = await attempt((await oursIn(mine)).checkout().setName("other"));
    expect(ours.error).toBeUndefined();
    expect(logOf(theirs)).toContain("GIT_DIR=<real>/repo/.git/worktrees/wt\n");
    expect(logOf(mine)).toBe(logOf(theirs));
  });

  it("a bare repository: GIT_DIR=. in the repository's directory", async () => {
    const dir = join(root, "b");
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    git(src, ["init", "-q", "-b", "main"]);
    putFile(src, "a.txt", "a\n");
    git(src, ["add", "-A"]);
    git(src, ["commit", "-qm", "a"]);
    git(dir, ["clone", "-q", "--bare", "src", "bare.git"]);
    installHooks(join(dir, "bare.git/hooks"), ["pre-commit", "reference-transaction"]);
    const cases: Array<[string[], (g: Git) => Promise<{ output: string; error?: Error }>]> = [
      [["hook", "run", "pre-commit"], (g) => attempt(g.hookRun().setHookName("pre-commit"))],
      [["branch", "topic"], (g) => attempt(g.branchCreate().setName("topic"))],
    ];
    for (const [args, run] of cases) {
      const [theirs, mine] = hookTwins(root, dir);
      const native = gitRun(root, join(theirs.dir, "bare.git"), args, theirs.env);
      expect(native.status, `${args.join(" ")}: ${native.stderr}`).toBe(0);
      const files = createNodeFilesApi({ rootDir: mine.dir });
      const { history } = await createGitFilesBackend({ files, gitDir: "bare.git" });
      const environment = createNodeGitHostEnvironment({
        env: mine.env,
        hookRunner: createNodeHookRunner({
          env: mine.env,
          compatibility: nativeIs25x ? "2.56" : "2.43",
        }),
      });
      const worktrees = await openGitLinkedWorktrees({
        files,
        gitDir: "bare.git",
        history,
        environment,
      });
      const ours = await run(Git.fromWorktreeAdmin(await worktrees.openAdmin()));
      expect(ours.error, args.join(" ")).toBeUndefined();
      expect(hookLog(theirs), args.join(" ")).toContain("GIT_DIR=.\n");
      expect(hookLog(mine), args.join(" ")).toBe(hookLog(theirs));
    }
  });
});
