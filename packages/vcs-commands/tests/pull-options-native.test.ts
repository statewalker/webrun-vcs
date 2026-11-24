/**
 * `git pull`'s options against native git (t5521-pull-options), and the merge and fetch
 * options pull passes on (builtin/pull.c `run_merge`, `run_fetch`): `--squash`,
 * `--no-commit`, `--edit`, `--log`, `--signoff`, `--cleanup`, `--no-verify`, `--force`,
 * `--all`, `--dry-run`, `--tags`, `--prune`, `--depth`/`--deepen`/`--unshallow`. Remotes are
 * local (paths, `file://`), so the twins run on any git build.
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CleanupMode, FastForwardMode, type PullCommand, TagOption } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { PullTwins } from "./pull-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let t: PullTwins;
let sources = 0;

const put = (dir: string, path: string, text: string) => writeFileSync(join(dir, path), text);

/** git's test_commit: `<name>.t` holding the name, committed and tagged. */
const testCommit = (dir: string, name: string) => {
  put(dir, `${name}.t`, `${name}\n`);
  t.git(dir, "add", `${name}.t`);
  t.git(dir, "commit", "-q", "-m", name);
  t.git(dir, "tag", name);
};

/** A new source repository `src<k>` beside the twins, built by `build`. */
const source = (build: (dir: string) => void): string => {
  const src = join(root, `src${sources++}`);
  t.git(root, "init", "-q", "-b", "main", src);
  build(src);
  return src;
};

