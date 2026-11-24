/**
 * Merge strategies and strategy options against native git (statewalker-root#336): `-s
 * resolve` (git-merge-resolve and the trivial in-index merge), `-s subtree` and `-X
 * subtree[=<path>]` (match-trees.c's shift), the `-X` options that tune merge-ort's diffs
 * (whitespace, algorithm, rename detection), and `-s`/`-X` through cherry-pick, revert and
 * rebase. Each history is built twice, native git runs in one twin and ours in the other,
 * then status, index, every worktree file, the state files and git's messages are compared.
 * git-merge-one-file labels its markers with random temporary names (`.merge_file_XXXXXX`),
 * evened out before comparing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CherryPickStatus,
  type Git,
  MergeStatus,
  MergeStrategy,
  RebaseStatus,
  UnknownStrategyOptionError,
} from "../src/index.js";
import {
  git,
  gitOk,
  INTEROP_AUTHOR_ENV,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  ortLines,
  put,
  type Snapshot,
  snapshot,
} from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;
let modern = true;

/** The lines `git merge` prints that our `output` carries (no diffstat). */
const MERGE_LINE =
  /^(Trying |Nope\.|Wonderful\.|In-index merge|Simple merge|Auto-merging|Added |Adding |Removing |CONFLICT|Automatic merge failed|Merge made by|Error: Your local| {4}\S|Already up to date)/;

const evenOut = (s: Snapshot): Snapshot => {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.files)) {
    files[k] = v.replace(/\.merge_file_\w{6}/g, ".merge_file_X");
  }
  return { ...s, files };
};

const same = (ours: string, native: string) =>
  expect(evenOut(snapshot(root, ours, normalizeState))).toEqual(
    evenOut(snapshot(root, native, normalizeState)),
  );

type Run = (...args: string[]) => string;

/** The same history built in two new repositories (native git builds both). */
function twins(build: (run: Run, dir: string) => void): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    build((...args) => gitOk(root, dir, ...args), dir);
  }
  return { native, ours };
}

const commitAll = (run: Run, message: string) => {
  run("add", "-A");
  run("commit", "-q", "--allow-empty", "-m", message);
};

async function oursMerge(dir: string, configure: (g: Git) => ReturnType<Git["merge"]>) {
  const command = configure(await openOurs(dir))
    .setAuthor(INTEROP_IDENT)
    .setCommitter(INTEROP_IDENT);
  return command.call();
}

/** Native `git merge <args>` and ours, compared; ours' result. */
async function compareMerge(
  dirs: { native: string; ours: string },
  args: string[],
  configure: (g: Git) => ReturnType<Git["merge"]>,
) {
  const expected = git(root, dirs.native, "merge", ...args);
  const result = await oursMerge(dirs.ours, configure);
  same(dirs.ours, dirs.native);
  const lines = (text: string) => text.split("\n").filter((l) => MERGE_LINE.test(l));
  expect((result.output ?? []).filter((l) => MERGE_LINE.test(l))).toEqual(lines(expected.stdout));
  return { result, expected };
}

// ---- t7605-merge-resolve -------------------------------------------------------------

/** t7605's setup: c1 adds c1.c, c2 adds c2.c, c3 adds a different c2.c, all on c0. */
function resolveSetup(run: Run, dir: string) {
  put(dir, "c0.c", "c0\n");
  commitAll(run, "c0");
  run("tag", "c0");
  put(dir, "c1.c", "c1\n");
  commitAll(run, "c1");
  run("tag", "c1");
  run("reset", "-q", "--hard", "c0");
  put(dir, "c2.c", "c2\n");
  commitAll(run, "c2");
  run("tag", "c2");
  run("reset", "-q", "--hard", "c0");
  put(dir, "c2.c", "c3\n");
  commitAll(run, "c3");
  run("tag", "c3");
}

const lines = (n: number, edit: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => `${edit[i + 1] ?? `line ${i + 1}`}\n`).join("");

