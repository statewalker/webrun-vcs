/**
 * `git push -u`, `--follow-tags`, `--force`, `+<refspec>`, `--force-with-lease` and
 * `--force-if-includes`, against native git. Each case builds two identical directories
 * (`n/` and `o/`, the same steps run by native git in both), pushes from one with native
 * git and from the other with ours to local repositories, and compares the remote's refs,
 * the pusher's configuration and remote-tracking refs, the report on stderr and what `-u`
 * prints on stdout. The scenarios are git's: t5523-push-upstream.sh, the follow-tags part
 * of t5516-fetch-push.sh, t5533-push-cas.sh.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PushCommand, PushResult } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, noMaintenance } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** t/test-lib-functions.sh's test_commit: `<name>.t`, a commit `<name>`, a tag `<name>`. */
function testCommit(dir: string, name: string): void {
  putFile(dir, `${name}.t`, `${name}\n`);
  git(dir, "add", `${name}.t`);
  git(dir, "commit", "-qm", name);
  git(dir, "tag", name);
}

/** Two directories built by the same steps: `n` for native git, `o` for ours. */
interface Twins {
  n: string;
  o: string;
}

function twins(build: (dir: string) => void): Twins {
  const base = join(root, `t${counter++}`);
  const t = { n: join(base, "n"), o: join(base, "o") };
  for (const dir of [t.n, t.o]) {
    mkdirSync(dir, { recursive: true });
    build(dir);
  }
  return t;
}

/** A bare repository `<dir>/<name>` no native push starts background maintenance in. */
function bare(dir: string, name: string): void {
  git(dir, "init", "-q", "--bare", "-b", "main", name);
  noMaintenance(join(dir, name));
}

/** Every ref of a repository, with its value. */
const refsOf = (dir: string) => git(dir, "for-each-ref", "--format=%(refname) %(objectname)");

/** The `branch.*` configuration of a repository. */
const branchConfig = (dir: string) =>
  gitRun(root, dir, ["config", "--get-regexp", "^branch\\."]).stdout;

/** git's report lines: no hints, no "failed to push" error (ours throws or reports refusals). */
function reportLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("hint:") && !l.startsWith("error: failed to push"));
}

interface Outcome {
  native: { status: number | null; stdout: string; stderr: string };
  result?: PushResult;
  error?: unknown;
}

/**
 * Pushes with native git (`args`) in `<n>/<cwd>` and with ours (`configure`) in `<o>/<cwd>`;
 * compares the report, what `-u` printed, the refs of each repository in `compare` and the
 * pusher's `branch.*` configuration and remote-tracking refs.
 */
async function pushBoth(
  t: Twins,
  cwd: string,
  args: string[],
  configure: (push: PushCommand) => PushCommand,
  compare: string[],
): Promise<Outcome> {
  const native = gitRun(root, join(t.n, cwd), ["push", ...args]);
  const ours = await openOurs(
    t.o,
    createNodeGitHostEnvironment({ env: testEnv(root) }),
    undefined,
    cwd,
  );
  let result: PushResult | undefined;
  let error: unknown;
  try {
    result = await configure(ours.push()).call();
  } catch (e) {
    error = e;
  }
  const label = `git push ${args.join(" ")}`;
  expect(error, `${label}: ${native.stderr}`).toBeUndefined();
  const refused = (result?.remoteUpdates ?? []).some(
    (u) => u.status !== "ok" && u.status !== "up-to-date",
  );
  expect(refused, `${label}: refused`).toBe(native.status !== 0);
  expect(result?.display ?? [], `${label}: report`).toEqual(reportLines(native.stderr));
  expect(result?.upstreamMessages ?? [], `${label}: stdout`).toEqual(
    native.stdout.split("\n").filter((l) => l !== ""),
  );
  for (const dir of compare) {
    expect(refsOf(join(t.o, dir)), `${label}: refs of ${dir}`).toBe(refsOf(join(t.n, dir)));
  }
  expect(branchConfig(join(t.o, cwd)), `${label}: branch config`).toBe(
    branchConfig(join(t.n, cwd)),
  );
  return { native, result, error };
}

