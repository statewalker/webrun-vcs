/**
 * The hooks of checkout, switch, restore, clone, worktree add and merge against native git:
 * post-checkout (builtin/checkout.c `post_checkout_hook`, clone.c `checkout`, worktree.c
 * `add_worktree`) with the old and new HEAD and the branch flag, its exit code becoming the
 * command's; merge's pre-merge-commit, prepare-commit-msg (`merge`), commit-msg and
 * post-merge (builtin/merge.c `prepare_to_commit`, `finish`), a refusing hook leaving the
 * merge for `git commit`, `--no-verify`, a message commit-msg edits. Each case runs native
 * git in one copy of a repository with logging hooks and ours (with the Node hook runner) in
 * the other, and compares the hook logs and output.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Git, HookSession, MergeStatus } from "../src/index.js";
import {
  type HookTwin,
  hookEdit,
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

const HOOKS = [
  "post-checkout",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-merge",
  "post-commit",
];

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/** main (two commits) and side (one commit off the first), hooks installed. */
function base(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, "a.txt", "a\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  git(dir, ["branch", "side"]);
  git(dir, ["branch", "ahead"]);
  putFile(dir, "b.txt", "b\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "main two"]);
  git(dir, ["checkout", "-q", "side"]);
  putFile(dir, "c.txt", "c\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "side one"]);
  git(dir, ["checkout", "-q", "ahead"]);
  git(dir, ["merge", "-q", "--ff-only", "main"]);
  putFile(dir, "d.txt", "d\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "ahead"]);
  git(dir, ["checkout", "-q", "main"]);
  installHooks(join(dir, ".git/hooks"), HOOKS);
}

/** Native `git <args>` and ours (`run`) on twins: logs, hook output and HEAD agree. */
async function expectTwins(
  dir: string,
  args: string[],
  run: (git: Git) => Promise<{ output: string; failed: boolean; exitCode?: number }>,
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
  if (ours.exitCode !== undefined) expect(ours.exitCode, `${label}: exit`).toBe(native.status);
  expect(git(mine.dir, ["rev-parse", "HEAD"]), `${label}: HEAD`).toBe(
    git(theirs.dir, ["rev-parse", "HEAD"]),
  );
  expect(git(mine.dir, ["status", "--porcelain"]), `${label}: status`).toBe(
    git(theirs.dir, ["status", "--porcelain"]),
  );
}

describeGit("post-checkout and the merge hooks: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-checkout-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("checkout and switch: the old and new HEAD and 1; paths and restore: HEAD HEAD 0", async () => {
    const dir = join(root, "r");
    base(dir);
    const run =
      (call: (g: Git) => { call(): Promise<{ exitCode?: number }>; getHookOutput(): string }) =>
      async (g: Git) => {
        const command = call(g);
        const result = await command.call();
        return {
          output: command.getHookOutput(),
          failed: (result.exitCode ?? 0) !== 0,
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        };
      };
    await expectTwins(
      dir,
      ["checkout", "-q", "side"],
      run((g) => g.checkout().setName("side")),
      "checkout side",
    );
    await expectTwins(
      dir,
      ["checkout", "-q", "-b", "new"],
      run((g) => g.checkout().setName("new").setCreateBranch(true)),
      "checkout -b",
    );
    await expectTwins(
      dir,
      ["switch", "-q", "--detach", "side"],
      run((g) => g.switch().setName("side").setDetach(true)),
      "switch --detach",
    );
    putFile(dir, "a.txt", "changed\n");
    await expectTwins(
      dir,
      ["checkout", "--", "a.txt"],
      run((g) => g.checkout().addPath("a.txt")),
      "checkout -- a.txt",
    );
    await expectTwins(
      dir,
      ["restore", "a.txt"],
      run((g) => g.restore().addPath("a.txt")),
      "restore a.txt",
    );
    await expectTwins(
      dir,
      ["checkout", "-q", "side"],
      run((g) => g.checkout().setName("side")),
      "post-checkout exit 3",
      (t) => hookExit(t, "post-checkout", 3),
    );
    await expectTwins(
      dir,
      ["checkout", "--", "a.txt"],
      run((g) => g.checkout().addPath("a.txt")),
      "checkout -- a.txt, post-checkout exit 3",
      (t) => hookExit(t, "post-checkout", 3),
    );
  });

  it("merge: fast-forward, a merge commit and a squash run post-merge", async () => {
    const dir = join(root, "r");
    base(dir);
    const merge =
      (names: string[], setup: (m: ReturnType<Git["merge"]>) => void = () => {}) =>
      async (g: Git) => {
        const command = g.merge();
        for (const n of names) command.include(n);
        setup(command);
        const result = await command.call();
        return { output: command.getHookOutput(), failed: result.status === MergeStatus.FAILED };
      };
    await expectTwins(dir, ["merge", "-q", "ahead"], merge(["ahead"]), "fast-forward");
    await expectTwins(dir, ["merge", "-q", "side"], merge(["side"]), "merge commit");
    await expectTwins(
      dir,
      ["merge", "-q", "--squash", "side"],
      merge(["side"], (m) => m.setSquash(true)),
      "squash",
    );
    await expectTwins(
      dir,
      ["merge", "-q", "--no-verify", "side"],
      merge(["side"], (m) => m.setNoVerify(true)),
      "--no-verify",
    );
    await expectTwins(
      dir,
      ["merge", "-q", "-m", "custom", "side"],
      merge(["side"], (m) => m.setMessage("custom")),
      "edited by commit-msg",
      (t) => hookEdit(t, "commit-msg", "\nedited\n"),
    );
  });

  it("merge: a refusing pre-merge-commit or commit-msg leaves the merge for git commit", async () => {
    const dir = join(root, "r");
    base(dir);
    for (const hook of ["pre-merge-commit", "commit-msg", "prepare-commit-msg"]) {
      const [theirs, mine] = hookTwins(root, dir);
      hookExit(theirs, hook, 1);
      hookExit(mine, hook, 1);
      const native = nativeIn(theirs, root, ["merge", "-q", "side"]);
      const command = (await oursIn(mine)).merge().include("side");
      const result = await command.call();
      expect(native.status, hook).toBe(1);
      expect(result.status, hook).toBe(MergeStatus.FAILED);
      const refusal = native.stderr.split("\n").filter((l) => l.startsWith("Not committing"));
      expect(`${result.message}`, hook).toBe(refusal.join("\n"));
      expect(hookLog(mine), hook).toBe(hookLog(theirs));
      // abort_commit's write_merge_state: the merge left for `git commit`
      for (const file of ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"]) {
        const read = (d: string) => readFileSync(join(d, ".git", file), "latin1");
        expect(read(mine.dir), `${hook}: ${file}`).toBe(read(theirs.dir));
      }
      expect(git(mine.dir, ["status", "--porcelain"]), hook).toBe(
        git(theirs.dir, ["status", "--porcelain"]),
      );
    }
  });

  it("clone: post-checkout from the null id to the checked-out commit", async () => {
    const src = join(root, "src");
    base(src);
    const template = join(root, "template");
    installHooks(join(template, "hooks"), ["post-checkout"]);
    const twin = (name: string): HookTwin => {
      const dir = join(root, name);
      const ctl = `${dir}.hookctl`;
      mkdirSync(ctl, { recursive: true });
      const log = `${dir}.hooklog`;
      return { dir, log, ctl, env: testEnv(root, { HOOK_LOG: log, HOOK_CTL: ctl }) };
    };
    const theirs = twin("c-native");
    const mine = twin("c-ours");
    const native = nativeIn({ ...theirs, dir: root }, root, [
      "clone",
      "-q",
      `--template=${template}`,
      src,
      theirs.dir,
    ]);
    expect(native.status, native.stderr).toBe(0);
    installHooks(join(mine.dir, ".git/hooks"), ["post-checkout"]);
    const env = mine.env;
    const ours = await openOurs(
      root,
      createNodeGitHostEnvironment({
        env,
        hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
      }),
      undefined,
      "c-ours",
    );
    const clone = ours.clone().setURI(src);
    await clone.call();
    expect(hookLog(mine)).toBe(hookLog(theirs));
    expect(hookLines(clone.getHookOutput())).toBe(hookLines(native.stderr));
  });

  it("worktree add: post-checkout in the new worktree", async () => {
    const dir = join(root, "r");
    base(dir);
    const [theirs, mine] = hookTwins(root, dir);
    const native = nativeIn(theirs, root, ["worktree", "add", "-q", "../wt-native", "side"]);
    expect(native.status, native.stderr).toBe(0);
    const files = createNodeFilesApi({ rootDir: root });
    const gitDir = "r-ours/.git";
    const { history } = await createGitFilesBackend({ files, gitDir });
    const env = mine.env;
    const environment = createNodeGitHostEnvironment({
      env,
      hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
    });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
    const wc = await worktrees.openCurrent();
    const add = Git.fromWorkingCopy(wc).worktreeAdd().setPath("wt-ours").setCommitish("side");
    add.setQuiet(true);
    await add.call();
    const normalize = (log: string) =>
      log.replace(/wt-(native|ours)/g, "wt").replace(/r-(native|ours)/g, "r");
    expect(normalize(hookLog(mine))).toBe(normalize(hookLog(theirs)));
    expect(hookLines(add.getHookOutput())).toBe(hookLines(native.stderr));
  });
});