describeGit("merge strategies against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-strategies-"));
    modern = gitAtLeast(gitOk(root, root, "--version"), 2, 44);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("-s resolve", () => {
    it('t7605-merge-resolve.sh: "merge c1 to c2"', async () => {
      const dirs = twins((run, dir) => {
        resolveSetup(run, dir);
        run("reset", "-q", "--hard", "c1");
      });
      const { result } = await compareMerge(dirs, ["-s", "resolve", "c2"], (g) =>
        g.merge().setStrategy(MergeStrategy.RESOLVE).include("c2"),
      );
      expect(result.status).toBe(MergeStatus.MERGED);
      expect(result.output).toContain("Wonderful.");
    });

    it('t7605-merge-resolve.sh: "merge c2 to c3 (fails)"', async () => {
      const dirs = twins((run, dir) => {
        resolveSetup(run, dir);
        run("reset", "-q", "--hard", "c2");
      });
      const { result, expected } = await compareMerge(dirs, ["-s", "resolve", "c3"], (g) =>
        g.merge().setStrategy(MergeStrategy.RESOLVE).include("c3"),
      );
      expect(expected.status).not.toBe(0);
      expect(result.status).toBe(MergeStatus.CONFLICTING);
      expect(result.message?.split("\n")).toEqual(
        expected.stderr
          .trim()
          .split("\n")
          .filter((l) => !/^hint:/.test(l)),
      );
    });

    it("a change on each side of one file: not trivial, merged by git-merge-one-file", async () => {
      const dirs = twins((run, dir) => {
        put(dir, "f", lines(10));
        put(dir, "g", "g\n");
        commitAll(run, "base");
        run("checkout", "-q", "-b", "side");
        put(dir, "f", lines(10, { 9: "side" }));
        run("rm", "-q", "g");
        commitAll(run, "side");
        run("checkout", "-q", "main");
        put(dir, "f", lines(10, { 2: "main" }));
        commitAll(run, "main");
      });
      const { result } = await compareMerge(dirs, ["-s", "resolve", "side"], (g) =>
        g.merge().setStrategy(MergeStrategy.RESOLVE).include("side"),
      );
      expect(result.status).toBe(MergeStatus.MERGED);
    });

    it("--no-commit skips the trivial merge and stops before the commit", async () => {
      const dirs = twins((run, dir) => {
        resolveSetup(run, dir);
        run("reset", "-q", "--hard", "c1");
      });
      const { result } = await compareMerge(dirs, ["--no-commit", "-s", "resolve", "c2"], (g) =>
        g.merge().setStrategy(MergeStrategy.RESOLVE).setCommit(false).include("c2"),
      );
      expect(result.status).toBe(MergeStatus.MERGED_NOT_COMMITTED);
    });

    it("a staged change refuses the trivial merge", async () => {
      const dirs = twins((run, dir) => {
        resolveSetup(run, dir);
        run("reset", "-q", "--hard", "c1");
        put(dir, "c0.c", "staged\n");
        run("add", "c0.c");
      });
      const expected = git(root, dirs.native, "merge", "-s", "resolve", "c2");
      const result = await oursMerge(dirs.ours, (g) =>
        g.merge().setStrategy(MergeStrategy.RESOLVE).include("c2"),
      );
      expect(result.status).toBe(MergeStatus.FAILED);
      expect(result.message).toBe(expected.stderr.trim());
      same(dirs.ours, dirs.native);
    });

    it("cherry-pick -s resolve, clean and conflicting", async () => {
      for (const pick of ["side~1", "side"]) {
        const dirs = twins((run, dir) => {
          put(dir, "f", lines(10));
          commitAll(run, "base");
          run("checkout", "-q", "-b", "side");
          put(dir, "g", "g\n");
          commitAll(run, "side 1");
          put(dir, "f", lines(10, { 3: "side" }));
          commitAll(run, "side 2");
          run("checkout", "-q", "main");
          put(dir, "f", lines(10, { 3: "main" }));
          commitAll(run, "main");
        });
        const expected = git(root, dirs.native, "cherry-pick", "--strategy=resolve", pick);
        const result = await (await openOurs(dirs.ours))
          .cherryPick()
          .setCommitter(INTEROP_IDENT)
          .setStrategy(MergeStrategy.RESOLVE)
          .include(pick)
          .call();
        same(dirs.ours, dirs.native);
        expect(result.status).toBe(
          expected.status === 0 ? CherryPickStatus.OK : CherryPickStatus.CONFLICTING,
        );
      }
    });
  });

  // ---- t6409-merge-subtree ------------------------------------------------------------

  describe("-s subtree and -X subtree", () => {
    const s = lines(8);

    it('t6409-merge-subtree.sh: "subtree available and works like recursive"', async () => {
      const dirs = twins((run, dir) => {
        put(dir, "hello", s);
        commitAll(run, "initial");
        run("checkout", "-q", "-b", "side");
        put(dir, "hello", `${s}world\n`);
        commitAll(run, "second");
        run("checkout", "-q", "main");
        put(dir, "hello", `mundo\n${s}`);
        commitAll(run, "main");
      });
      const { result } = await compareMerge(dirs, ["-s", "subtree", "side"], (g) =>
        g.merge().setStrategy(MergeStrategy.SUBTREE).include("side"),
      );
      expect(result.output).toContain("Merge made by the 'subtree' strategy.");
    });

    /** t6409's sub branch merged into topic as `dir/`, then updated with bar.t. */
    function subtreeSetup(run: Run, dir: string) {
      put(dir, "hello", s);
      commitAll(run, "initial");
      run("checkout", "-q", "--orphan", "sub");
      run("rm", "-rfq", ".");
      put(dir, "foo.t", "foo\n");
      commitAll(run, "foo");
      run("checkout", "-q", "-b", "topic", "main");
      run("merge", "-q", "-s", "ours", "--no-commit", "--allow-unrelated-histories", "sub");
      run("read-tree", "--prefix=dir/", "-u", "sub");
      run("commit", "-q", "-m", "initial merge of sub into topic");
      run("checkout", "-q", "sub");
      put(dir, "bar.t", "bar\n");
      commitAll(run, "bar");
      run("checkout", "-q", "topic");
    }

    it('t6409-merge-subtree.sh: "update topic branch"', async () => {
      const dirs = twins(subtreeSetup);
      const { result } = await compareMerge(
        dirs,
        ["-s", "subtree", "sub", "-m", "second merge of sub into topic"],
        (g) =>
          g
            .merge()
            .setStrategy(MergeStrategy.SUBTREE)
            .setMessage("second merge of sub into topic")
            .include("sub"),
      );
      expect(result.status).toBe(MergeStatus.MERGED);
    });

    /** t6409's git and git-gui: git-gui merged as `git-gui/` and (topic_2) as `git-gui2/`. */
    function guiSetup(run: Run, dir: string) {
      put(dir, "git.c", "git\n");
      commitAll(run, "initial git");
      run("checkout", "-q", "--orphan", "gui");
      run("rm", "-rfq", ".");
      put(dir, "git-gui.sh", "git-gui\n");
      commitAll(run, "initial git-gui");
      run("checkout", "-q", "-b", "gui_topic_2");
      put(dir, "git-gui.sh", "git-gui2\n");
      commitAll(run, "update git-gui");
      run("checkout", "-q", "main");
      run("merge", "-q", "-s", "ours", "--no-commit", "--allow-unrelated-histories", "gui");
      run("read-tree", "--prefix=git-gui/", "-u", "gui");
      run("commit", "-q", "-m", "Merge git-gui as our subdirectory");
      run("checkout", "-q", "-b", "topic_2");
      run("merge", "-q", "-s", "ours", "--no-commit", "gui");
      run("read-tree", "--prefix=git-gui2/", "-u", "gui");
      run("commit", "-q", "-m", "Merge git-gui2 as our subdirectory");
    }

    it('t6409-merge-subtree.sh: "merge update"', async () => {
      const dirs = twins((run, dir) => {
        guiSetup(run, dir);
        run("checkout", "-q", "main");
      });
      await compareMerge(dirs, ["-s", "subtree", "gui_topic_2"], (g) =>
        g.merge().setStrategy(MergeStrategy.SUBTREE).include("gui_topic_2"),
      );
    });

    it('t6409-merge-subtree.sh: "merge using explicit"', async () => {
      const dirs = twins(guiSetup);
      await compareMerge(dirs, ["-Xsubtree=git-gui", "gui_topic_2"], (g) =>
        g.merge().addStrategyOption("subtree=git-gui").include("gui_topic_2"),
      );
    });

    it('t6409-merge-subtree.sh: "merge2 using explicit"', async () => {
      const dirs = twins(guiSetup);
      await compareMerge(dirs, ["-Xsubtree=git-gui2", "gui_topic_2"], (g) =>
        g.merge().addStrategyOption("subtree=git-gui2").include("gui_topic_2"),
      );
    });

    it("-s subtree with the shift ambiguous, and cherry-pick -X subtree=<path>", async () => {
      const dirs = twins(guiSetup);
      await compareMerge(dirs, ["-s", "subtree", "gui_topic_2"], (g) =>
        g.merge().setStrategy(MergeStrategy.SUBTREE).include("gui_topic_2"),
      );
      const picks = twins(guiSetup);
      git(root, picks.native, "cherry-pick", "-Xsubtree=git-gui2", "gui_topic_2");
      const result = await (await openOurs(picks.ours))
        .cherryPick()
        .setCommitter(INTEROP_IDENT)
        .addStrategyOption("subtree=git-gui2")
        .include("gui_topic_2")
        .call();
      expect(result.status).toBe(CherryPickStatus.OK);
      same(picks.ours, picks.native);
    });
  });

  // ---- t6432-merge-recursive-space-options ----------------------------------------------

  describe("-X whitespace options", () => {
    const TEXT = [
      "    Hope, he says, cherishes the soul of him who lives in",
      "    justice and holiness and is the nurse of his age and the",
      "    companion of his journey;--hope which is mightiest to sway",
      "    the restless soul of man.",
      "",
      "How admirable are his words!  And the great blessing of riches, I do",
      "not say to every man, but to a good man, is, that he has had no",
      "occasion to deceive or to defraud others, either intentionally or",
      "unintentionally; and when he departs to the world below he is not in",
      "any apprehension about offerings due to the gods or debts which he owes",
      "to men.  Now to this peace of mind the possession of wealth greatly",
      "contributes; and therefore I say, that, setting one thing against",
      "another, of the many advantages which wealth has to give, to a man of",
      "sense this is in my opinion the greatest.",
      "",
      "Well said, Cephalus, I replied; but as concerning justice, what is",
      "it?--to speak the truth and to pay your debts--no more than this?  And",
      "even to this are there not exceptions?  Suppose that a friend when in",
      "his right mind has deposited arms with me and he asks for them when he",
      "is not in his right mind, ought I to give them back to him?  No one",
      "would say that I ought or that I should be right in doing so, any more",
      "than they would say that I ought always to speak the truth to one who",
      "is in his condition.",
      "",
      "You are quite right, he replied.",
      "",
      "But then, I said, speaking the truth and paying your debts is not a",
      "correct definition of justice.",
      "",
      "CEPHALUS - SOCRATES - POLEMARCHUS",
      "",
      "Quite correct, Socrates, if Simonides is to be believed, said",
      "Polemarchus interposing.",
      "",
      "I fear, said Cephalus, that I must go now, for I have to look after the",
      "sacrifices, and I hand over the argument to Polemarchus and the company.",
    ];
    // t6432's sed scripts of `remote` ("Remove cruft") and `main` ("Clarify")
    const remote = TEXT.filter((l) => l !== "CEPHALUS - SOCRATES - POLEMARCHUS").map((l) =>
      l
        .replace(/\. {2}/g, ". ")
        .replace(/\? {2}/g, "? ")
        .replace(/ {4}/g, "\t")
        .replace(/--/g, "---")
        .replace("but as concerning", "but as con cerning"),
    );
    const clarified = TEXT.map((l) => {
      let out = l.replace(/(not in his right mind),(.*)/, "$1;$2\r");
      out = out.replace(/Quite correct(.*)/, "It is too correct$1\r");
      out = out.replace("unintentionally", "un intentionally");
      if (out.includes("un intentionally")) out += "\r";
      out = out.replace("Polemarchus interposing.", "Polemarchus, interposing.\r");
      if (out.includes("justice and holiness")) out += "\r";
      if (out.includes("pay your debts")) out += "\r";
      return out;
    });
    const file = (ls: string[]) => ls.map((l) => `${l}\n`).join("");
    const setup = (run: Run, dir: string) => {
      put(dir, "text.txt", file(TEXT));
      commitAll(run, "Initial revision");
      run("checkout", "-q", "-b", "remote");
      put(dir, "text.txt", file(remote));
      commitAll(run, "Remove cruft");
      run("checkout", "-q", "main");
      put(dir, "text.txt", file(clarified));
      commitAll(run, "Clarify");
    };

    it('t6432-merge-recursive-space-options.sh: "naive merge fails"', async () => {
      const { result } = await compareMerge(twins(setup), ["remote"], (g) =>
        g.merge().include("remote"),
      );
      expect(result.status).toBe(MergeStatus.CONFLICTING);
    });

    for (const [title, option] of [
      ["--ignore-space-change makes merge succeed", "ignore-space-change"],
      ["--ignore-all-space drops their new spaces", "ignore-all-space"],
      ["--ignore-space-at-eol", "ignore-space-at-eol"],
    ]) {
      it(`t6432-merge-recursive-space-options.sh: "${title}"`, async () => {
        await compareMerge(twins(setup), [`-X${option}`, "remote"], (g) =>
          g.merge().addStrategyOption(option).include("remote"),
        );
      });
    }

    it("-X ignore-cr-at-eol", async () => {
      await compareMerge(twins(setup), ["-Xignore-cr-at-eol", "remote"], (g) =>
        g.merge().addStrategyOption("ignore-cr-at-eol").include("remote"),
      );
    });

    it('t6432-merge-recursive-space-options.sh: "naive cherry-pick fails"', async () => {
      const dirs = twins(setup);
      const expected = git(root, dirs.native, "cherry-pick", "remote");
      const result = await (await openOurs(dirs.ours))
        .cherryPick()
        .setCommitter(INTEROP_IDENT)
        .include("remote")
        .call();
      expect(result.status).toBe(CherryPickStatus.CONFLICTING);
      expect(result.output).toEqual(ortLines(expected.stdout));
      same(dirs.ours, dirs.native);
    });

    it('t6432-merge-recursive-space-options.sh: "-Xignore-space-change makes cherry-pick succeed"', async () => {
      const dirs = twins(setup);
      expect(
        git(root, dirs.native, "cherry-pick", "--no-commit", "-Xignore-space-change", "remote")
          .status,
      ).toBe(0);
      const result = await (await openOurs(dirs.ours))
        .cherryPick()
        .setCommitter(INTEROP_IDENT)
        .setNoCommit(true)
        .addStrategyOption("ignore-space-change")
        .include("remote")
        .call();
      expect(result.status).toBe(CherryPickStatus.OK);
      same(dirs.ours, dirs.native);
    });

    it("revert -X ignore-all-space", async () => {
      const dirs = twins((run, dir) => {
        setup(run, dir);
        run("merge", "-q", "-Xignore-all-space", "remote");
      });
      git(root, dirs.native, "revert", "--no-edit", "-Xignore-all-space", "HEAD^2");
      await (await openOurs(dirs.ours, INTEROP_AUTHOR_ENV))
        .revert()
        .setCommitter(INTEROP_IDENT)
        .addStrategyOption("ignore-all-space")
        .include("HEAD^2")
        .call();
      same(dirs.ours, dirs.native);
    });
  });

  // ---- t6434-merge-recursive-rename-options ---------------------------------------------

  describe("-X rename options", () => {
    const four = (p: string) => ["a", "b", "c", "d"].map((c) => `${p}${c}\n`).join("");
    const xs = (text: string, n: number) =>
      text
        .split("\n")
        .map((l, i) => (i < n && l ? `x${l.slice(1)}` : l))
        .join("\n");
    /** t6434's base, delete (main) and rename branches; rename checked out. */
    const setup = (run: Run, dir: string) => {
      for (const k of [0, 1, 2, 3]) put(dir, `${k}-old`, four(`${k}${k}`));
      commitAll(run, "base");
      for (const k of [0, 1, 2, 3]) run("rm", "-q", `${k}-old`);
      commitAll(run, "delete");
      run("checkout", "-q", "-b", "rename", "HEAD^");
      for (const k of [0, 1, 2, 3]) {
        put(dir, `${k}-new`, xs(four(`${k}${k}`), 3 - k));
        run("rm", "-q", `${k}-old`);
      }
      commitAll(run, "rename");
    };

    const cases: [string, string[]][] = [
      ["default similarity threshold is 50%", []],
      ["low rename threshold", ["find-renames=25%"]],
      ["medium rename threshold", ["find-renames=50%"]],
      ["high rename threshold", ["find-renames=75%"]],
      ["exact renames only", ["find-renames=100%"]],
      ["rename threshold is truncated", ["find-renames=200%"]],
      ["disabled rename detection", ["no-renames"]],
      [
        "last wins in --find-renames=<m> --find-renames=<n>",
        ["find-renames=25%", "find-renames=75%"],
      ],
      ["--find-renames resets threshold", ["find-renames=25%", "find-renames"]],
      ["last wins in --no-renames --find-renames", ["no-renames", "find-renames"]],
      ["last wins in --find-renames --no-renames", ["find-renames", "no-renames"]],
      ["rename-threshold=<n> is a synonym for find-renames=<n>", ["rename-threshold=25%"]],
      ["last wins in --no-renames --rename-threshold=<n>", ["no-renames", "rename-threshold=25%"]],
      ["last wins in --rename-threshold=<n> --no-renames", ["rename-threshold=25%", "no-renames"]],
    ];
    for (const [title, options] of cases) {
      it(`t6434-merge-recursive-rename-options.sh: "${title}"`, async () => {
        // git 2.43's merge-ort detects renames whatever it is told
        if (!modern && options.at(-1) === "no-renames") return;
        await compareMerge(twins(setup), [...options.map((o) => `-X${o}`), "main"], (g) =>
          g.merge().setStrategyOptions(options).include("main"),
        );
      });
    }

    it('t6434-merge-recursive-rename-options.sh: "merge.renames disables rename detection"', async () => {
      if (!modern) return;
      await compareMerge(
        twins((run, dir) => {
          setup(run, dir);
          run("config", "merge.renames", "false");
        }),
        ["main"],
        (g) => g.merge().include("main"),
      );
    });

    for (const [title, option] of [
      ["--find-renames rejects negative argument", "find-renames=-25"],
      ["--find-renames rejects non-numbers", "find-renames=0xf"],
      ["--rename-threshold=<n> rejects negative argument", "rename-threshold=-25"],
    ]) {
      it(`t6434-merge-recursive-rename-options.sh: "${title}"`, async () => {
        const dirs = twins(setup);
        const expected = git(root, dirs.native, "merge", `-X${option}`, "main");
        expect(expected.status).toBe(128);
        await expect(
          oursMerge(dirs.ours, (g) => g.merge().addStrategyOption(option).include("main")),
        ).rejects.toThrow(UnknownStrategyOptionError);
        expect(expected.stderr.trim()).toBe(`fatal: unknown strategy option: -X${option}`);
        same(dirs.ours, dirs.native);
      });
    }
  });

  // ---- t7615-diff-algo-with-mergy-operations --------------------------------------------

  describe("-X diff-algorithm", () => {
    // git 2.43's `recursive` is merge-recursive, not merge-ort (no AUTO_MERGE): it runs `ort`
    const recursive = () => (modern ? "recursive" : "ort");
    const recursiveStrategy = () => (modern ? MergeStrategy.RECURSIVE : MergeStrategy.ORT);
    const BASE =
      "int f(int x, int y)\n{\n        if (x == 0)\n        {\n                return y;\n        }\n        return x;\n}\n\nint g(size_t u)\n{\n        while (u < 30)\n        {\n                u++;\n        }\n        return u;\n}\n";
    const OURS =
      "int g(size_t u)\n{\n        while (u < 30)\n        {\n                u++;\n        }\n        return u;\n}\n\nint h(int x, int y, int z)\n{\n        if (z == 0)\n        {\n                return x;\n        }\n        return y;\n}\n";
    const THEIRS = BASE.replace("u < 30", "u > 34").replace("u++", "u--");
    const setup = (run: Run, dir: string) => {
      put(dir, "file.c", BASE);
      commitAll(run, "c0");
      run("tag", "c0");
      put(dir, "file.c", OURS);
      commitAll(run, "c1");
      run("tag", "c1");
      run("reset", "-q", "--hard", "c0");
      put(dir, "file.c", THEIRS);
      commitAll(run, "c2");
      run("tag", "c2");
      run("reset", "-q", "--hard", "c1");
    };

    it('t7615-diff-algo-with-mergy-operations.sh: "merge c2 to c1 with recursive merge strategy succeeds with -Xdiff-algorithm=histogram"', async () => {
      const { result } = await compareMerge(
        twins(setup),
        ["--strategy", recursive(), "-Xdiff-algorithm=histogram", "c2"],
        (g) =>
          g
            .merge()
            .setStrategy(recursiveStrategy())
            .addStrategyOption("diff-algorithm=histogram")
            .include("c2"),
      );
      expect(result.status).toBe(MergeStatus.MERGED);
    });

    it('t7615-diff-algo-with-mergy-operations.sh: "merge c2 to c1 with recursive merge strategy fails with the current default myers diff algorithm"', async () => {
      // git 2.43's merge-ort conflicts nowhere here, whatever the algorithm
      if (!modern) return;
      const { result } = await compareMerge(twins(setup), ["-Xdiff-algorithm=myers", "c2"], (g) =>
        g.merge().addStrategyOption("diff-algorithm=myers").include("c2"),
      );
      expect(result.status).toBe(MergeStatus.CONFLICTING);
    });

    it('t7615-diff-algo-with-mergy-operations.sh: "merge c2 to c1 with recursive merge strategy succeeds with diff.algorithm = histogram"', async () => {
      await compareMerge(
        twins((run, dir) => {
          setup(run, dir);
          run("config", "diff.algorithm", "histogram");
        }),
        ["c2"],
        (g) => g.merge().include("c2"),
      );
    });

    it('t7615-diff-algo-with-mergy-operations.sh: "cherry-pick c2 to c1 with recursive merge strategy succeeds with -Xdiff-algorithm=histogram"', async () => {
      const dirs = twins(setup);
      git(
        root,
        dirs.native,
        "cherry-pick",
        "--strategy",
        recursive(),
        "-Xdiff-algorithm=histogram",
        "c2",
      );
      await (await openOurs(dirs.ours))
        .cherryPick()
        .setCommitter(INTEROP_IDENT)
        .setStrategy(recursiveStrategy())
        .addStrategyOption("diff-algorithm=histogram")
        .include("c2")
        .call();
      same(dirs.ours, dirs.native);
    });

    it('t7615-diff-algo-with-mergy-operations.sh: "cherry-pick c2 to c1 with recursive merge strategy fails with the current default myers diff algorithm"', async () => {
      if (!modern) return;
      const dirs = twins(setup);
      git(
        root,
        dirs.native,
        "cherry-pick",
        "--strategy",
        "recursive",
        "-Xdiff-algorithm=myers",
        "c2",
      );
      const result = await (await openOurs(dirs.ours))
        .cherryPick()
        .setCommitter(INTEROP_IDENT)
        .setStrategy(MergeStrategy.RECURSIVE)
        .addStrategyOption("diff-algorithm=myers")
        .include("c2")
        .call();
      expect(result.status).toBe(CherryPickStatus.CONFLICTING);
      same(dirs.ours, dirs.native);
    });

    it("-X patience", async () => {
      await compareMerge(twins(setup), ["-Xpatience", "c2"], (g) =>
        g.merge().addStrategyOption("patience").include("c2"),
      );
    });
  });

  // ---- t3402-rebase-merge, t3501-revert-cherry-pick -------------------------------------

  describe("-s and -X through rebase and cherry-pick", () => {
    const T = "A quick brown fox\njumps over the lazy dog.";
    const original = Array.from({ length: 10 }, (_, i) => `${i + 1} ${T}\n`).join("");

    it('t3402-rebase-merge.sh: "rebase -Xtheirs"', async () => {
      const dirs = twins((run, dir) => {
        put(dir, "original", original);
        commitAll(run, "initial");
        put(dir, "original", `${original}11 ${T}\n`);
        commitAll(run, "main updates a bit.");
        put(dir, "original", `${original}11 ${T}\n12 ${T}\n`);
        commitAll(run, "main updates a bit more.");
        run("checkout", "-q", "-b", "conflicting", "main~2");
        put(dir, "original", `${original}AB ${T}\n`);
        commitAll(run, "conflicting");
      });
      expect(git(root, dirs.native, "rebase", "-Xtheirs", "main").status).toBe(0);
      const result = await (await openOurs(dirs.ours))
        .rebase()
        .setCommitter(INTEROP_IDENT)
        .addStrategyOption("theirs")
        .setUpstream("main")
        .call();
      expect(result.status).toBe(RebaseStatus.OK);
      same(dirs.ours, dirs.native);
    });

    /**
     * side adds c.txt, then puts `side` on a.txt's line 5; main changes that line to
     * `mainLine` (by default only its spacing, which `-X ignore-space-change` lets go).
     */
    const sideSetup =
      (mainLine = "line  5") =>
      (run: Run, dir: string) => {
        put(dir, "a.txt", lines(10));
        commitAll(run, "base");
        run("checkout", "-q", "-b", "side");
        put(dir, "c.txt", "c\n");
        commitAll(run, "side 1");
        put(dir, "a.txt", lines(10, { 5: "side" }));
        commitAll(run, "side 2");
        run("checkout", "-q", "main");
        put(dir, "a.txt", lines(10, { 5: mainLine }));
        commitAll(run, "main");
        run("checkout", "-q", "side");
      };

    it("rebase -X ignore-space-change, and a stop keeps strategy and strategy_opts", async () => {
      const clean = twins(sideSetup());
      expect(git(root, clean.native, "rebase", "-Xignore-space-change", "main").status).toBe(0);
      const done = await (await openOurs(clean.ours))
        .rebase()
        .setCommitter(INTEROP_IDENT)
        .addStrategyOption("ignore-space-change")
        .setUpstream("main")
        .call();
      expect(done.status).toBe(RebaseStatus.OK);
      same(clean.ours, clean.native);

      const stopped = twins(sideSetup("main"));
      git(root, stopped.native, "rebase", "-Xpatience", "-Xfind-renames=40%", "main");
      const result = await (await openOurs(stopped.ours))
        .rebase()
        .setCommitter(INTEROP_IDENT)
        .setStrategyOptions(["patience", "find-renames=40%"])
        .setUpstream("main")
        .call();
      expect(result.status).not.toBe(RebaseStatus.OK);
      same(stopped.ours, stopped.native);
    });

    it("rebase -s resolve and -s subtree", async () => {
      for (const strategy of [MergeStrategy.RESOLVE, MergeStrategy.SUBTREE]) {
        for (const mainLine of ["line 5 (main)", "main"]) {
          const dirs = twins(sideSetup(mainLine));
          git(root, dirs.native, "rebase", "-s", strategy, "main");
          await (await openOurs(dirs.ours))
            .rebase()
            .setCommitter(INTEROP_IDENT)
            .setStrategy(strategy)
            .setCompatibility(modern ? "2.56" : "2.43")
            .setUpstream("main")
            .call();
          same(dirs.ours, dirs.native);
        }
      }
    });

    it("several picks with -s and -X keep them in sequencer/opts", async () => {
      const dirs = twins((run, dir) => {
        sideSetup("main")(run, dir);
        put(dir, "d.txt", "d\n");
        commitAll(run, "side 3");
        run("checkout", "-q", "main");
      });
      git(
        root,
        dirs.native,
        "cherry-pick",
        "--strategy=ort",
        "-Xpatience",
        "side~2",
        "side~1",
        "side",
      );
      const result = await (await openOurs(dirs.ours))
        .cherryPick()
        .setCommitter(INTEROP_IDENT)
        .setStrategy(MergeStrategy.ORT)
        .addStrategyOption("patience")
        .include("side~2")
        .include("side~1")
        .include("side")
        .call();
      expect(result.status).toBe(CherryPickStatus.CONFLICTING);
      same(dirs.ours, dirs.native);
    });
  });
});