describeGit("push flags (native git)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "push-flags-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // t5523-push-upstream.sh
  describe("push -u / --set-upstream (t5523-push-upstream.sh)", () => {
    it("writes branch.<name>.remote/merge for each pushed branch, as git", async () => {
      const t = twins((dir) => {
        bare(dir, "parent");
        git(dir, "init", "-q", "-b", "main", "w");
        const w = join(dir, "w");
        git(w, "remote", "add", "upstream", "../parent");
        putFile(w, "file", "content\n");
        git(w, "add", "file");
        git(w, "commit", "-qm", "one");
      });
      const both = (args: string[], configure: (p: PushCommand) => PushCommand) =>
        pushBoth(t, "w", args, configure, ["w", "parent"]);
      const up = (p: PushCommand) => p.setRemote("upstream").setSetUpstream(true);

      // t5523-push-upstream.sh: "push -u main:main"
      await both(["-u", "upstream", "main:main"], (p) => up(p).setRefSpecs("main:main"));
      // t5523-push-upstream.sh: "push -u main:other"
      await both(["-u", "upstream", "main:other"], (p) => up(p).setRefSpecs("main:other"));
      // t5523-push-upstream.sh: "push -u --dry-run main:otherX"
      await both(["-u", "--dry-run", "upstream", "main:otherX"], (p) =>
        up(p).setDryRun(true).setRefSpecs("main:otherX"),
      );
      // t5523-push-upstream.sh: "push -u topic_2:topic_2", "push -u topic_2:other2", "push -u :topic_2"
      for (const d of [t.n, t.o]) git(join(d, "w"), "branch", "topic_2");
      await both(["-u", "upstream", "topic_2:topic_2"], (p) =>
        up(p).setRefSpecs("topic_2:topic_2"),
      );
      await both(["-u", "upstream", "topic_2:other2"], (p) => up(p).setRefSpecs("topic_2:other2"));
      await both(["-u", "upstream", ":topic_2"], (p) => up(p).setRefSpecs(":topic_2"));
      // t5523-push-upstream.sh: "push -u --all(the same behavior with--branches)"
      for (const d of [t.n, t.o]) {
        git(join(d, "w"), "branch", "all1");
        git(join(d, "w"), "branch", "all2");
      }
      await both(["-u", "--all"], (p) => p.setSetUpstream(true).setPushAll(true));
      // t5523-push-upstream.sh: "push -u HEAD"
      for (const d of [t.n, t.o]) git(join(d, "w"), "checkout", "-q", "-b", "headbranch");
      await both(["-u", "upstream", "HEAD"], (p) => up(p).setRefSpecs("HEAD"));
    });

    it("names a URL as the remote, rebases under branch.autoSetupRebase, skips tags and refusals", async () => {
      const t = twins((dir) => {
        bare(dir, "parent");
        git(dir, "init", "-q", "-b", "main", "w");
        const w = join(dir, "w");
        testCommit(w, "A");
        git(w, "branch", "side");
        testCommit(w, "B");
        git(w, "config", "branch.autoSetupRebase", "always");
      });
      const both = (args: string[], configure: (p: PushCommand) => PushCommand) =>
        pushBoth(t, "w", args, configure, ["w", "parent"]);
      // a path: branch.main.remote is the path as given
      await both(["-u", "../parent", "main", "A"], (p) =>
        p.setRemote("../parent").setSetUpstream(true).setRefSpecs("main", "A"),
      );
      // a refused ref sets nothing up, an up-to-date one does
      for (const d of [t.n, t.o]) {
        git(join(d, "w"), "config", "--remove-section", "branch.main");
      }
      await both(["-u", "../parent", "side:main", "main:topic"], (p) =>
        p.setRemote("../parent").setSetUpstream(true).setRefSpecs("side:main", "main:topic"),
      );
      await both(["-u", "../parent", "main"], (p) =>
        p.setRemote("../parent").setSetUpstream(true).setRefSpecs("main"),
      );
    });
  });

  // t5516-fetch-push.sh: "push does not follow tags by default", "push --follow-tags only
  // pushes relevant tags"
  describe("push --follow-tags (t5516-fetch-push.sh)", () => {
    const build = (dir: string) => {
      bare(dir, "dst");
      git(dir, "init", "-q", "-b", "main", "src");
      const src = join(dir, "src");
      testCommit(src, "base");
      git(src, "tag", "-m", "annotated", "tag");
      git(src, "tag", "light");
      git(src, "tag", "-m", "a tag of a blob", "blobtag", "HEAD:base.t");
      git(src, "tag", "-m", "a tag of a tag", "nested", "tag");
      git(src, "checkout", "-q", "-b", "another");
      git(src, "commit", "-q", "--allow-empty", "-m", "future commit");
      git(src, "tag", "-m", "future", "future");
      git(src, "checkout", "-q", "main");
    };

    // t5516-fetch-push.sh: "push does not follow tags by default"
    it("pushes no tags by default", async () => {
      const t = twins(build);
      await pushBoth(t, "src", ["../dst", "main"], (p) => p.setRemote("../dst").add("main"), [
        "dst",
      ]);
    });

    // t5516-fetch-push.sh: "push --follow-tags only pushes relevant tags"
    it("pushes the annotated tags the pushed refs reach that the remote lacks", async () => {
      const t = twins(build);
      await pushBoth(
        t,
        "src",
        ["--follow-tags", "../dst", "main"],
        (p) => p.setRemote("../dst").add("main").setFollowTags(true),
        ["dst"],
      );
      // the remote's own refs count as tips too: `future` is reachable from `another`
      for (const d of [t.n, t.o]) {
        git(join(d, "src"), "push", "-q", "../dst", "another");
        git(join(d, "src"), "commit", "-q", "--allow-empty", "-m", "more");
      }
      await pushBoth(
        t,
        "src",
        ["--follow-tags", "../dst", "main"],
        (p) => p.setRemote("../dst").add("main").setFollowTags(true),
        ["dst"],
      );
    });

    it("follows push.followTags, and --no-follow-tags overrides it", async () => {
      const t = twins((dir) => {
        build(dir);
        git(join(dir, "src"), "config", "push.followTags", "true");
      });
      await pushBoth(
        t,
        "src",
        ["--no-follow-tags", "../dst", "main"],
        (p) => p.setRemote("../dst").add("main").setFollowTags(false),
        ["dst"],
      );
      await pushBoth(t, "src", ["../dst", "another"], (p) => p.setRemote("../dst").add("another"), [
        "dst",
      ]);
    });
  });

  // t5533-push-cas.sh
  describe("--force, +refspec and --force-with-lease (t5533-push-cas.sh)", () => {
    /** setup_srcdst_basic: `src` (A, B, C, detached HEAD) and its clone `dst`. */
    const basic = (extra?: (dir: string) => void) =>
      twins((dir) => {
        git(dir, "init", "-q", "-b", "main", "tmpl");
        const tmpl = join(dir, "tmpl");
        for (const c of ["A", "B", "C"]) testCommit(tmpl, c);
        git(dir, "clone", "-q", "--no-local", "tmpl", "src");
        git(dir, "clone", "-q", "--no-local", "src", "dst");
        git(join(dir, "dst"), "remote", "set-url", "origin", "../src");
        git(join(dir, "src"), "checkout", "-q", "HEAD^0");
        noMaintenance(join(dir, "src"));
        extra?.(dir);
      });
    const commitIn = (t: Twins, repo: string, name: string, steps: string[][] = []) => {
      for (const d of [t.n, t.o]) {
        for (const s of steps) git(join(d, repo), ...s);
        testCommit(join(d, repo), name);
      }
    };

    // t5533-push-cas.sh: "push to update (protected)"
    it("push to update (protected): a stale expected value refuses", async () => {
      const t = basic();
      commitIn(t, "dst", "D");
      const r = await pushBoth(
        t,
        "dst",
        ["--force-with-lease=main:main", "origin", "main"],
        (p) => p.setRemote("origin").add("main").setForceWithLease("main", "main"),
        ["src", "dst"],
      );
      expect(r.native.stderr).toContain("stale info");
    });

    // t5533-push-cas.sh: "push to update (protected, forced)"
    it("push to update (protected, forced): --force wins over the lease", async () => {
      const t = basic();
      commitIn(t, "dst", "D");
      const r = await pushBoth(
        t,
        "dst",
        ["--force", "--force-with-lease=main:main", "origin", "main"],
        (p) => p.setRemote("origin").add("main").setForce(true).setForceWithLease("main", "main"),
        ["src", "dst"],
      );
      expect(r.native.stderr).toContain("forced update");
    });

    // t5533-push-cas.sh: "push to update (protected, tracking)", "push to update (protected, tracking, forced)"
    it("push to update (protected, tracking), with and without --force", async () => {
      for (const force of [false, true]) {
        const t = basic();
        commitIn(t, "src", "D", [["checkout", "-q", "main"]]);
        for (const d of [t.n, t.o]) git(join(d, "src"), "checkout", "-q", "HEAD^0");
        commitIn(t, "dst", "E");
        await pushBoth(
          t,
          "dst",
          [...(force ? ["--force"] : []), "--force-with-lease=main", "origin", "main"],
          (p) => p.setRemote("origin").add("main").setForce(force).setForceWithLease("main"),
          ["src", "dst"],
        );
      }
    });

    // t5533-push-cas.sh: "push to update (allowed)", "push to update (allowed, tracking)"
    it("push to update (allowed), with an expected revision and with the tracking value", async () => {
      for (const lease of [["main", "main^"], ["main"]] as const) {
        const t = basic();
        commitIn(t, "dst", "D");
        const r = await pushBoth(
          t,
          "dst",
          [`--force-with-lease=${lease.join(":")}`, "origin", "main"],
          (p) => p.setRemote("origin").add("main").setForceWithLease(lease[0], lease[1]),
          ["src", "dst"],
        );
        expect(r.native.stderr).not.toContain("forced update");
      }
    });

    // t5533-push-cas.sh: "push to update (allowed even though no-ff)"
    it("push to update (allowed even though no-ff)", async () => {
      const t = basic();
      commitIn(t, "dst", "D", [["reset", "-q", "--hard", "HEAD^"]]);
      const r = await pushBoth(
        t,
        "dst",
        ["--force-with-lease=main", "origin", "main"],
        (p) => p.setRemote("origin").add("main").setForceWithLease("main"),
        ["src", "dst"],
      );
      expect(r.native.stderr).toContain("forced update");
    });

    // t5533-push-cas.sh: "push to delete (protected)", "push to delete (protected, forced)", "push to delete (allowed)"
    it("push to delete: protected, protected and forced, allowed", async () => {
      const cases: [string[], (p: PushCommand) => PushCommand][] = [
        [["--force-with-lease=main:main^"], (p) => p.setForceWithLease("main", "main^")],
        [
          ["--force", "--force-with-lease=main:main^"],
          (p) => p.setForce(true).setForceWithLease("main", "main^"),
        ],
        [["--force-with-lease=main"], (p) => p.setForceWithLease("main")],
      ];
      for (const [args, configure] of cases) {
        const t = basic();
        await pushBoth(
          t,
          "dst",
          [...args, "origin", ":main"],
          (p) => configure(p.setRemote("origin").add(":main")),
          ["src", "dst"],
        );
      }
    });

    // t5533-push-cas.sh: "cover everything with default force-with-lease (protected)", "cover everything with default force-with-lease (allowed)"
    it("covers every pushed ref with a bare --force-with-lease (protected, then allowed after a fetch)", async () => {
      for (const fetch of [false, true]) {
        const t = basic((dir) => {
          git(join(dir, "src"), "branch", "nain", "main^");
          if (fetch) git(join(dir, "dst"), "fetch", "-q");
        });
        await pushBoth(
          t,
          "dst",
          ["--force-with-lease", "origin", "main", "main:nain"],
          (p) => p.setRemote("origin").add("main").add("main:nain").setForceWithLease(),
          ["src", "dst"],
        );
      }
    });

    // t5533-push-cas.sh: "new branch covered by force-with-lease", "new branch covered by force-with-lease (explicit)", "new branch already exists"
    it("new branches: covered by a lease, an explicit absent value, one that already exists", async () => {
      for (const exists of [false, true]) {
        for (const expect of [undefined, ""]) {
          const t = basic((dir) => {
            if (exists) {
              git(join(dir, "src"), "checkout", "-q", "-b", "branch", "main");
              testCommit(join(dir, "src"), "F");
            }
            git(join(dir, "dst"), "branch", "branch", "main");
          });
          await pushBoth(
            t,
            "dst",
            [`--force-with-lease=branch${expect === undefined ? "" : ":"}`, "origin", "branch"],
            (p) => p.setRemote("origin").add("branch").setForceWithLease("branch", expect),
            ["src", "dst"],
          );
        }
      }
    });

    it("an expected value given as an abbreviated id; the first matching lease wins", async () => {
      const t = basic();
      commitIn(t, "dst", "D", [["reset", "-q", "--hard", "HEAD^"]]);
      const c = git(join(t.n, "src"), "rev-parse", "--short", "main").trim();
      await pushBoth(
        t,
        "dst",
        [`--force-with-lease=main:${c}`, "--force-with-lease=main:main", "origin", "main"],
        (p) =>
          p
            .setRemote("origin")
            .add("main")
            .setForceWithLease("main", c)
            .setForceWithLease("main", "main"),
        ["src", "dst"],
      );
    });

    it("--force and +refspec force a non-fast-forward, a plain push refuses it", async () => {
      const cases: [string[], (p: PushCommand) => PushCommand][] = [
        [["origin", "main"], (p) => p.add("main")],
        [["--force", "origin", "main"], (p) => p.add("main").setForce(true)],
        [["origin", "+main"], (p) => p.add("+main")],
        [
          ["origin", "+main:main", "B:refs/tags/C"],
          (p) => p.add("+main:main").add("B:refs/tags/C"),
        ],
        [["origin", "+B:refs/tags/C"], (p) => p.add("+B:refs/tags/C")],
      ];
      for (const [args, configure] of cases) {
        const t = basic();
        commitIn(t, "dst", "D", [["reset", "-q", "--hard", "HEAD^"]]);
        await pushBoth(t, "dst", args, (p) => configure(p.setRemote("origin")), ["src", "dst"]);
      }
    });

    it("reports a lease under --porcelain as git does", async () => {
      const t = basic();
      commitIn(t, "dst", "D", [["reset", "-q", "--hard", "HEAD^"]]);
      const native = gitRun(root, join(t.n, "dst"), [
        "push",
        "--porcelain",
        "--force-with-lease=main:main",
        "origin",
        "main",
        "main:other",
      ]);
      const ours = await openOurs(
        t.o,
        createNodeGitHostEnvironment({ env: testEnv(root) }),
        undefined,
        "dst",
      );
      const result = await ours
        .push()
        .setRemote("origin")
        .setRefSpecs("main", "main:other")
        .setForceWithLease("main", "main")
        .call();
      expect(result.porcelain).toEqual(native.stdout.split("\n").filter((l) => l !== ""));
    });
  });

  // t5533-push-cas.sh, setup_src_dup_dst
  describe("--force-if-includes (t5533-push-cas.sh)", () => {
    /**
     * setup_src_dup_dst: `dst.git`, `src` and `dup` cloned from it; `dup` pushes `branch`
     * and more of `main` after `src` fetched and rebased.
     */
    const build = (dir: string) => {
      bare(dir, "dst.git");
      for (const c of ["src", "dup"]) {
        git(dir, "clone", "-q", "--no-local", "dst.git", c);
        git(join(dir, c), "remote", "set-url", "origin", "../dst.git");
      }
      const src = join(dir, "src");
      const dup = join(dir, "dup");
      for (const c of ["A", "B", "C"]) testCommit(src, c);
      git(src, "push", "-q", "origin", "main");
      git(dup, "fetch", "-q");
      git(dup, "merge", "-q", "origin/main");
      git(dup, "switch", "-q", "-c", "branch", "main~2");
      testCommit(dup, "D");
      testCommit(dup, "E");
      git(dup, "push", "-q", "origin", "--all");
      git(src, "switch", "-q", "main");
      git(src, "fetch", "-q", "--all");
      git(src, "branch", "-q", "branch", "--track", "origin/branch");
      git(src, "rebase", "-q", "origin/main");
      git(dup, "switch", "-q", "main");
      testCommit(dup, "F");
      testCommit(dup, "G");
      git(dup, "switch", "-q", "branch");
      testCommit(dup, "H");
      git(dup, "push", "-q", "origin", "--all");
    };
    /** Commits I on `branch` and J on `main` in `src`, then `extra` steps. */
    const work = (dir: string, extra: string[][] = []) => {
      const src = join(dir, "src");
      git(src, "switch", "-q", "branch");
      testCommit(src, "I");
      git(src, "switch", "-q", "main");
      testCommit(src, "J");
      for (const s of extra) git(src, ...s);
    };
    const both = (t: Twins, args: string[], configure: (p: PushCommand) => PushCommand) =>
      pushBoth(t, "src", args, configure, ["src", "dst.git"]);

    // t5533-push-cas.sh: 'background updates to remote can be mitigated with "--force-if-includes"'
    it("refuses refs whose remote-tracking value is in no reflog entry of the local ref", async () => {
      const t = twins((dir) => {
        build(dir);
        work(dir, [["fetch", "-q", "--all"]]);
      });
      const r = await both(t, ["--force-with-lease", "--force-if-includes", "--all"], (p) =>
        p.setForceWithLease().setForceIfIncludes(true).setPushAll(true),
      );
      expect(r.native.stderr).toContain("remote ref updated since checkout");
    });

    // t5533-push-cas.sh: 'background updates to remote can be mitigated with "push.useForceIfIncludes"'
    it("follows push.useForceIfIncludes", async () => {
      const t = twins((dir) => {
        build(dir);
        work(dir, [
          ["fetch", "-q", "--all"],
          ["config", "--local", "push.useForceIfIncludes", "true"],
        ]);
      });
      await both(t, ["--force-with-lease=main", "origin", "main"], (p) =>
        p.setRemote("origin").add("main").setForceWithLease("main"),
      );
    });

    // t5533-push-cas.sh: '"--force-if-includes" should be disabled for --force-with-lease="<refname>:<expect>"'
    it("is off for a lease with an expected value", async () => {
      const t = twins((dir) => {
        build(dir);
        work(dir);
      });
      const head = git(join(t.n, "src"), "rev-parse", "refs/remotes/origin/main").trim();
      for (const d of [t.n, t.o]) git(join(d, "src"), "fetch", "-q", "--all");
      const r = await both(t, ["--force-if-includes", `--force-with-lease=main:${head}`], (p) =>
        p.setForceIfIncludes(true).setForceWithLease("main", head),
      );
      expect(r.native.stderr).toContain("stale info");
    });

    // t5533-push-cas.sh: '"--force-if-includes" should allow forced update after a rebase ("pull --rebase")', '"--force-if-includes" should allow forced update after a rebase ("pull --rebase", local rebase)'
    it("allows a forced update after a rebase, also a local one", async () => {
      for (const local of [false, true]) {
        const t = twins((dir) => {
          build(dir);
          work(dir, [
            ["pull", "-q", "--rebase", "origin", "main"],
            ...(local ? [["rebase", "-q", "--onto", "HEAD~4", "HEAD~1"]] : []),
          ]);
        });
        await both(t, ["--force-if-includes", "--force-with-lease=main"], (p) =>
          p.setForceIfIncludes(true).setForceWithLease("main"),
        );
      }
    });

    // t5533-push-cas.sh: '"--force-if-includes" should allow deletes'
    it("allows deletes", async () => {
      const t = twins((dir) => {
        build(dir);
        const src = join(dir, "src");
        git(src, "switch", "-q", "branch");
        git(src, "pull", "-q", "--rebase", "origin", "branch");
      });
      await both(
        t,
        ["--force-if-includes", "--force-with-lease=branch", "origin", ":branch"],
        (p) =>
          p.setRemote("origin").add(":branch").setForceIfIncludes(true).setForceWithLease("branch"),
      );
    });
  });
});