describeGit("git pull options: as native git (t5521-pull-options)", { timeout: 120_000 }, () => {
  let parent: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pull-options-native-"));
    t = new PullTwins(root);
    parent = source((dir) => {
      put(dir, "file", "one\n");
      t.git(dir, "add", "file");
      t.git(dir, "commit", "-q", "-m", "one");
    });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const empty = (dir: string) => t.git(dir, "init", "-q", "-b", "main");
  const rel = (path: string) => `../${path.slice(root.length + 1)}`;

  it('t5521-pull-options.sh: "git pull --cleanup errors early on invalid argument"', async () => {
    const dirs = t.pair(empty);
    const native = t.run(dirs.n, ["pull", "--no-rebase", "--cleanup", "invalid", rel(parent)]);
    expect(native.status).not.toBe(0);
    const ours = await t.outcome(async () =>
      (await t.ours(dirs.o))
        .pull()
        .setRebase(false)
        .setCleanupMode("invalid")
        .setRemote(rel(parent))
        .call(),
    );
    t.expectSame("--cleanup invalid", dirs, native, ours);
    expect(existsSync(join(dirs.o, ".git/FETCH_HEAD"))).toBe(false);
  });

  it('t5521-pull-options.sh: "git pull --force"', async () => {
    const dirs = t.pair((dir) => {
      empty(dir);
      const config = join(dir, ".git/config");
      writeFileSync(
        config,
        `${readFileSync(config, "utf8")}[remote "one"]\n\turl = ${rel(parent)}\n\tfetch = refs/heads/main:refs/heads/mirror\n[remote "two"]\n\turl = ${rel(parent)}\n\tfetch = refs/heads/main:refs/heads/origin\n[branch "main"]\n\tremote = two\n\tmerge = refs/heads/main\n`,
      );
    });
    const first = t.run(dirs.n, ["pull", "two"]);
    const ours1 = await t.outcome(async () =>
      (await t.ours(dirs.o)).pull().setRemote("two").call(),
    );
    t.expectSame("pull two", dirs, first, ours1);
    for (const dir of [dirs.n, dirs.o]) {
      testCommit(dir, "A");
      t.git(dir, "branch", "-f", "origin");
    }
    const native = t.run(dirs.n, ["pull", "--no-rebase", "--all", "--force"]);
    expect(native.status).toBe(0);
    const ours = await t.outcome(async () =>
      (await t.ours(dirs.o)).pull().setRebase(false).setAll(true).setForce(true).call(),
    );
    t.expectSame("pull --no-rebase --all --force", dirs, native, ours);
  });

  it('t5521-pull-options.sh: "git pull --all"', async () => {
    const dirs = t.pair((dir) => {
      empty(dir);
      const config = join(dir, ".git/config");
      writeFileSync(
        config,
        `${readFileSync(config, "utf8")}[remote "one"]\n\turl = ${rel(parent)}\n\tfetch = refs/heads/*:refs/remotes/one/*\n[remote "two"]\n\turl = ${rel(parent)}\n\tfetch = refs/heads/*:refs/remotes/two/*\n[branch "main"]\n\tremote = one\n\tmerge = refs/heads/main\n`,
      );
    });
    const native = t.run(dirs.n, ["pull", "--all"]);
    expect(native.status).toBe(0);
    const ours = await t.outcome(async () => (await t.ours(dirs.o)).pull().setAll(true).call());
    t.expectSame("pull --all", dirs, native, ours);
  });

  it('t5521-pull-options.sh: "git pull --dry-run", "git pull --all --dry-run"', async () => {
    for (const all of [false, true]) {
      const dirs = t.pair((dir) => {
        empty(dir);
        if (all) t.git(dir, "remote", "add", "origin", rel(parent));
      });
      const native = t.run(
        dirs.n,
        all ? ["pull", "--all", "--dry-run"] : ["pull", "--dry-run", rel(parent)],
      );
      expect(native.status).toBe(0);
      const ours = await t.outcome(async () => {
        const pull = (await t.ours(dirs.o)).pull().setDryRun(true);
        return (all ? pull.setAll(true) : pull.setRemote(rel(parent))).call();
      });
      t.expectSame(`--dry-run (all: ${all})`, dirs, native, ours);
      for (const dir of [dirs.n, dirs.o]) {
        expect(existsSync(join(dir, ".git/FETCH_HEAD"))).toBe(false);
        expect(existsSync(join(dir, ".git/index"))).toBe(false);
      }
    }
  });

  it('t5521-pull-options.sh: "git pull --allow-unrelated-histories"', async () => {
    const src = source((dir) => {
      testCommit(dir, "one");
      testCommit(dir, "two");
    });
    const dirs = t.pair((dir) => t.git(root, "clone", "-q", src, dir));
    t.git(src, "checkout", "-q", "--orphan", "side", "HEAD^");
    testCommit(src, "three");
    const refused = t.run(dirs.n, ["pull", rel(src), "side"]);
    expect(refused.status).not.toBe(0);
    const ours1 = await t.outcome(async () =>
      (await t.ours(dirs.o)).pull().setRemote(rel(src)).setRemoteBranchName("side").call(),
    );
    t.expectSame("unrelated", dirs, refused, ours1);
    const native = t.run(dirs.n, [
      "pull",
      "--no-rebase",
      "--allow-unrelated-histories",
      rel(src),
      "side",
    ]);
    expect(native.status).toBe(0);
    const ours = await t.outcome(async () =>
      (await t.ours(dirs.o))
        .pull()
        .setRebase(false)
        .setAllowUnrelatedHistories(true)
        .setRemote(rel(src))
        .setRemoteBranchName("side")
        .call(),
    );
    t.expectSame("--allow-unrelated-histories", dirs, native, ours);
  });

  /** A clone of a source with `one`, then `two` committed upstream. */
  const cloneThenUpstream = (): { dirs: { n: string; o: string }; src: string } => {
    const src = source((dir) => testCommit(dir, "one"));
    const dirs = t.pair((dir) => t.git(root, "clone", "-q", src, dir));
    testCommit(src, "two");
    return { dirs, src };
  };

  const signoffCases: [string, string[], (p: PullCommand) => PullCommand][] = [
    ["git pull does not add a sign-off line", [], (p) => p],
    [
      "git pull --no-signoff does not add sign-off line",
      ["--no-signoff"],
      (p) => p.setSignoff(false),
    ],
    ["git pull --signoff add a sign-off line", ["--signoff"], (p) => p.setSignoff(true)],
    [
      "git pull --no-signoff flag cancels --signoff flag",
      ["--signoff", "--no-signoff"],
      (p) => p.setSignoff(true).setSignoff(false),
    ],
  ];
  for (const [title, args, set] of signoffCases) {
    it(`t5521-pull-options.sh: "${title}"`, async () => {
      const { dirs } = cloneThenUpstream();
      const native = t.run(dirs.n, ["pull", ...args, "--no-ff"]);
      expect(native.status).toBe(0);
      const ours = await t.outcome(async () =>
        set((await t.ours(dirs.o)).pull().setFastForwardMode(FastForwardMode.NO_FF)).call(),
      );
      t.expectSame(title, dirs, native, ours);
      const trailers = (dir: string) =>
        t.git(dir, "show", "-s", "--pretty=format:%(trailers)", "HEAD");
      expect(trailers(dirs.o)).toBe(trailers(dirs.n));
    });
  }

  for (const [title, args, set, ok] of [
    [
      "git pull --no-verify flag passed to merge",
      ["--no-verify"],
      (p: PullCommand) => p.setNoVerify(true),
      true,
    ],
    [
      "git pull --no-verify --verify passed to merge",
      ["--no-verify", "--verify"],
      (p: PullCommand) => p.setNoVerify(true).setNoVerify(false),
      false,
    ],
  ] as const) {
    it(`t5521-pull-options.sh: "${title}"`, async () => {
      const { dirs } = cloneThenUpstream();
      for (const dir of [dirs.n, dirs.o]) {
        const hook = join(dir, ".git/hooks/commit-msg");
        writeFileSync(hook, "#!/bin/sh\nfalse\n");
        chmodSync(hook, 0o755);
      }
      const native = t.run(dirs.n, ["pull", "--no-ff", ...args]);
      expect(native.status === 0).toBe(ok);
      const ours = await t.outcome(async () =>
        set((await t.ours(dirs.o)).pull().setFastForwardMode(FastForwardMode.NO_FF)).call(),
      );
      t.expectSame(title, dirs, native, ours, { exact: false });
    });
  }
});

