/**
 * `git pull` against native git (t5520-pull, t7601-merge-pull-config): pulls into the
 * void, `.` as a remote, git's refusals before and after the fetch, autostash with every
 * configuration, pull.rebase / branch.<name>.rebase, fast-forward modes and merge
 * strategies passed through. Remotes are local (a path or `.`), so the twins run on any
 * git build (the 2.56.1 one has no curl).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FastForwardMode, MergeStrategy, type PullCommand } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { nativeAtLeast, PullTwins } from "./pull-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let t: PullTwins;

const put = (dir: string, path: string, text: string) => writeFileSync(join(dir, path), text);

describeGit("git pull: as native git (t5520-pull)", { timeout: 120_000 }, () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pull-native-"));
    t = new PullTwins(root);
    // the source the void pulls take from (t5520's trash directory)
    const src = join(root, "src");
    t.git(root, "init", "-q", "-b", "main", src);
    put(src, "file", "file\n");
    t.git(src, "add", "file");
    t.git(src, "commit", "-q", "-m", "original");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const empty = (dir: string) => t.git(dir, "init", "-q", "-b", "main");

  it('t5520-pull.sh: "pulling into void"', async () => {
    const dirs = t.pair(empty);
    const native = t.run(dirs.n, ["pull", "../src"]);
    const ours = await t.outcome(async () =>
      (await t.ours(dirs.o)).pull().setRemote("../src").call(),
    );
    t.expectSame("pull ../src", dirs, native, ours);
    expect(native.status).toBe(0);
  });

  it('t5520-pull.sh: "pulling into void using main:main"', async () => {
    const dirs = t.pair(empty);
    const native = t.run(dirs.n, ["pull", "../src", "main:main"]);
    const ours = await t.outcome(async () =>
      (await t.ours(dirs.o)).pull().setRemote("../src").setRefSpecs("main:main").call(),
    );
    t.expectSame("pull ../src main:main", dirs, native, ours);
    expect(native.status).toBe(0);
  });

  for (const [title, build, ok] of [
    [
      "pulling into void does not overwrite untracked files",
      (dir: string) => put(dir, "file", "untracked\n"),
      false,
    ],
    [
      "pulling into void does not overwrite staged files",
      (dir: string) => {
        put(dir, "file", "alternate content\n");
        t.git(dir, "add", "file");
      },
      false,
    ],
    [
      "pulling into void does not remove new staged files",
      (dir: string) => {
        put(dir, "newfile", "new tracked file\n");
        t.git(dir, "add", "newfile");
      },
      true,
    ],
  ] as const) {
    it(`t5520-pull.sh: "${title}"`, async () => {
      const dirs = t.pair((dir) => {
        empty(dir);
        build(dir);
      });
      const native = t.run(dirs.n, ["pull", "../src", "main"]);
      expect(native.status === 0).toBe(ok);
      const ours = await t.outcome(async () =>
        (await t.ours(dirs.o)).pull().setRemote("../src").setRemoteBranchName("main").call(),
      );
      t.expectSame(title, dirs, native, ours, { exact: false });
    });
  }

  it('t5520-pull.sh: "pulling into void must not create an octopus"', async () => {
    const dirs = t.pair(empty);
    const native = t.run(dirs.n, ["pull", "../src", "main", "main"]);
    expect(native.status).toBe(128);
    const ours = await t.outcome(async () =>
      (await t.ours(dirs.o)).pull().setRemote("../src").setRefSpecs("main", "main").call(),
    );
    expect(ours.status).toBe(128);
    t.expectSame("octopus into void", dirs, native, ours);
  });

  /** t5520's main history: `file` committed, branch `copy` tracking main through `.`. */
  const dotRemote = (dir: string) => {
    t.git(dir, "init", "-q", "-b", "main");
    put(dir, "file", "file\n");
    t.git(dir, "add", "file");
    t.git(dir, "commit", "-q", "-m", "original");
    t.git(dir, "branch", "copy", "main");
    t.git(dir, "config", "branch.copy.remote", ".");
    t.git(dir, "config", "branch.copy.merge", "refs/heads/main");
    put(dir, "file", "updated\n");
    t.git(dir, "commit", "-q", "-a", "-m", "updated");
    t.git(dir, "checkout", "-q", "copy");
  };

  it('t5520-pull.sh: "test . as a remote"', async () => {
    const dirs = t.pair(dotRemote);
    const native = t.run(dirs.n, ["pull"]);
    const ours = await t.outcome(async () => (await t.ours(dirs.o)).pull().call());
    t.expectSame("pull from .", dirs, native, ours);
    for (const dir of [dirs.n, dirs.o]) {
      expect(t.git(dir, "reflog", "-1", "--format=%gs")).toBe("pull: Fast-forward\n");
    }
  });

  it('t5520-pull.sh: "the default remote . should not break explicit pull"', async () => {
    const dirs = t.pair((dir) => {
      dotRemote(dir);
      // copy as "test . as a remote" left it (at main), then back to its parent
      t.git(dir, "merge", "-q", "--ff-only", "main");
      t.git(dir, "checkout", "-q", "-b", "second", "main^");
      put(dir, "file", "modified\n");
      t.git(dir, "commit", "-q", "-a", "-m", "modified");
      t.git(dir, "checkout", "-q", "copy");
      t.git(dir, "reset", "-q", "--hard", "HEAD^");
    });
    const native = t.run(dirs.n, ["pull", "--no-rebase", ".", "second"]);
    const ours = await t.outcome(async () =>
      (await t.ours(dirs.o))
        .pull()
        .setRemote(".")
        .setRemoteBranchName("second")
        .setRebase(false)
        .call(),
    );
    t.expectSame("pull . second", dirs, native, ours);
  });

  it('t5520-pull.sh: "fail if wildcard spec does not match any refs"', async () => {
    const dirs = t.pair(dotRemote);
    const spec = "refs/nonexisting1/*:refs/nonexisting2/*";
    const native = t.run(dirs.n, ["pull", ".", spec]);
    expect(native.status).toBe(1);
    const ours = await t.outcome(async () =>
      (await t.ours(dirs.o)).pull().setRemote(".").setRefSpecs(spec).call(),
    );
    expect(ours.status).toBe(1);
    t.expectSame("wildcard", dirs, native, ours);
  });

  it('t5520-pull.sh: "fail if no branches specified with non-default remote"', async () => {
    const dirs = t.pair((dir) => {
      dotRemote(dir);
      t.git(dir, "remote", "add", "test_remote", ".");
    });
    const native = t.run(dirs.n, ["pull", "test_remote"]);
    expect(native.status).toBe(1);
    const ours = await t.outcome(async () =>
      (await t.ours(dirs.o)).pull().setRemote("test_remote").call(),
    );
    t.expectSame("non-default remote", dirs, native, ours);
  });

  it('t5520-pull.sh: "fail if no configuration for current branch", "pull --all: fail if no configuration for current branch"', async () => {
    for (const all of [false, true]) {
      const dirs = t.pair((dir) => {
        dotRemote(dir);
        t.git(dir, "remote", "add", "test_remote", ".");
        t.git(dir, "config", "--unset", "branch.copy.remote");
        t.git(dir, "config", "--unset", "branch.copy.merge");
      });
      const native = t.run(dirs.n, ["pull", ...(all ? ["--all"] : [])]);
      expect(native.status).toBe(1);
      const ours = await t.outcome(async () => (await t.ours(dirs.o)).pull().setAll(all).call());
      t.expectSame(`no configuration (all: ${all})`, dirs, native, ours);
    }
  });

  it('t5520-pull.sh: "fail if upstream branch does not exist"', async () => {
    const dirs = t.pair((dir) => {
      dotRemote(dir);
      t.git(dir, "config", "branch.copy.merge", "refs/heads/nonexisting");
    });
    const native = t.run(dirs.n, ["pull"]);
    expect(native.status).toBe(1);
    const ours = await t.outcome(async () => (await t.ours(dirs.o)).pull().call());
    t.expectSame("no upstream branch", dirs, native, ours);
  });

  /** main ("updated") and `second` ("modified") from the same parent; HEAD at a third. */
  const secondBranch = (dir: string) => {
    dotRemote(dir);
    t.git(dir, "checkout", "-q", "-b", "second", "main~");
    put(dir, "file", "modified\n");
    t.git(dir, "commit", "-q", "-a", "-m", "modified");
    t.git(dir, "checkout", "-q", "-b", "third", "second^");
  };

  it('t5520-pull.sh: "fail if the index has unresolved entries"', async () => {
    const dirs = t.pair((dir) => {
      secondBranch(dir);
      put(dir, "file", "modified2\n");
      t.git(dir, "commit", "-q", "-a", "-m", "modified2");
    });
    // a conflicting merge first, then pulls refused by the unmerged index, then by MERGE_HEAD
    const steps: { args: string[]; ours: (pull: PullCommand) => PullCommand; before?: string[] }[] =
      [
        { args: ["pull", "--no-rebase", ".", "second"], ours: (p) => p.setRebase(false) },
        { args: ["pull", ".", "second"], ours: (p) => p },
        { args: ["pull", ".", "second"], ours: (p) => p, before: ["add", "file"] },
      ];
    for (const step of steps) {
      if (step.before) for (const dir of [dirs.n, dirs.o]) t.git(dir, ...step.before);
      const native = t.run(dirs.n, step.args);
      expect(native.status).not.toBe(0);
      const ours = await t.outcome(async () =>
        step
          .ours((await t.ours(dirs.o)).pull().setRemote(".").setRemoteBranchName("second"))
          .call(),
      );
      t.expectSame(step.args.join(" "), dirs, native, ours, { exact: step.args.length === 3 });
    }
  });

  it('t5520-pull.sh: "fast-forwards working tree if branch head is updated", "fast-forward fails with conflicting work tree"', async () => {
    for (const conflict of [false, true]) {
      const dirs = t.pair((dir) => {
        secondBranch(dir);
        if (conflict) put(dir, "file", "conflict\n");
      });
      const native = t.run(dirs.n, ["pull", ".", "second:third"]);
      expect(native.status === 0).toBe(!conflict);
      const ours = await t.outcome(async () =>
        (await t.ours(dirs.o)).pull().setRemote(".").setRefSpecs("second:third").call(),
      );
      t.expectSame(`second:third (conflict: ${conflict})`, dirs, native, ours, {
        exact: false,
      });
    }
  });

  /** t5520's `--rebase` setup: `to-rebase` (file2) at before-rebase, `copy` changed `file`. */
  const beforeRebase = (dir: string) => {
    t.git(dir, "init", "-q", "-b", "main");
    put(dir, "file", "file\n");
    t.git(dir, "add", "file");
    t.git(dir, "commit", "-q", "-m", "original");
    t.git(dir, "branch", "to-rebase");
    put(dir, "file", "modified again\n");
    t.git(dir, "commit", "-q", "-a", "-m", "file");
    t.git(dir, "branch", "copy");
    t.git(dir, "checkout", "-q", "to-rebase");
    put(dir, "file2", "new\n");
    t.git(dir, "add", "file2");
    t.git(dir, "commit", "-q", "-m", "new file");
    t.git(dir, "tag", "before-rebase");
  };

  it('t5520-pull.sh: "--rebase fails with multiple branches"', async () => {
    const dirs = t.pair(beforeRebase);
    const native = t.run(dirs.n, ["pull", "--rebase", ".", "copy", "main"]);
    expect(native.status).toBe(128);
    const ours = await t.outcome(async () =>
      (await t.ours(dirs.o))
        .pull()
        .setRebase(true)
        .setRemote(".")
        .setRefSpecs("copy", "main")
        .call(),
    );
    t.expectSame("multiple branches", dirs, native, ours);
  });

  /** A pull option as git's command line spells it and as ours sets it. */
  type Opt = [string, (p: PullCommand) => PullCommand];
  const rebase: Opt = ["--rebase", (p) => p.setRebase(true)];
  const noRebase: Opt = ["--no-rebase", (p) => p.setRebase(false)];
  const autostash: Opt = ["--autostash", (p) => p.setAutoStash(true)];
  const noAutostash: Opt = ["--no-autostash", (p) => p.setAutoStash(false)];

  /** test_pull_autostash / test_pull_autostash_fail: a staged new file, then `pull . copy`. */
  async function pullAutostash(
    label: string,
    config: Record<string, string>,
    opts: Opt[],
    ok: boolean,
    parent: 1 | 2,
  ) {
    const dirs = t.pair((dir) => {
      beforeRebase(dir);
      for (const [key, value] of Object.entries(config)) t.git(dir, "config", key, value);
      put(dir, "new_file", "dirty\n");
      t.git(dir, "add", "new_file");
    });
    const native = t.run(dirs.n, ["pull", ...opts.map((o) => o[0]), ".", "copy"]);
    expect(native.status === 0, `${label}: ${native.stderr}`).toBe(ok);
    const ours = await t.outcome(async () => {
      let pull = (await t.ours(dirs.o)).pull().setRemote(".").setRemoteBranchName("copy");
      for (const o of opts) pull = o[1](pull);
      return pull.call();
    });
    t.expectSame(label, dirs, native, ours, { exact: false });
    if (ok) {
      for (const dir of [dirs.n, dirs.o]) {
        expect(t.git(dir, "rev-parse", `HEAD^${parent}`)).toBe(t.git(dir, "rev-parse", "copy"));
      }
    }
  }

  const autostashCases: [string, Record<string, string>, Opt[], boolean, 1 | 2][] = [
    // pull --rebase
    [
      "pull --rebase succeeds with dirty working directory and rebase.autostash set",
      { "rebase.autostash": "true" },
      [rebase],
      true,
      1,
    ],
    [
      "pull --rebase --autostash & rebase.autostash=true",
      { "rebase.autostash": "true" },
      [rebase, autostash],
      true,
      1,
    ],
    [
      "pull --rebase --autostash & rebase.autostash=false",
      { "rebase.autostash": "false" },
      [rebase, autostash],
      true,
      1,
    ],
    ["pull --rebase --autostash & rebase.autostash unset", {}, [rebase, autostash], true, 1],
    [
      "pull --rebase --no-autostash & rebase.autostash=true",
      { "rebase.autostash": "true" },
      [rebase, noAutostash],
      false,
      1,
    ],
    [
      "pull --rebase --no-autostash & rebase.autostash=false",
      { "rebase.autostash": "false" },
      [rebase, noAutostash],
      false,
      1,
    ],
    ["pull --rebase --no-autostash & rebase.autostash unset", {}, [rebase, noAutostash], false, 1],
    // pull --no-rebase
    [
      "pull succeeds with dirty working directory and merge.autostash set",
      { "merge.autostash": "true" },
      [noRebase],
      true,
      2,
    ],
    [
      "pull --autostash & merge.autostash=true",
      { "merge.autostash": "true" },
      [autostash, noRebase],
      true,
      2,
    ],
    [
      "pull --autostash & merge.autostash=false",
      { "merge.autostash": "false" },
      [autostash, noRebase],
      true,
      2,
    ],
    ["pull --autostash & merge.autostash unset", {}, [autostash, noRebase], true, 2],
    [
      "pull --no-autostash & merge.autostash=true",
      { "merge.autostash": "true" },
      [noAutostash, noRebase],
      false,
      2,
    ],
    [
      "pull --no-autostash & merge.autostash=false",
      { "merge.autostash": "false" },
      [noAutostash, noRebase],
      false,
      2,
    ],
    ["pull --no-autostash & merge.autostash unset", {}, [noAutostash, noRebase], false, 2],
    // pull.rebase
    ["pull --autostash & pull.rebase=true", { "pull.rebase": "true" }, [autostash], true, 1],
    ["pull --no-autostash & pull.rebase=true", { "pull.rebase": "true" }, [noAutostash], false, 1],
  ];
  for (const [title, config, opts, ok, parent] of autostashCases) {
    it(`t5520-pull.sh: "${title}"`, async () => {
      await pullAutostash(title, config, opts, ok, parent);
    });
  }

  // pull.autostash is git 2.51's: 2.43 ignores it
  const describePullAutostash = nativeAtLeast(2, 51) ? describe : describe.skip;
  describePullAutostash("pull.autostash (git 2.51+)", () => {
    const cases: [string, Record<string, string>, [Opt[], boolean, 1 | 2][]][] = [
      [
        "pull succeeds with dirty working directory and pull.autostash=true",
        { "pull.autostash": "true" },
        [
          [[rebase], true, 1],
          [[noRebase], true, 2],
          [[autostash, rebase], true, 1],
          [[autostash, noRebase], true, 2],
        ],
      ],
      [
        "pull fails with dirty working directory and pull.autostash=false",
        { "pull.autostash": "false" },
        [
          [[rebase], false, 1],
          [[noRebase], false, 2],
          [[noAutostash, rebase], false, 1],
          [[noAutostash, noRebase], false, 2],
        ],
      ],
      [
        "pull --autostash overrides pull.autostash=false",
        { "pull.autostash": "false" },
        [
          [[autostash, rebase], true, 1],
          [[autostash, noRebase], true, 2],
        ],
      ],
      [
        "pull --no-autostash overrides pull.autostash=true",
        { "pull.autostash": "true" },
        [
          [[noAutostash, rebase], false, 1],
          [[noAutostash, noRebase], false, 2],
        ],
      ],
      [
        "pull.autostash=true overrides rebase.autostash",
        { "pull.autostash": "true", "rebase.autostash": "false" },
        [[[rebase], true, 1]],
      ],
      [
        "pull.autostash=false overrides rebase.autostash",
        { "pull.autostash": "false", "rebase.autostash": "true" },
        [[[rebase], false, 1]],
      ],
      [
        "pull.autostash=true overrides merge.autostash",
        { "pull.autostash": "true", "merge.autostash": "false" },
        [[[noRebase], true, 2]],
      ],
      [
        "pull.autostash=false overrides merge.autostash",
        { "pull.autostash": "false", "merge.autostash": "true" },
        [[[noRebase], false, 2]],
      ],
    ];
    for (const [title, config, runs] of cases) {
      it(`t5520-pull.sh: "${title}"`, async () => {
        for (const [opts, ok, parent] of runs) await pullAutostash(title, config, opts, ok, parent);
      });
    }
  });

  it('t5520-pull.sh: "pull.rebase", "branch.to-rebase.rebase", "branch.to-rebase.rebase should override pull.rebase"', async () => {
    for (const config of [
      { "pull.rebase": "true" },
      { "branch.to-rebase.rebase": "true" },
      { "pull.rebase": "true", "branch.to-rebase.rebase": "false" },
    ]) {
      const dirs = t.pair((dir) => {
        beforeRebase(dir);
        for (const [key, value] of Object.entries(config)) t.git(dir, "config", key, value);
      });
      const native = t.run(dirs.n, ["pull", ".", "copy"]);
      const ours = await t.outcome(async () =>
        (await t.ours(dirs.o)).pull().setRemote(".").setRemoteBranchName("copy").call(),
      );
      t.expectSame(JSON.stringify(config), dirs, native, ours);
    }
  });

  it('t5520-pull.sh: "pull --rebase warns on --verify-signatures", "pull --rebase does not warn on --no-verify-signatures"', async () => {
    for (const verify of [true, false]) {
      const dirs = t.pair(beforeRebase);
      const flag = verify ? "--verify-signatures" : "--no-verify-signatures";
      const native = t.run(dirs.n, ["pull", "--rebase", flag, ".", "copy"]);
      const ours = await t.outcome(async () =>
        (await t.ours(dirs.o))
          .pull()
          .setRebase(true)
          .setVerifySignatures(verify)
          .setRemote(".")
          .setRemoteBranchName("copy")
          .call(),
      );
      t.expectSame(flag, dirs, native, ours);
      const warning = "warning: ignoring --verify-signatures for rebase";
      expect(native.stderr.includes(warning)).toBe(verify);
      expect(ours.result?.warnings ?? []).toEqual(verify ? [warning] : []);
    }
  });

  it('t5520-pull.sh: "pull --rebase dies early with dirty working directory"', async () => {
    const dirs = t.pair((dir) => {
      beforeRebase(dir);
      put(dir, "file", "dirty\n");
      t.git(dir, "add", "file");
    });
    const native = t.run(dirs.n, ["pull", "--rebase", ".", "copy"]);
    expect(native.status).not.toBe(0);
    const ours = await t.outcome(async () =>
      (await t.ours(dirs.o))
        .pull()
        .setRebase(true)
        .setRemote(".")
        .setRemoteBranchName("copy")
        .call(),
    );
    t.expectSame("dirty", dirs, native, ours, { exact: false });
  });

  it('t5520-pull.sh: "pull --rebase works on branch yet to be born"', async () => {
    const dirs = t.pair(empty);
    const native = t.run(dirs.n, ["pull", "--rebase", "../src", "main"]);
    const ours = await t.outcome(async () =>
      (await t.ours(dirs.o))
        .pull()
        .setRebase(true)
        .setRemote("../src")
        .setRemoteBranchName("main")
        .call(),
    );
    t.expectSame("unborn --rebase", dirs, native, ours);
    expect(native.status).toBe(0);
  });
});