describe("hooks run in another directory (git's opt.dir)", () => {
  it("a hook of a FilesApi without host paths is named from the directory it runs in", async () => {
    const files = createInMemoryFilesApi();
    await files.write(".git/hooks/post-checkout", [new TextEncoder().encode("#!/bin/sh\n")]);
    const seen: Array<{ path: string; cwd: string }> = [];
    const session = new HookSession({
      layout: async () => ({ files, top: "", gitDir: ".git", cwd: "", bare: false }),
      configValue: () => undefined,
      environment: () => ({
        readFile: async () => undefined,
        hookRunner: {
          run: async (invocation) => {
            seen.push({ path: invocation.path, cwd: invocation.cwd });
            return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
          },
        },
      }),
    });
    await session.run("post-checkout", { dir: "wt/new" });
    expect(seen).toEqual([{ path: "../../.git/hooks/post-checkout", cwd: "wt/new" }]);
  });
});

describeGit("clone through a symbolic link: post-checkout's GIT_DIR (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-clone-link-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("GIT_DIR is the real path of the new repository's git directory", async () => {
    const real = join(root, "real");
    const link = join(root, "lnk");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    // the source inside the storage, named through the link
    const src = join(link, "src");
    base(join(real, "src"));
    const template = join(root, "template");
    installHooks(join(template, "hooks"), ["post-checkout"]);
    const twin = (name: string): HookTwin => {
      const ctl = join(root, `${name}.hookctl`);
      mkdirSync(ctl, { recursive: true });
      const log = join(root, `${name}.hooklog`);
      return {
        dir: join(link, name),
        log,
        ctl,
        env: testEnv(root, { HOOK_LOG: log, HOOK_CTL: ctl }),
      };
    };
    const theirs = twin("c-native");
    const mine = twin("c-ours");
    const native = nativeIn({ ...theirs, dir: root }, root, [
      "clone",
      "-q",
      `--template=${template}`,
      src,
      theirs.dir,
    ]);
    expect(native.status, native.stderr).toBe(0);
    installHooks(join(mine.dir, ".git/hooks"), ["post-checkout"]);
    const env = mine.env;
    const ours = await openOurs(
      link,
      createNodeGitHostEnvironment({
        env,
        hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
      }),
      undefined,
      "c-ours",
    );
    await ours.clone().setURI(src).call();
    const logOf = (t: HookTwin, name: string) =>
      readFileSync(t.log, "latin1").replaceAll(join(real, name), "<real>");
    expect(logOf(theirs, "c-native")).toContain("GIT_DIR=<real>/.git\n");
    expect(logOf(mine, "c-ours")).toBe(logOf(theirs, "c-native"));
  });
});

