/**
 * `git push` modes that choose the refs to push, against native git: matching (`:`),
 * `--delete` and `:<ref>`, `--prune`, `--all`/`--branches`, `--tags`, the `tag <name>`
 * shorthand, `--mirror` and `remote.<name>.mirror`, and the refusals of their combinations
 * (which git 2.43 and 2.5x word and order differently). The scenarios are
 * t5516-fetch-push.sh's (matching, delete and prune parts) and t5517-push-mirror.sh's, each
 * run as one sequence of steps on two identical directories: native `git push` in one, ours
 * in the other (see `push-modes-native-support.ts`), comparing the exit status, stderr and
 * the refs of the pusher and its remote.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { nativeGitAvailable, noMaintenance } from "./native-git-http-backend.js";
import { both, pushBoth, type Twins, twins } from "./push-modes-native-support.js";
import { gitOut, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;

/** A commit of `<file>` = `<content>` in `<side>/<cwd>` of both twins. */
function commit(t: Twins, cwd: string, file: string, content: string, message: string): void {
  for (const d of [t.n, t.o]) {
    const dir = join(d, cwd);
    putFile(dir, file, content);
    gitOut(root, dir, ["add", file]);
    gitOut(root, dir, ["commit", "-qm", message]);
  }
}

describeGit("push: delete, prune, all, tags (t5516-fetch-push.sh)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "push-modes-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** t5516's setup: `w` with two commits (`repo`, `second`). */
  function setup(): Twins {
    const t = twins(root, (dir) => {
      gitOut(root, dir, ["init", "-q", "-b", "main", "w"]);
    });
    commit(t, "w", "path1", "", "repo");
    commit(t, "w", "path2", "", "second");
    return t;
  }

  /** t5516's mk_test: a fresh `w/testrepo` whose `refs/<ref>` are each the first commit. */
  function mkTest(t: Twins, ...refs: string[]): void {
    for (const d of [t.n, t.o]) {
      const w = join(d, "w");
      rmSync(join(w, "testrepo"), { recursive: true, force: true });
      gitOut(root, w, ["init", "-q", "-b", "main", "testrepo"]);
      noMaintenance(join(w, "testrepo"));
      gitOut(root, w, [
        "config",
        "-f",
        "testrepo/.git/config",
        "receive.denyCurrentBranch",
        "warn",
      ]);
      for (const ref of refs) gitOut(root, w, ["push", "-q", "testrepo", `main^:refs/${ref}`]);
    }
  }

  const push = (t: Twins, ...args: string[]) => pushBoth(t, "w", ["push", ...args], ["w/testrepo"]);

  it("matching heads: `:`, non-fast-forward refusals, --force, `+:`", async () => {
    const t = setup();
    // t5516-fetch-push.sh: "push with matching heads"
    mkTest(t, "heads/main");
    await push(t, "testrepo", ":");
    // t5516-fetch-push.sh: "failed (non-fast-forward) push with matching heads"
    mkTest(t, "heads/main");
    await push(t, "testrepo", ":");
    both(t, "w", "commit", "-q", "--amend", "-massaged");
    await push(t, "testrepo");
    both(t, "w", "reset", "-q", "--hard", "main@{1}");
    // t5516-fetch-push.sh: "push --force with matching heads"
    mkTest(t, "heads/main");
    await push(t, "testrepo", ":");
    both(t, "w", "commit", "-q", "--amend", "-massaged");
    await push(t, "--force", "testrepo", ":");
    both(t, "w", "reset", "-q", "--hard", "main@{1}");
    // t5516-fetch-push.sh: "push with matching heads and forced update"
    mkTest(t, "heads/main");
    await push(t, "testrepo", ":");
    both(t, "w", "commit", "-q", "--amend", "-massaged");
    await push(t, "testrepo", "+:");
  });

  it("--delete: a branch, a tag, onelevel refs; its refusals", async () => {
    const t = setup();
    // t5516-fetch-push.sh: "allow deleting a ref using --delete"
    mkTest(t, "heads/main");
    both(t, "w/testrepo", "config", "receive.denyDeleteCurrent", "warn");
    await push(t, "testrepo", "--delete", "main");
    // t5516-fetch-push.sh: "allow deleting a tag using --delete"
    mkTest(t, "heads/main");
    both(t, "w", "tag", "-a", "-m", "dummy_message", "deltag", "heads/main");
    await push(t, "testrepo", "--tags");
    await push(t, "testrepo", "--delete", "tag", "deltag");
    // t5516-fetch-push.sh: "push --delete without args aborts"
    mkTest(t, "heads/main");
    await push(t, "testrepo", "--delete");
    // t5516-fetch-push.sh: "push --delete refuses src:dest refspecs"
    await push(t, "testrepo", "--delete", "main:foo");
    // t5516-fetch-push.sh: "push --delete refuses empty string"
    await push(t, "testrepo", "--delete", "");
    // t5516-fetch-push.sh: "push --delete onelevel refspecs"
    both(t, "w/testrepo", "update-ref", "refs/onelevel", "refs/heads/main");
    await push(t, "testrepo", "--delete", "refs/onelevel");
    // a ref the remote lacks, and the `:<ref>` form
    await push(t, "testrepo", "--delete", "nosuch");
    mkTest(t, "heads/main", "heads/topic");
    await push(t, "testrepo", ":topic", ":refs/heads/main");
  });

  it("--prune: with matching and with a pattern", async () => {
    const t = setup();
    // t5516-fetch-push.sh: "push --prune"
    mkTest(t, "heads/main", "heads/foo", "heads/bar");
    await push(t, "--prune", "testrepo", ":");
    // t5516-fetch-push.sh: "push --prune refspec"
    mkTest(t, "tmp/main", "tmp/foo", "tmp/bar");
    await push(t, "--prune", "testrepo", "refs/heads/*:refs/tmp/*");
    // --prune --all: every remote branch without a local one goes
    mkTest(t, "heads/main", "heads/foo", "tags/keep");
    await push(t, "--prune", "--all", "testrepo");
  });

  it("--all, --branches, --tags and the tag shorthand", async () => {
    const t = setup();
    both(t, "w", "branch", "side", "main^");
    both(t, "w", "tag", "light", "main^");
    both(t, "w", "tag", "-a", "-m", "annotated", "annotated");
    mkTest(t, "heads/main");
    await push(t, "--all", "testrepo");
    mkTest(t, "heads/main");
    await push(t, "--branches", "testrepo");
    // t5516-fetch-push.sh: "allow deleting a tag using --delete" (the --tags half)
    await push(t, "testrepo", "--tags");
    // --tags with a refspec pushes both
    mkTest(t, "heads/main");
    await push(t, "--tags", "testrepo", "side");
    // the shorthand, and its refusal without a name
    mkTest(t, "heads/main");
    await push(t, "testrepo", "tag", "light", "main");
    await push(t, "testrepo", "tag");
    // a name that matches nothing
    await push(t, "testrepo", "nosuch");
  });

  it("options that cannot be used together (worded per version)", async () => {
    const t = setup();
    mkTest(t, "heads/main");
    both(t, "w", "remote", "add", "up", "testrepo");
    for (const args of [
      ["--delete", "--tags", "testrepo", "x"],
      ["--delete", "--all", "testrepo", "x"],
      ["--delete", "--mirror", "testrepo", "x"],
      ["--all", "--tags", "testrepo"],
      ["--mirror", "--tags", "testrepo"],
      ["--all", "--mirror", "testrepo"],
      ["--all", "--mirror", "--tags", "testrepo"],
      ["--delete", "--mirror", "--all", "--tags", "testrepo", "x"],
      ["--all", "testrepo", "main"],
      ["--mirror", "testrepo", "main"],
      // 2.43 checks the refspecs before the remote, 2.5x after the combinations
      ["--all", "nosuch-remote", "tag"],
      ["--delete", "--all", "up", "a:b"],
    ]) {
      await push(t, ...args);
    }
    both(t, "w", "config", "remote.up.mirror", "true");
    await push(t, "--tags", "up");
    await push(t, "up", "main");
  });
});