describeGit("git pull: fast-forward modes (t7601-merge-pull-config)", { timeout: 120_000 }, () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pull-ff-native-"));
    t = new PullTwins(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** t7601's c0..c3: `c1` on main, `c2` (ahead) and `c3` (diverged) to pull. */
  const history = (dir: string) => {
    t.git(dir, "init", "-q", "-b", "main");
    for (const name of ["c0", "c1"]) {
      put(dir, `${name}.t`, `${name}\n`);
      t.git(dir, "add", `${name}.t`);
      t.git(dir, "commit", "-q", "-m", name);
      t.git(dir, "tag", name);
    }
    t.git(dir, "checkout", "-q", "-b", "ahead", "c1");
    put(dir, "c2.t", "c2\n");
    t.git(dir, "add", "c2.t");
    t.git(dir, "commit", "-q", "-m", "c2");
    t.git(dir, "checkout", "-q", "-b", "diverged", "c0");
    put(dir, "c3.t", "c3\n");
    t.git(dir, "add", "c3.t");
    t.git(dir, "commit", "-q", "-m", "c3");
    t.git(dir, "checkout", "-q", "main");
  };

  const ff: Record<string, (p: PullCommand) => PullCommand> = {
    "--ff": (p) => p.setFastForwardMode(FastForwardMode.FF),
    "--no-ff": (p) => p.setFastForwardMode(FastForwardMode.NO_FF),
    "--ff-only": (p) => p.setFastForwardMode(FastForwardMode.FF_ONLY),
    "--rebase": (p) => p.setRebase(true),
    "--no-rebase": (p) => p.setRebase(false),
  };

  const cases: [string, string[], Record<string, string>, string][] = [
    ["pull.rebase not set (not-fast-forward)", [], {}, "diverged"],
    [
      "pull.rebase not set and pull.ff=true (not-fast-forward)",
      [],
      { "pull.ff": "true" },
      "diverged",
    ],
    [
      "pull.rebase not set and pull.ff=false (not-fast-forward)",
      [],
      { "pull.ff": "false" },
      "diverged",
    ],
    [
      "pull.rebase not set and pull.ff=only (not-fast-forward)",
      [],
      { "pull.ff": "only" },
      "diverged",
    ],
    ["pull.rebase not set and --no-ff given (not-fast-forward)", ["--no-ff"], {}, "diverged"],
    ["pull.rebase not set and --ff-only given (not-fast-forward)", ["--ff-only"], {}, "diverged"],
    ["pull.rebase not set and --no-ff given", ["--no-ff"], {}, "ahead"],
    ["pull.rebase not set and --ff-only given", ["--ff-only"], {}, "ahead"],
    ["--ff-only overrides --rebase", ["--rebase", "--ff-only"], {}, "diverged"],
    ["--ff-only overrides --no-rebase", ["--ff-only", "--no-rebase"], {}, "diverged"],
    ["--rebase overrides --no-ff", ["--rebase", "--no-ff"], {}, "diverged"],
    [
      "--ff-only takes precedence over pull.rebase=true",
      ["--ff-only"],
      { "pull.rebase": "true" },
      "diverged",
    ],
    [
      "--ff-only takes precedence over pull.rebase=false",
      ["--ff-only"],
      { "pull.rebase": "false" },
      "diverged",
    ],
    ["--no-rebase works with --no-ff", ["--no-rebase", "--no-ff"], {}, "ahead"],
    ["pull.rebase=true and --no-ff", ["--no-ff"], { "pull.rebase": "true" }, "ahead"],
    ["pull.rebase=false and --no-ff", ["--no-ff"], { "pull.rebase": "false" }, "ahead"],
  ];
  for (const [title, args, config, branch] of cases) {
    it(`t7601-merge-pull-config.sh: "${title}"`, async () => {
      const dirs = t.pair((dir) => {
        history(dir);
        for (const [key, value] of Object.entries(config)) t.git(dir, "config", key, value);
      });
      const native = t.run(dirs.n, ["pull", ...args, ".", branch]);
      const ours = await t.outcome(async () => {
        let pull = (await t.ours(dirs.o)).pull().setRemote(".").setRemoteBranchName(branch);
        for (const a of args) pull = (ff[a] as (p: PullCommand) => PullCommand)(pull);
        return pull.call();
      });
      t.expectSame(`${args.join(" ")} ${JSON.stringify(config)} ${branch}`, dirs, native, ours, {
        exact: native.status === 128,
      });
    });
  }
});