describeGit(
  "git pull passes merge and fetch options on (builtin/pull.c run_merge, run_fetch)",
  { timeout: 120_000 },
  () => {
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "pull-passed-native-"));
      t = new PullTwins(root);
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    /** A clone with a local commit, and two commits upstream: the pull merges. */
    const diverged = (config: Record<string, string> = {}) => {
      const src = source((dir) => testCommit(dir, "one"));
      const dirs = t.pair((dir) => {
        t.git(root, "clone", "-q", src, dir);
        for (const [key, value] of Object.entries(config)) t.git(dir, "config", key, value);
        testCommit(dir, "local");
      });
      testCommit(src, "two");
      testCommit(src, "three");
      return { dirs, src };
    };

    // the editor git runs (GIT_EDITOR) and ours: the first line marked as edited
    const editorScript = () => {
      const path = join(root, "editor.sh");
      writeFileSync(
        path,
        '#!/bin/sh\nsed -e \'1s/^/edited: /\' "$1" >"$1.new" && mv "$1.new" "$1"\n',
      );
      chmodSync(path, 0o755);
      return path;
    };
    const edit = async (_path: string, text: string) => text.replace(/^/, "edited: ");

    const cases: [string, string[], (p: PullCommand) => PullCommand, Record<string, string>?][] = [
      ["--squash", ["--squash"], (p) => p.setSquash(true)],
      ["--no-commit", ["--no-commit"], (p) => p.setCommit(false)],
      ["--commit", ["--commit"], (p) => p.setCommit(true)],
      ["--log", ["--log"], (p) => p.setLog(true)],
      ["--log=1", ["--log=1"], (p) => p.setLog(1)],
      ["--no-log under merge.log", ["--no-log"], (p) => p.setLog(false), { "merge.log": "true" }],
      ["--no-edit", ["--no-edit"], (p) => p.setEdit(false)],
      ["--edit", ["--edit"], (p) => p.setEdit(true).setEditor(edit)],
      [
        "--edit --signoff",
        ["--edit", "--signoff"],
        (p) => p.setEdit(true).setEditor(edit).setSignoff(true),
      ],
      [
        "--edit --cleanup=verbatim",
        ["--edit", "--cleanup=verbatim"],
        (p) => p.setEdit(true).setEditor(edit).setCleanupMode(CleanupMode.VERBATIM),
      ],
      [
        "--edit --cleanup=scissors",
        ["--edit", "--cleanup=scissors"],
        (p) => p.setEdit(true).setEditor(edit).setCleanupMode(CleanupMode.SCISSORS),
      ],
      [
        "--cleanup=verbatim --log",
        ["--cleanup=verbatim", "--log"],
        (p) => p.setCleanupMode(CleanupMode.VERBATIM).setLog(true),
      ],
    ];
    for (const [label, args, set, config] of cases) {
      it(`pull --no-rebase ${label}`, async () => {
        const { dirs } = diverged(config);
        const native = t.run(dirs.n, ["pull", "--no-rebase", ...args], {
          GIT_EDITOR: editorScript(),
        });
        const ours = await t.outcome(async () =>
          set((await t.ours(dirs.o)).pull().setRebase(false)).call(),
        );
        t.expectSame(label, dirs, native, ours, { exact: false });
        const log = (dir: string) => t.git(dir, "log", "--format=%H%n%B", "-1");
        expect(log(dirs.o)).toBe(log(dirs.n));
      });
    }

    it("pull --tags: every tag fetched", async () => {
      const src = source((dir) => testCommit(dir, "one"));
      const dirs = t.pair((dir) => t.git(root, "clone", "-q", "--no-tags", src, dir));
      t.git(src, "checkout", "-q", "-b", "side");
      testCommit(src, "side");
      t.git(src, "checkout", "-q", "main");
      testCommit(src, "two");
      const native = t.run(dirs.n, ["pull", "--tags"]);
      const ours = await t.outcome(async () =>
        (await t.ours(dirs.o)).pull().setTagOpt(TagOption.FETCH_TAGS).call(),
      );
      t.expectSame("--tags", dirs, native, ours);
    });

    it("pull --prune: stale tracking refs removed", async () => {
      const src = source((dir) => {
        testCommit(dir, "one");
        t.git(dir, "branch", "gone");
      });
      const dirs = t.pair((dir) => t.git(root, "clone", "-q", src, dir));
      t.git(src, "branch", "-D", "gone");
      testCommit(src, "two");
      const native = t.run(dirs.n, ["pull", "--prune"]);
      const ours = await t.outcome(async () => (await t.ours(dirs.o)).pull().setPrune(true).call());
      t.expectSame("--prune", dirs, native, ours);
    });

    for (const [label, args, set] of [
      ["--depth=2", ["--depth=2"], (p: PullCommand) => p.setDepth(2)],
      ["--deepen=1", ["--deepen=1"], (p: PullCommand) => p.setDeepen(1)],
      ["--unshallow", ["--unshallow"], (p: PullCommand) => p.setUnshallow(true)],
    ] as const) {
      it(`pull ${label} into a shallow clone`, async () => {
        const src = source((dir) => {
          testCommit(dir, "one");
          testCommit(dir, "two");
          testCommit(dir, "three");
        });
        const dirs = t.pair((dir) => t.git(root, "clone", "-q", "--depth=1", `file://${src}`, dir));
        testCommit(src, "four");
        const native = t.run(dirs.n, ["pull", ...args]);
        expect(native.status).toBe(0);
        const ours = await t.outcome(async () => set((await t.ours(dirs.o)).pull()).call());
        t.expectSame(label, dirs, native, ours);
        const shallow = (dir: string) => readFileSync(join(dir, ".git/shallow"), "utf8");
        if (label === "--unshallow") {
          expect(existsSync(join(dirs.o, ".git/shallow"))).toBe(false);
        } else expect(shallow(dirs.o)).toBe(shallow(dirs.n));
        const log = (dir: string) => t.git(dir, "log", "--format=%H");
        expect(log(dirs.o)).toBe(log(dirs.n));
      });
    }

    it("pull --recurse-submodules is refused until submodule fetching lands", async () => {
      const { dirs } = diverged();
      await expect(
        (await t.ours(dirs.o)).pull().setRebase(false).setRecurseSubmodules(true).call(),
      ).rejects.toThrow(/--recurse-submodules is not supported/);
      // nothing fetched
      expect(t.git(dirs.o, "rev-parse", "origin/main")).toBe(t.git(dirs.o, "rev-parse", "one"));
    });
  },
);