describeGit(
  "cherry-pick's ref lock message names the git directory as git does (review fix)",
  () => {
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "hooks-lock-path-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("a repository reached through a symbolic link: the logical $PWD path, not the real one", async () => {
      const real = join(root, "real");
      const link = join(root, "lnk");
      mkdirSync(real, { recursive: true });
      symlinkSync(real, link);
      const dir = join(link, "r");
      mkdirSync(dir, { recursive: true });
      git(dir, ["init", "-q", "-b", "main"]);
      putFile(dir, "a.txt", "a\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "base"]);
      git(dir, ["checkout", "-q", "-b", "side"]);
      putFile(dir, "c.txt", "c\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "side one"]);
      git(dir, ["checkout", "-q", "main"]);
      const side = git(dir, ["rev-parse", "side"]).trim();
      const [theirs, mine] = hookTwins(root, dir);
      for (const twin of [theirs, mine]) putFile(twin.dir, ".git/refs/heads/main.lock", "");
      // a shell started in the link names its directory so ($PWD), as absolute_path prefers it
      const native = nativeIn(theirs, root, ["cherry-pick", side], { PWD: theirs.dir });
      expect(native.status).not.toBe(0);
      const lockLine = (text: string, twinDir: string) =>
        text
          .split("\n")
          .find((l) => l.startsWith("error: cannot lock ref"))
          ?.replaceAll(twinDir, "<twin>");
      expect(lockLine(native.stderr, theirs.dir)).toContain("'<twin>/.git/refs/heads/main.lock'");
      const error = await (await oursIn(mine))
        .cherryPick()
        .include(side)
        .call()
        .then(
          () => undefined,
          (e: unknown) => e as Error,
        );
      expect(lockLine(error?.message ?? "", mine.dir)).toBe(lockLine(native.stderr, theirs.dir));
    });
  },
);