describeGit(
  "git pull -s / -X: passed to the merge and the rebase (builtin/pull.c run_merge, run_rebase)",
  { timeout: 120_000 },
  () => {
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "pull-strategy-native-"));
      t = new PullTwins(root);
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    /** `file` changed on both sides, on the same line. */
    const conflicting = (dir: string) => {
      t.git(dir, "init", "-q", "-b", "main");
      put(dir, "file", "a\nb\nc\n");
      put(dir, "other", "o\n");
      t.git(dir, "add", ".");
      t.git(dir, "commit", "-q", "-m", "base");
      t.git(dir, "checkout", "-q", "-b", "side");
      put(dir, "file", "a\nside\nc\n");
      put(dir, "other", "o\nside\n");
      t.git(dir, "commit", "-q", "-a", "-m", "side");
      t.git(dir, "checkout", "-q", "main");
      put(dir, "file", "a\nmain\nc\n");
      t.git(dir, "commit", "-q", "-a", "-m", "main");
    };

    const cases: [string[], (p: PullCommand) => PullCommand][] = [
      [["--no-rebase", "-s", "ours"], (p) => p.setRebase(false).setStrategy(MergeStrategy.OURS)],
      [
        ["--no-rebase", "-s", "resolve"],
        (p) => p.setRebase(false).setStrategy(MergeStrategy.RESOLVE),
      ],
      [["--no-rebase", "-X", "ours"], (p) => p.setRebase(false).setStrategyOptions(["ours"])],
      [["--no-rebase", "-X", "theirs"], (p) => p.setRebase(false).setStrategyOptions(["theirs"])],
      [["--rebase", "-X", "theirs"], (p) => p.setRebase(true).setStrategyOptions(["theirs"])],
      [["--rebase", "-X", "ours"], (p) => p.setRebase(true).setStrategyOptions(["ours"])],
    ];
    for (const [args, set] of cases) {
      it(`pull ${args.join(" ")} . side`, async () => {
        const dirs = t.pair(conflicting);
        const native = t.run(dirs.n, ["pull", ...args, ".", "side"]);
        const ours = await t.outcome(async () =>
          set((await t.ours(dirs.o)).pull().setRemote(".").setRemoteBranchName("side")).call(),
        );
        t.expectSame(args.join(" "), dirs, native, ours, { exact: false });
        expect(t.git(dirs.o, "log", "--format=%H %s%n%b", "-3")).toBe(
          t.git(dirs.n, "log", "--format=%H %s%n%b", "-3"),
        );
      });
    }
  },
);