describeGit("push --mirror (t5517-push-mirror.sh)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "push-mirror-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** t5517's mk_repo_pair: `mirror` (denyCurrentBranch warn) and `main` with remote `up`. */
  function mkRepoPair(mirrorRemote = false): Twins {
    return twins(root, (dir) => {
      gitOut(root, dir, ["init", "-q", "-b", "main", "mirror"]);
      noMaintenance(join(dir, "mirror"));
      gitOut(root, join(dir, "mirror"), ["config", "receive.denyCurrentBranch", "warn"]);
      gitOut(root, dir, ["init", "-q", "-b", "main", "main"]);
      const main = join(dir, "main");
      gitOut(root, main, ["remote", "add", "up", "../mirror"]);
      if (mirrorRemote) gitOut(root, main, ["config", "remote.up.mirror", "true"]);
    });
  }

  const push = (t: Twins, ...args: string[]) => pushBoth(t, "main", ["push", ...args], ["mirror"]);

  it("branches: creates, updates, force updates, removes, all together", async () => {
    // t5517-push-mirror.sh: "push mirror creates new branches"
    let t = mkRepoPair();
    commit(t, "main", "foo", "one\n", "one");
    await push(t, "--mirror", "up");
    // t5517-push-mirror.sh: "push mirror updates existing branches"
    commit(t, "main", "foo", "two\n", "two");
    await push(t, "--mirror", "up");
    // t5517-push-mirror.sh: "push mirror force updates existing branches"
    both(t, "main", "reset", "-q", "--hard", "HEAD^");
    await push(t, "--mirror", "up");
    // t5517-push-mirror.sh: "push mirror removes branches"
    t = mkRepoPair();
    commit(t, "main", "foo", "one\n", "one");
    both(t, "main", "branch", "remove", "main");
    await push(t, "--mirror", "up");
    both(t, "main", "branch", "-D", "remove");
    await push(t, "--mirror", "up");
    // t5517-push-mirror.sh: "push mirror adds, updates and removes branches together"
    t = mkRepoPair();
    commit(t, "main", "foo", "one\n", "one");
    both(t, "main", "branch", "remove", "main");
    await push(t, "--mirror", "up");
    both(t, "main", "branch", "-D", "remove");
    both(t, "main", "branch", "add", "main");
    commit(t, "main", "foo", "two\n", "two");
    await push(t, "--mirror", "up");
  });

  it("tags: creates, updates, force updates, removes, all together", async () => {
    // t5517-push-mirror.sh: "push mirror creates new tags"
    let t = mkRepoPair();
    commit(t, "main", "foo", "one\n", "one");
    both(t, "main", "tag", "-f", "tmain", "main");
    await push(t, "--mirror", "up");
    // t5517-push-mirror.sh: "push mirror updates existing tags"
    commit(t, "main", "foo", "two\n", "two");
    both(t, "main", "tag", "-f", "tmain", "main");
    await push(t, "--mirror", "up");
    // t5517-push-mirror.sh: "push mirror force updates existing tags"
    both(t, "main", "reset", "-q", "--hard", "HEAD^");
    both(t, "main", "tag", "-f", "tmain", "main");
    await push(t, "--mirror", "up");
    // t5517-push-mirror.sh: "push mirror removes tags"
    t = mkRepoPair();
    commit(t, "main", "foo", "one\n", "one");
    both(t, "main", "tag", "-f", "tremove", "main");
    await push(t, "--mirror", "up");
    both(t, "main", "tag", "-d", "tremove");
    await push(t, "--mirror", "up");
    // t5517-push-mirror.sh: "push mirror adds, updates and removes tags together"
    t = mkRepoPair();
    commit(t, "main", "foo", "one\n", "one");
    both(t, "main", "tag", "-f", "tmain", "main");
    both(t, "main", "tag", "-f", "tremove", "main");
    await push(t, "--mirror", "up");
    both(t, "main", "tag", "-d", "tremove");
    both(t, "main", "tag", "tadd", "main");
    commit(t, "main", "foo", "two\n", "two");
    both(t, "main", "tag", "-f", "tmain", "main");
    await push(t, "--mirror", "up");
  });

  it("remote.<name>.mirror", async () => {
    // t5517-push-mirror.sh: "remote.foo.mirror adds and removes branches"
    let t = mkRepoPair(true);
    commit(t, "main", "foo", "one\n", "one");
    both(t, "main", "branch", "keep", "main");
    both(t, "main", "branch", "remove", "main");
    await push(t, "up");
    both(t, "main", "branch", "-D", "remove");
    await push(t, "up");
    // t5517-push-mirror.sh: "remote.foo.mirror=no has no effect"
    t = mkRepoPair();
    commit(t, "main", "foo", "one\n", "one");
    both(t, "main", "config", "--add", "remote.up.mirror", "no");
    both(t, "main", "branch", "keep", "main");
    await push(t, "--mirror", "up");
    both(t, "main", "branch", "-D", "keep");
    await push(t, "up", ":");
    // t5517-push-mirror.sh: "push to mirrored repository with refspec fails"
    t = mkRepoPair();
    commit(t, "main", "foo", "one\n", "one");
    both(t, "main", "config", "--add", "remote.up.mirror", "true");
    await push(t, "up", "main");
  });

  it("--mirror with --dry-run and a ref the mirror has under refs/remotes/", async () => {
    const t = mkRepoPair();
    commit(t, "main", "foo", "one\n", "one");
    both(t, "main", "update-ref", "refs/remotes/x/y", "main");
    both(t, "mirror", "commit", "-q", "--allow-empty", "-m", "mirror's own");
    both(t, "mirror", "update-ref", "refs/notes/gone", "main");
    await push(t, "--mirror", "--dry-run", "up");
    await push(t, "--mirror", "up");
  });

  // do_push: remote.<name>.push applies under --mirror too; send_mirror deletes the rest
  it("a mirror push takes remote.<name>.push as its refspecs", async () => {
    for (const how of ["config", "flag"] as const) {
      const t = mkRepoPair();
      commit(t, "main", "foo", "one\n", "one");
      both(t, "main", "tag", "one");
      await push(t, "up", "main", "one");
      if (how === "config") both(t, "main", "config", "remote.up.mirror", "true");
      both(t, "main", "config", "remote.up.push", "refs/heads/*:refs/heads/*");
      both(t, "main", "tag", "-d", "one");
      both(t, "main", "tag", "two");
      both(t, "main", "update-ref", "refs/remotes/origin/main", "main");
      await (how === "config" ? push(t, "up") : push(t, "--mirror", "up"));
    }
  });
});
