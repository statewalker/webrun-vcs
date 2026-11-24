/**
 * `push.default` (simple, current, upstream/tracking, matching, nothing) against native git:
 * git's builtin/push.c `setup_default_push_refspecs` with its refusals (no upstream, an
 * upstream of another name, a triangular workflow, a detached HEAD, `nothing`) and
 * `push.autoSetupRemote`, and `set_refspecs`' mapping of a branch name through the upstream.
 * The scenarios are t5528-push-default.sh's, each run as one sequence of steps on two
 * identical directories: native `git push` in one, ours in the other (see
 * `push-modes-native-support.ts`), comparing the exit status, stderr, the refs of the pusher
 * and of both remotes, and the pusher's `branch.*` configuration.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { nativeGitAvailable } from "./native-git-http-backend.js";
import {
  bare,
  both,
  pushBoth,
  type Twins,
  testCommit,
  twins,
} from "./push-modes-native-support.js";
import { gitOut } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const REPOS = ["w", "w/repo1", "w/repo2"];

/** t5528-push-default.sh: "setup bare remotes" (`w` with parent1 = repo1, parent2 = repo2). */
function setup(): Twins {
  const t = twins(root, (dir) => {
    const w = join(dir, "w");
    gitOut(root, dir, ["init", "-q", "-b", "main", "w"]);
    bare(root, w, "repo1");
    bare(root, w, "repo2");
    gitOut(root, w, ["remote", "add", "parent1", "repo1"]);
    gitOut(root, w, ["remote", "add", "parent2", "repo2"]);
  });
  testCommit(t, "w", "one");
  both(t, "w", "push", "-q", "parent1", "HEAD");
  both(t, "w", "push", "-q", "parent2", "HEAD");
  return t;
}

/** `git [-c push.default=<mode>] push`, compared. */
const push = (t: Twins, mode: string, ...args: string[]) =>
  pushBoth(t, "w", [...(mode ? ["-c", `push.default=${mode}`] : []), "push", ...args], REPOS);

const config = (t: Twins, key: string, value: string) => both(t, "w", "config", key, value);
const unconfig = (t: Twins, key: string) => {
  for (const d of [t.n, t.o]) {
    // test_unconfig: absent is fine
    try {
      gitOut(root, join(d, "w"), ["config", "--unset-all", key]);
    } catch {}
  }
};

describeGit("push.default (native git)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "push-default-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("upstream: to the configured upstream, refused without a remote or a merge", async () => {
    const t = setup();
    // t5528-push-default.sh: '"upstream" pushes to configured upstream'
    config(t, "branch.main.remote", "parent1");
    config(t, "branch.main.merge", "refs/heads/foo");
    testCommit(t, "w", "two");
    await push(t, "upstream");
    // t5528-push-default.sh: '"upstream" does not push on unconfigured remote'
    unconfig(t, "branch.main.remote");
    testCommit(t, "w", "three");
    await push(t, "upstream");
    // t5528-push-default.sh: '"upstream" does not push on unconfigured branch'
    config(t, "branch.main.remote", "parent1");
    unconfig(t, "branch.main.merge");
    testCommit(t, "w", "four");
    await push(t, "upstream");
  });

  // t5528-push-default.sh: '"upstream" does not push when remotes do not match'
  it("upstream refuses a remote that is not the branch's", async () => {
    const t = setup();
    config(t, "branch.main.remote", "parent1");
    config(t, "branch.main.merge", "refs/heads/foo");
    config(t, "push.default", "upstream");
    testCommit(t, "w", "five");
    await push(t, "", "parent2");
  });

  it("current: with several remotes and none origin, to a named remote, to origin, to the one remote", async () => {
    const t = setup();
    config(t, "push.default", "current");
    // t5528-push-default.sh: '"current" does not push when multiple remotes and none origin'
    testCommit(t, "w", "current-multi");
    await push(t, "");
    // t5528-push-default.sh: '"current" pushes when remote explicitly specified'
    testCommit(t, "w", "current-specified");
    await push(t, "", "parent1");
    // t5528-push-default.sh: '"current" pushes to origin when no remote specified among multiple'
    config(t, "remote.origin.url", "repo1");
    config(t, "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    testCommit(t, "w", "current-origin");
    await push(t, "current");
    // t5528-push-default.sh: '"current" pushes to single remote even when not specified'
    both(t, "w", "remote", "remove", "origin");
    both(t, "w", "remote", "remove", "parent1");
    testCommit(t, "w", "current-implied");
    await push(t, "current");
  });

  it("new branches: every mode but current refuses or skips, nothing refuses, autoSetupRemote", async () => {
    const t = setup();
    // t5528-push-default.sh: "push from/to new branch with non-defaulted remote fails with upstream, matching, current and simple "
    both(t, "w", "checkout", "-q", "-b", "new-branch");
    for (const mode of ["simple", "matching", "upstream", "current"]) await push(t, mode);
    // t5528-push-default.sh: "push from/to new branch fails with upstream and simple "
    both(t, "w", "checkout", "-q", "-b", "new-branch-1");
    config(t, "branch.new-branch-1.remote", "parent1");
    for (const mode of ["simple", "upstream"]) await push(t, mode);
    // t5528-push-default.sh: "push from/to new branch fails with matching " (test_expect_failure:
    // the matching push succeeds, as git does)
    both(t, "w", "checkout", "-q", "-b", "new-branch-2");
    config(t, "branch.new-branch-2.remote", "parent1");
    await push(t, "matching");
    // t5528-push-default.sh: "push from/to branch with tracking fails with nothing "
    both(t, "w", "checkout", "-q", "-b", "tracked-branch");
    config(t, "branch.tracked-branch.remote", "parent1");
    config(t, "branch.tracked-branch.merge", "refs/heads/tracked-branch");
    await push(t, "nothing");
    // t5528-push-default.sh: "push from/to new branch succeeds with upstream if push.autoSetupRemote"
    both(t, "w", "checkout", "-q", "-b", "new-branch-a");
    config(t, "push.autoSetupRemote", "true");
    config(t, "branch.new-branch-a.remote", "parent1");
    await push(t, "upstream");
    // t5528-push-default.sh: "push from/to new branch succeeds with simple if push.autoSetupRemote"
    both(t, "w", "checkout", "-q", "-b", "new-branch-c");
    config(t, "branch.new-branch-c.remote", "parent1");
    await push(t, "simple");
    // and current with it (setup_default_push_refspecs sets the upstream for current too)
    both(t, "w", "checkout", "-q", "-b", "new-branch-d");
    await push(t, "current");
    unconfig(t, "push.autoSetupRemote");
    // t5528-push-default.sh: "push from/to new branch with current creates remote branch"
    config(t, "branch.new-branch.remote", "repo1");
    both(t, "w", "checkout", "-q", "new-branch");
    await push(t, "current");
  });

  // t5528-push-default.sh: '"matching" fails if none match'
  it("matching with nothing in common says so", async () => {
    const t = setup();
    for (const d of [t.n, t.o]) bare(root, join(d, "w"), "empty");
    await push(t, "", "empty", ":");
  });

  // t5528-push-default.sh: "push ambiguously named branch with upstream, matching and simple"
  it("a branch and a tag of one name", async () => {
    const t = setup();
    both(t, "w", "checkout", "-q", "-b", "ambiguous");
    config(t, "branch.ambiguous.remote", "parent1");
    config(t, "branch.ambiguous.merge", "refs/heads/ambiguous");
    both(t, "w", "tag", "ambiguous");
    for (const mode of ["simple", "matching", "upstream"]) await push(t, mode);
  });

  it("existing branches: no upstream, one of the same name, one of another name", async () => {
    const t = setup();
    // t5528-push-default.sh: "push to existing branch, with no upstream configured"
    config(t, "branch.main.remote", "repo1");
    for (const mode of ["simple", "upstream"]) await push(t, mode);
    // t5528-push-default.sh: "push to existing branch, upstream configured with same name"
    config(t, "branch.main.merge", "refs/heads/main");
    testCommit(t, "w", "six");
    await push(t, "upstream");
    testCommit(t, "w", "seven");
    await push(t, "simple");
    // t5528-push-default.sh: "push to existing branch, upstream configured with different name"
    config(t, "branch.main.merge", "refs/heads/other-name");
    testCommit(t, "w", "eight");
    await push(t, "upstream");
    testCommit(t, "w", "nine");
    await push(t, "simple");
    await push(t, "current");
    // die_push_simple's advice depends on push.default and branch.autoSetupMerge
    await push(t, "");
    config(t, "branch.autoSetupMerge", "simple");
    await push(t, "");
  });

  it("central and triangular workflows, and the default", async () => {
    // test_pushdefault_workflow: main integrates with foo from parent1; pushes go to parent1
    // (central) or parent2 (triangular)
    const cases: Array<[string, boolean]> = [
      // t5528-push-default.sh: "push.default = current success in central workflows"
      ["current", false],
      // t5528-push-default.sh: "push.default = upstream success in central workflows"
      ["upstream", false],
      // t5528-push-default.sh: "push.default = simple failure in central workflows"
      ["simple", false],
      // t5528-push-default.sh: "push.default = matching success in central workflows"
      ["matching", false],
      // t5528-push-default.sh: "push.default = current success in triangular workflows"
      ["current", true],
      // t5528-push-default.sh: "push.default = upstream failure in triangular workflows"
      ["upstream", true],
      // t5528-push-default.sh: "push.default = simple success in triangular workflows"
      ["simple", true],
      // t5528-push-default.sh: "push.default = matching success in triangular workflows"
      ["matching", true],
      // t5528-push-default.sh: 'default behavior rejects non-simple push'
      ["", false],
      // t5528-push-default.sh: 'default triangular behavior acts like "current"'
      ["", true],
    ];
    const t = setup();
    for (const [mode, triangular] of cases) {
      config(t, "branch.main.remote", "parent1");
      config(t, "branch.main.merge", "refs/heads/foo");
      config(t, "remote.pushdefault", triangular ? "parent2" : "parent1");
      testCommit(t, "w", `commit-for-${mode || "default"}${triangular ? "-triangular" : ""}`);
      await push(t, mode);
    }
    // t5528-push-default.sh: 'default behavior allows "simple" push'
    config(t, "remote.pushdefault", "parent1");
    config(t, "branch.main.merge", "refs/heads/main");
    testCommit(t, "w", "default-main-main");
    await push(t, "");
  });

  it("upstream with multiple upstream branches, tracking as upstream, a detached HEAD", async () => {
    const t = setup();
    config(t, "branch.main.remote", "parent1");
    config(t, "branch.main.merge", "refs/heads/foo");
    both(t, "w", "config", "--add", "branch.main.merge", "refs/heads/bar");
    testCommit(t, "w", "multi");
    for (const mode of ["upstream", "simple", "tracking"]) await push(t, mode);
    unconfig(t, "branch.main.merge");
    config(t, "branch.main.merge", "refs/heads/foo");
    await push(t, "tracking");
    // message_detached_head_die
    both(t, "w", "checkout", "-q", "--detach");
    for (const mode of ["simple", "current", "upstream", "matching", "nothing"]) {
      await push(t, mode);
    }
  });

  // t5516-fetch-push.sh: "with no remote.$name.push, upstream mapping is used"
  it("a branch named on the command line goes to its upstream under push.default=upstream", async () => {
    const t = setup();
    config(t, "push.default", "upstream");
    config(t, "branch.main.remote", "parent1");
    config(t, "branch.main.merge", "refs/heads/trunk");
    both(t, "w", "branch", "next");
    await push(t, "", "parent1", "main");
    // a remote that is not the branch's: still mapped (set_refspecs asks the branch alone)
    await push(t, "", "parent2", "main");
    // ... not without upstream mode, nor for a name that is not a branch of ours alone
    await push(t, "current", "parent1", "main");
    both(t, "w", "tag", "next");
    await push(t, "", "parent1", "next");
  });

  // t5516-fetch-push.sh: "pushing a specific ref applies remote.$name.push as refmap"
  it("a branch named on the command line goes where remote.<name>.push maps it", async () => {
    const t = setup();
    config(t, "remote.parent1.push", "+refs/heads/*:refs/remotes/src/*");
    both(t, "w", "branch", "next");
    await push(t, "", "parent1", "main");
    // t5516-fetch-push.sh: "with no remote.$name.push, it is not used as refmap"
    await push(t, "matching", "parent2", "main");
  });
});
