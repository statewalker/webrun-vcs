/**
 * `git rebase --onto <newbase> <upstream> [<branch>]`, `--keep-base`, `--fork-point` (the
 * upstream's reflog, the default for an implicit upstream, `rebase.forkPoint`) and
 * `git merge-base` (`--all`, `--octopus`, `--independent`, `--is-ancestor`, `--fork-point`)
 * against native git, on the fixtures of git's t3400-rebase, t3431-rebase-fork-point,
 * t3416-rebase-onto-threedots, t6010-merge-base and t6099-merge-base-side-exhaustion.
 *
 * Each rebase twin builds the script's fixture twice with native git (test_tick dates, so
 * the ids match), runs native `git rebase` on one and ours on the other, and compares HEAD,
 * the index, the worktree, the state files, every ref, the reflogs and what was printed.
 * merge-base reads only: ours and native git answer on the same repository.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GitApiError, type RebaseCommand, type RebaseResult } from "../src/index.js";
import {
  INTEROP_AUTHOR_ENV,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  snapshot,
} from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

/** Which git's messages to give: the native git's version */
const NATIVE_COMPAT: "2.43" | "2.56" = /^git version 2\.43\./.test(
  spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "",
)
  ? "2.43"
  : "2.56";

/** Native git in `cwd` with extra variables. */
function run(
  cwd: string,
  env: Record<string, string>,
  ...args: string[]
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    env: { ...nativeGitEnv(root), GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", ...env },
    encoding: "utf8",
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const native = (cwd: string, ...args: string[]) => run(cwd, {}, ...args);

/** A repository built as git's test scripts build theirs (test_tick, test_commit, test_merge). */
class Script {
  private time = 1112911933;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.git("init", "-q", "-b", "main");
  }
  /** test_tick */
  tick(): void {
    this.time += 60;
  }
  /** Native git dated as the last tick; it must succeed. */
  git(...args: string[]): string {
    const date = `${this.time} -0700`;
    const r = run(this.dir, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, ...args);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  }
  /** test_commit <message> [<file> [<contents> [<tag>]]] */
  commit(message: string, file = `${message}.t`, contents = message, tag = message): void {
    writeFileSync(join(this.dir, file), `${contents}\n`);
    this.git("add", "--", file);
    this.tick();
    this.git("commit", "-q", "-m", message);
    this.git("tag", tag);
  }
  /** test_merge <label> <commit> */
  merge(label: string, commit: string): void {
    this.tick();
    this.git("merge", "-q", "-m", label, commit);
    this.git("tag", label);
  }
}

/** The same script run twice: native git's twin and ours. */
function twins(build: (s: Script) => void): { native: string; ours: string } {
  const n = counter++;
  const dirs = { native: join(root, `native-${n}`), ours: join(root, `ours-${n}`) };
  build(new Script(dirs.native));
  build(new Script(dirs.ours));
  return dirs;
}

/** Every ref with its value, and the reflog of HEAD and every branch. */
function refsAndLogs(dir: string): { refs: string; logs: Record<string, string> } {
  const refs = native(dir, "for-each-ref", "--format=%(refname) %(objectname)").stdout;
  const logs: Record<string, string> = {};
  for (const ref of [
    "HEAD",
    ...native(dir, "for-each-ref", "--format=%(refname)", "refs/heads")
      .stdout.split("\n")
      .filter(Boolean),
  ]) {
    logs[ref] = native(dir, "reflog", "show", "--format=%H %gs", ref).stdout;
  }
  return { refs, logs };
}

/** What native git printed, without the progress and the final line ours does not print. */
function printed(r: { stdout: string; stderr: string }): string[] {
  return `${r.stdout}\n${r.stderr}`
    .split(/[\r\n]/)
    .filter((l) => l.trim() !== "" && !/^(Rebasing \(|Successfully rebased and updated)/.test(l));
}

function oursPrinted(result: RebaseResult): string[] {
  return [...(result.output ?? []), ...(result.message ? result.message.split("\n") : [])].filter(
    (l) => l !== "",
  );
}

/** An option of `git rebase` and the call of ours it stands for. */
type Step = (r: RebaseCommand) => RebaseCommand;

/**
 * `git rebase <args>` in the native twin and ours configured by `configure` in the other;
 * both must agree on the outcome, the repository and the output.
 */
async function rebaseTwins(
  dirs: { native: string; ours: string },
  args: string[],
  configure: Step,
): Promise<{ status: number; result?: RebaseResult; error?: GitApiError }> {
  const expected = native(dirs.native, "rebase", ...args);
  const git = await openOurs(dirs.ours, INTEROP_AUTHOR_ENV);
  let result: RebaseResult | undefined;
  let error: GitApiError | undefined;
  try {
    result = await configure(
      git.rebase().setCommitter(INTEROP_IDENT).setCompatibility(NATIVE_COMPAT),
    ).call();
  } catch (e) {
    if (!(e instanceof GitApiError)) throw e;
    error = e;
  }
  if (error) {
    expect(error.message).toBe(expected.stderr.trim());
    expect(error.exitCode).toBe(expected.status);
  } else {
    const ok = ["ok", "fast-forward", "up-to-date"].includes(result?.status ?? "");
    expect({ ok, printed: oursPrinted(result as RebaseResult) }).toEqual({
      ok: expected.status === 0,
      printed: printed(expected),
    });
  }
  expect(snapshot(root, dirs.ours, normalizeState)).toEqual(
    snapshot(root, dirs.native, normalizeState),
  );
  expect(refsAndLogs(dirs.ours)).toEqual(refsAndLogs(dirs.native));
  return { status: expected.status, result, error };
}

const subjects = (dir: string) => native(dir, "log", "--pretty=%s").stdout.trim().split("\n");

/** Our options for the arguments of `git rebase` the scripts use. */
function configureFor(args: string[]): Step {
  return (r) => {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string;
      if (a === "--onto") r.setOnto(args[++i] as string);
      else if (a === "--keep-base") r.setKeepBase(true);
      else if (a === "--fork-point") r.setForkPoint(true);
      else if (a === "--no-fork-point") r.setForkPoint(false);
      else if (a === "--root") r.setRoot(true);
      else if (a === "--no-reapply-cherry-picks") r.setReapplyCherryPicks(false);
      else if (a === "-i") r.runInteractively({});
      else if (a.startsWith("-") && a !== "-") throw new Error(`option ${a}`);
      else if (r.getUpstreamName() === undefined && !args.includes("--root")) r.setUpstream(a);
      else r.setBranch(a);
    }
    return r;
  };
}

describeGit("rebase --onto, --keep-base, --fork-point", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rebase-onto-"));
  });
  afterAll(async () => {
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  describe("t3431-rebase-fork-point", () => {
    // A---B---D---E    (main)
    //      \
    //       C*---F---G (side)
    const setup = (s: Script) => {
      s.git("config", "gc.reflogExpire", "never");
      s.git("config", "gc.reflogExpireUnreachable", "never");
      s.commit("A");
      s.commit("B");
      s.commit("C");
      s.git("branch", "-q", "-t", "side");
      s.git("reset", "-q", "--hard", "HEAD^");
      s.commit("D");
      s.commit("E");
      s.git("checkout", "-q", "side");
      s.commit("F");
      s.commit("G");
    };
    /** do_test_rebase's resets, then the fixture's config */
    const prepare =
      (config: [string, string][] = []) =>
      (s: Script) => {
        setup(s);
        s.git("checkout", "-q", "main");
        s.git("reset", "-q", "--hard", "E");
        s.git("checkout", "-q", "side");
        s.git("reset", "-q", "--hard", "G");
        for (const [k, v] of config) s.git("config", "--add", k, v);
      };
    const cases: [string, string[]][] = [
      ["G F E D B A", []],
      ["G F D B A", ["--onto", "D"]],
      ["G F C B A", ["--keep-base"]],
      ["G F C E D B A", ["--no-fork-point"]],
      ["G F C D B A", ["--no-fork-point", "--onto", "D"]],
      ["G F C B A", ["--no-fork-point", "--keep-base"]],
      ["G F E D B A", ["--fork-point", "refs/heads/main"]],
      ["G F E D B A", ["--fork-point", "main"]],
      ["G F D B A", ["--fork-point", "--onto", "D", "refs/heads/main"]],
      ["G F D B A", ["--fork-point", "--onto", "D", "main"]],
      ["G F B A", ["--fork-point", "--keep-base", "refs/heads/main"]],
      ["G F B A", ["--fork-point", "--keep-base", "main"]],
      ["G F C E D B A", ["refs/heads/main"]],
      ["G F C E D B A", ["main"]],
      ["G F C D B A", ["--onto", "D", "refs/heads/main"]],
      ["G F C D B A", ["--onto", "D", "main"]],
      ["G F C B A", ["--keep-base", "refs/heads/main"]],
      ["G F C B A", ["--keep-base", "main"]],
    ];
    for (const [expected, args] of cases) {
      it(
        `t3431-rebase-fork-point.sh: "git rebase ${args.join(" ")}"`.replace(/ "$/, '"'),
        async () => {
          const dirs = twins(prepare());
          await rebaseTwins(dirs, args, configureFor(args));
          expect(subjects(dirs.ours)).toEqual(expected.split(" "));
        },
      );
    }

    it('t3431-rebase-fork-point.sh: "git rebase --fork-point with ambiguous refname"', async () => {
      const dirs = twins((s) => {
        prepare()(s);
        s.git("checkout", "-q", "main");
        s.git("checkout", "-q", "-b", "one");
        s.git("checkout", "-q", "side");
        s.git("tag", "one");
      });
      const args = ["--fork-point", "--onto", "D", "one"];
      const { status } = await rebaseTwins(dirs, args, configureFor(args));
      expect(status).toBe(128);
    });

    it('t3431-rebase-fork-point.sh: "--fork-point and --root both given"', async () => {
      const dirs = twins(prepare());
      const args = ["--fork-point", "--root"];
      const { error } = await rebaseTwins(dirs, args, configureFor(args));
      expect(error?.message).toContain("cannot be used together");
    });

    const configCases: [string, [string, string][], string[], string][] = [
      ["rebase.forkPoint set to false", [["rebase.forkPoint", "false"]], [], "G F C E D B A"],
      // test_config_global's false comes before the repository's true, as a first value
      [
        "rebase.forkPoint set to false and then to true",
        [
          ["rebase.forkPoint", "false"],
          ["rebase.forkPoint", "true"],
        ],
        [],
        "G F E D B A",
      ],
      [
        "rebase.forkPoint set to false and command line says --fork-point",
        [["rebase.forkPoint", "false"]],
        ["--fork-point"],
        "G F E D B A",
      ],
      [
        "rebase.forkPoint set to true and command line says --no-fork-point",
        [["rebase.forkPoint", "true"]],
        ["--no-fork-point"],
        "G F C E D B A",
      ],
    ];
    for (const [title, config, args, expected] of configCases) {
      it(`t3431-rebase-fork-point.sh: "${title}"`, async () => {
        const dirs = twins(prepare(config));
        await rebaseTwins(dirs, args, configureFor(args));
        expect(subjects(dirs.ours)).toEqual(expected.split(" "));
      });
    }

    it('t3431-rebase-fork-point.sh: "rebase.forkPoint set to true and --root given"', async () => {
      const dirs = twins(prepare([["rebase.forkPoint", "true"]]));
      const { status } = await rebaseTwins(dirs, ["--root"], configureFor(["--root"]));
      expect(status).toBe(0);
    });
  });

  describe("t3416-rebase-onto-threedots", () => {
    //	    F---G topic
    //	   /
    // A---B---C---D---E main
    //      \   \ /
    //	\   x
    //	 \ / \
    //	  H---I---J---K side
    const setup = (s: Script) => {
      s.commit("A");
      s.commit("B");
      s.git("branch", "side");
      s.commit("C");
      s.git("branch", "topic");
      s.git("checkout", "-q", "side");
      s.commit("H");
      s.git("checkout", "-q", "main");
      s.tick();
      s.git("merge", "-q", "H");
      s.git("tag", "D");
      s.commit("E");
      s.git("checkout", "-q", "topic");
      s.commit("F");
      s.commit("G");
      s.git("checkout", "-q", "side");
      s.tick();
      s.git("merge", "-q", "C");
      s.git("tag", "I");
      s.commit("J");
      s.commit("K");
    };
    const on = (branch: string, at: string) => (s: Script) => {
      setup(s);
      s.git("checkout", "-q", branch);
      s.git("reset", "-q", "--hard", at);
    };
    const parent = (dir: string, rev: string) => native(dir, "rev-parse", rev).stdout.trim();

    const ok: [string, (s: Script) => void, string[], string, string][] = [
      [
        "rebase --onto main...topic",
        on("topic", "G"),
        ["--onto", "main...topic", "F"],
        "HEAD^1",
        "C^0",
      ],
      ["rebase --onto main...", on("topic", "G"), ["--onto", "main...", "F"], "HEAD^1", "C^0"],
      [
        "rebase -i --onto main...topic",
        on("topic", "G"),
        ["-i", "--onto", "main...topic", "F"],
        "HEAD^1",
        "C^0",
      ],
      [
        "rebase -i --onto main...",
        on("topic", "G"),
        ["-i", "--onto", "main...", "F"],
        "HEAD^1",
        "C^0",
      ],
      [
        "rebase --keep-base main from topic",
        on("topic", "G"),
        ["--keep-base", "main"],
        "HEAD~2",
        "C^0",
      ],
      [
        "rebase --keep-base main topic from main",
        (s) => {
          setup(s);
          s.git("checkout", "-q", "main");
          s.git("branch", "-f", "topic", "G");
        },
        ["--keep-base", "main", "topic"],
        "HEAD~2",
        "C^0",
      ],
      [
        "rebase -i --keep-base main from topic",
        on("topic", "G"),
        ["-i", "--keep-base", "main"],
        "HEAD~2",
        "C^0",
      ],
      [
        "rebase -i --keep-base main topic from main",
        (s) => {
          setup(s);
          s.git("checkout", "-q", "main");
          s.git("branch", "-f", "topic", "G");
        },
        ["-i", "--keep-base", "main", "topic"],
        "HEAD~2",
        "C^0",
      ],
      [
        "rebase --keep-base keeps cherry picks",
        (s) => {
          setup(s);
          s.git("checkout", "-q", "-f", "-B", "main", "E");
          s.git("cherry-pick", "F");
        },
        ["-i", "--keep-base", "HEAD", "G"],
        "HEAD",
        "G",
      ],
      [
        "rebase --keep-base --no-reapply-cherry-picks",
        (s) => {
          setup(s);
          s.git("checkout", "-q", "-f", "-B", "main", "E");
          s.git("cherry-pick", "F");
        },
        ["-i", "--keep-base", "--no-reapply-cherry-picks", "HEAD", "G"],
        "HEAD^",
        "C",
      ],
    ];
    for (const [title, build, args, rev, expected] of ok) {
      it(`t3416-rebase-onto-threedots.sh: "${title}"`, async () => {
        const dirs = twins(build);
        const { status } = await rebaseTwins(dirs, args, configureFor(args));
        expect(status).toBe(0);
        expect(parent(dirs.ours, rev)).toBe(parent(dirs.ours, expected));
      });
    }

    const refused: [string, (s: Script) => void, string[]][] = [
      ["rebase --onto main...side", on("side", "K"), ["--onto", "main...side", "J"]],
      [
        "rebase --onto main...side requires a single merge-base",
        on("side", "K"),
        ["-i", "--onto", "main...side", "J"],
      ],
      [
        "rebase --keep-base --onto incompatible",
        on("topic", "G"),
        ["--keep-base", "--onto", "main..."],
      ],
      ["rebase --keep-base --root incompatible", on("topic", "G"), ["--keep-base", "--root"]],
      ["rebase --keep-base main from side", on("side", "K"), ["--keep-base", "main"]],
      [
        "rebase --keep-base requires a single merge base",
        on("side", "K"),
        ["-i", "--keep-base", "main"],
      ],
    ];
    for (const [title, build, args] of refused) {
      it(`t3416-rebase-onto-threedots.sh: "${title}"`, async () => {
        const dirs = twins(build);
        const { status } = await rebaseTwins(dirs, args, configureFor(args));
        expect(status).not.toBe(0);
      });
    }
  });

  describe("t3400-rebase", () => {
    const setup = (s: Script) => {
      s.commit("Add A.", "A", "First", "First");
      s.git("checkout", "-q", "-b", "force-3way");
      writeFileSync(join(s.dir, "Y"), "Dummy\n");
      s.git("update-index", "--add", "Y");
      s.tick();
      s.git("commit", "-q", "-m", "Add Y.");
      s.git("checkout", "-q", "-b", "filemove");
      s.git("reset", "-q", "--soft", "main");
      mkdirSync(join(s.dir, "D"));
      s.git("mv", "A", "D/A");
      s.tick();
      s.git("commit", "-q", "-m", "Move A.");
      s.git("checkout", "-q", "-b", "my-topic-branch", "main");
      s.commit("Add B.", "B", "Second", "Second");
      s.git("checkout", "-q", "-f", "main");
      writeFileSync(join(s.dir, "A"), "First\nThird\n");
      s.git("update-index", "A");
      s.tick();
      s.git("commit", "-q", "-m", "Modify A.");
      s.git("checkout", "-q", "-b", "side", "my-topic-branch");
      writeFileSync(join(s.dir, "C"), "Side\n");
      s.git("add", "C");
      s.tick();
      s.git("commit", "-q", "-m", "Add C");
      s.git("checkout", "-q", "-f", "my-topic-branch");
      s.git("tag", "topic");
      // "rebase against main"
      s.git("rebase", "-q", "main");
    };

    it('t3400-rebase.sh: "rebase, with <onto> and <upstream> specified as :/quuxery"', async () => {
      const build = (s: Script) => {
        setup(s);
        s.git("checkout", "-q", "-b", "torebase", "my-topic-branch^");
      };
      let dirs = twins(build);
      const upstream = native(dirs.native, "rev-parse", ":/Add B").stdout.trim();
      const onto = native(dirs.native, "rev-parse", ":/Add A").stdout.trim();
      let args = ["--onto", onto, upstream];
      await rebaseTwins(dirs, args, configureFor(args));
      dirs = twins(build);
      args = ["--onto", ":/Add A", ":/Add B"];
      await rebaseTwins(dirs, args, configureFor(args));
    });

    it('t3400-rebase.sh: "rebase off of the previous branch using "-""', async () => {
      const build = (s: Script) => {
        setup(s);
        s.git("checkout", "-q", "main");
        s.git("checkout", "-q", "HEAD^");
      };
      await rebaseTwins(twins(build), ["@{-1}"], configureFor(["@{-1}"]));
      await rebaseTwins(twins(build), ["-"], configureFor(["-"]));
    });

    it('t3400-rebase.sh: "fail when upstream arg is missing and not on branch"', async () => {
      const dirs = twins((s) => {
        setup(s);
        s.git("checkout", "-q", "topic");
      });
      const { status } = await rebaseTwins(dirs, [], configureFor([]));
      expect(status).toBe(1);
    });

    it('t3400-rebase.sh: "fail when upstream arg is missing and not configured"', async () => {
      const dirs = twins((s) => {
        setup(s);
        s.git("checkout", "-q", "-b", "no-config", "topic");
      });
      const { status } = await rebaseTwins(dirs, [], configureFor([]));
      expect(status).toBe(1);
    });

    it('t3400-rebase.sh: "default to common base in @{upstream}s reflog if no upstream arg (--merge)"', async () => {
      const build = (s: Script) => {
        setup(s);
        s.git("checkout", "-q", "-b", "default-base", "main");
        s.git("checkout", "-q", "-b", "default", "topic");
        s.git("config", "branch.default.remote", ".");
        s.git("config", "branch.default.merge", "refs/heads/default-base");
      };
      await rebaseTwins(twins(build), [], configureFor([]));
      const dirs = twins((s) => {
        build(s);
        s.git("rebase", "-q", "--merge");
        s.git("checkout", "-q", "default-base");
        s.git("reset", "-q", "--hard", "HEAD^");
        s.git("checkout", "-q", "default");
      });
      await rebaseTwins(dirs, [], configureFor([]));
      expect(native(dirs.ours, "rev-parse", "default~1").stdout).toBe(
        native(dirs.ours, "rev-parse", "default-base").stdout,
      );
    });

    it('t3400-rebase.sh: "cherry-picked commits and fork-point work together"', async () => {
      const dirs = twins((s) => {
        setup(s);
        s.git("checkout", "-q", "-b", "default-base", "main");
        s.git("checkout", "-q", "-b", "default", "topic");
        s.git("config", "branch.default.remote", ".");
        s.git("config", "branch.default.merge", "refs/heads/default-base");
        s.git("rebase", "-q", "--merge");
        s.git("checkout", "-q", "default-base");
        s.git("reset", "-q", "--hard", "HEAD^");
        s.git("checkout", "-q", "default");
        s.git("rebase", "-q", "--merge");
        // the test itself
        s.git("checkout", "-q", "default-base");
        writeFileSync(join(s.dir, "A"), "Amended\n");
        s.tick();
        s.git("commit", "-q", "-a", "--no-edit", "--amend");
        s.commit("B", "B");
        s.commit("new_B", "B", "New B");
        s.commit("C", "C");
        s.git("checkout", "-q", "default");
        s.git("reset", "-q", "--hard", "default-base@{4}");
        s.commit("D", "D");
        s.tick();
        s.git("cherry-pick", "-2", "default-base^");
        s.commit("final_B", "B", "Final B");
      });
      await rebaseTwins(dirs, [], configureFor([]));
    });

    it('t3400-rebase.sh: "Rebase a commit that sprinkles CRs in"', async () => {
      const dirs = twins((s) => {
        setup(s);
        writeFileSync(join(s.dir, "CR"), "One\nTwo\r\nThree\nF\rur\nFive\n");
        s.git("add", "CR");
        s.tick();
        s.git("commit", "-q", "-a", "-m", "A file with a line with CR");
        s.git("tag", "file-with-cr");
        s.git("checkout", "-q", "HEAD^0");
      });
      const args = ["--onto", "HEAD^^", "HEAD^"];
      await rebaseTwins(dirs, args, configureFor(args));
    });

    it('t3400-rebase.sh: "switch to branch checked out here"', async () => {
      const dirs = twins((s) => {
        setup(s);
        s.git("checkout", "-q", "main");
      });
      await rebaseTwins(dirs, ["main", "main"], configureFor(["main", "main"]));
    });

    it('t3400-rebase.sh: "switch to branch not checked out"', async () => {
      const dirs = twins((s) => {
        setup(s);
        s.git("checkout", "-q", "main");
        s.git("branch", "other");
      });
      await rebaseTwins(dirs, ["main", "other"], configureFor(["main", "other"]));
    });

    it('t3400-rebase.sh: "switch to non-branch detaches HEAD"', async () => {
      const dirs = twins((s) => {
        setup(s);
        s.git("checkout", "-q", "main");
      });
      const args = ["First", "Second^0"];
      await rebaseTwins(dirs, args, configureFor(args));
      expect(native(dirs.ours, "symbolic-ref", "-q", "HEAD").status).not.toBe(0);
    });

    it("rebasing another branch onto a new base from a third: <branch> with --onto", async () => {
      const dirs = twins((s) => {
        setup(s);
        s.git("checkout", "-q", "main");
      });
      const args = ["--onto", "main", "my-topic-branch~1", "side"];
      await rebaseTwins(dirs, args, configureFor(args));
    });
  });
});

describeGit("merge-base", () => {
  let repo: string;
  const T = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const M = 1130000000;
  const env = {
    GIT_COMMITTER_EMAIL: "git@comm.iter.xz",
    GIT_COMMITTER_NAME: "C O Mmiter",
    GIT_AUTHOR_NAME: "A U Thor",
    GIT_AUTHOR_EMAIL: "git@au.thor.xz",
  };
  const ids: Record<string, string> = {};
  /** t6010's doit: a commit of the empty tree at M + offset, tagged with its name */
  const doit = (offset: number, name: string, ...parents: string[]) => {
    const date = `${M + offset} +0000`;
    const r = spawnSync(
      "git",
      ["commit-tree", T, ...parents.flatMap((p) => ["-p", ids[p] as string])],
      {
        cwd: repo,
        env: { ...nativeGitEnv(root), ...env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
        input: `${name}\n`,
        encoding: "utf8",
      },
    );
    const id = r.stdout.trim();
    native(repo, "update-ref", `refs/tags/${name}`, id);
    ids[name] = id;
  };

  /** `git merge-base <args>` and ours give the same lines and exit status. */
  async function twin(
    args: string[],
    configure: (m: import("../src/index.js").MergeBaseCommand) => unknown,
    sort = false,
  ) {
    const expected = native(repo, "merge-base", ...args);
    const git = await openOurs(repo);
    const command = git.mergeBase();
    configure(command);
    let lines: string[];
    let status: number;
    try {
      const result = await command.call();
      lines = result.bases;
      status = result.exitCode;
    } catch (e) {
      if (!(e instanceof GitApiError)) throw e;
      expect(e.message).toBe(expected.stderr.trim());
      lines = [];
      status = e.exitCode;
    }
    const want = expected.stdout.split("\n").filter(Boolean);
    expect(sort ? [...lines].sort() : lines).toEqual(sort ? want.sort() : want);
    expect(status).toBe(expected.status);
    return { status, lines };
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-base-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    native(repo, "init", "-q", "-b", "main");
    // the empty tree (t6010's `git mktree </dev/null`)
    spawnSync("git", ["mktree"], { cwd: repo, env: nativeGitEnv(root), input: "" });
    // set up G and H
    doit(5, "E");
    doit(4, "D", "E");
    doit(6, "F", "E");
    doit(3, "C", "D");
    doit(2, "B", "C");
    doit(1, "A", "B");
    doit(7, "G", "B", "E");
    doit(8, "H", "A", "F");
    // unsynchronized clocks
    doit(0, "S");
    doit(-3, "C0", "S");
    doit(-2, "C1", "C0");
    doit(-1, "C2", "C1");
    doit(1, "L0", "S");
    doit(2, "L1", "L0");
    doit(3, "L2", "L1");
    doit(1, "R0", "S");
    doit(2, "R1", "R0");
    doit(3, "R2", "R1");
    doit(4, "PL", "L2", "C2");
    doit(4, "PR", "C2", "R2");
    // --independent with unsynchronized clocks
    doit(0, "IB");
    doit(-10, "I1", "IB");
    doit(-9, "I2", "I1");
    doit(-8, "I3", "I2");
    doit(-7, "I4", "I3");
    doit(-6, "I5", "I4");
    doit(-5, "I6", "I5");
    doit(-4, "I7", "I6");
    doit(-3, "I8", "I7");
    doit(-2, "IH", "I8");
    // merge-base for octopus-step (setup)
    const s = new Script(repo);
    for (const c of ["MMR", "MM1", "MM-o", "MM-p", "MM-q", "MMA"]) s.commit(c);
    s.git("checkout", "-q", "MM1");
    for (const c of ["MM-r", "MM-s", "MM-t", "MMB"]) s.commit(c);
    s.git("checkout", "-q", "MMR");
    for (const c of ["MM-u", "MM-v", "MM-w", "MM-x", "MMC"]) s.commit(c);
    // criss-cross merge-base for octopus-step
    s.git("reset", "-q", "--hard", "MMR");
    s.commit("CC1");
    s.git("reset", "-q", "--hard", "E");
    s.commit("CC2");
    s.tick();
    s.git("merge", "-q", "-s", "ours", "--allow-unrelated-histories", "-m", "m1", "CC1");
    s.commit("CC-o");
    s.commit("CCB");
    s.git("reset", "-q", "--hard", "CC1");
    s.git("merge", "-q", "-s", "ours", "--allow-unrelated-histories", "-m", "m2", "CC2");
    s.commit("CCA");
    // merge-base --octopus --all for complex tree
    s.git("reset", "-q", "--hard");
    s.commit("J");
    s.commit("JB");
    s.git("reset", "-q", "--hard", "J");
    s.commit("JC");
    s.git("reset", "-q", "--hard", "J");
    s.commit("JTEMP1");
    s.merge("JA", "JB");
    s.merge("JAA", "JC");
    s.git("reset", "-q", "--hard", "J");
    s.commit("JTEMP2");
    s.merge("JD", "JB");
    s.merge("JDD", "JC");
    s.git("reset", "-q", "--hard", "J");
    s.commit("JTEMP3");
    s.merge("JE", "JC");
    // using reflog to find the fork point
    s.git("reset", "-q", "--hard");
    s.git("checkout", "-q", "-b", "base", ids.E as string);
    for (const count of [1, 2, 3]) {
      s.tick();
      s.git("commit", "-q", "--allow-empty", "-m", `Base commit #${count}`);
      ids[`expect${count}`] = s.git("rev-parse", "HEAD").trim();
      s.git("checkout", "-q", "-B", "derived");
      s.tick();
      s.git("commit", "-q", "--allow-empty", "-m", `Derived #${count}`);
      ids[`derived${count}`] = s.git("rev-parse", "HEAD").trim();
      s.git("checkout", "-q", "-B", "base", ids.E as string);
    }
    s.git("checkout", "-q", "derived");
    s.git("-c", "core.logallrefupdates=false", "branch", "no-reflog", "base");
  });
  afterAll(async () => {
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  it('t6010-merge-base.sh: "merge-base G H"', async () => {
    await twin(["G", "H"], (m) => m.addCommit("G").addCommit("H"));
    await twin(["--all", "G", "H"], (m) => m.setAll(true).addCommit("G").addCommit("H"));
  });

  it('t6010-merge-base.sh: "merge-base/show-branch --independent"', async () => {
    await twin(["--independent", "H"], (m) => m.setMode("independent").addCommit("H"));
    await twin(["--independent", "A", "H", "G"], (m) =>
      m.setMode("independent").addCommit("A").addCommit("H").addCommit("G"),
    );
  });

  it('t6010-merge-base.sh: "unsynchronized clocks"', async () => {
    await twin(["PL", "PR"], (m) => m.addCommit("PL").addCommit("PR"));
    await twin(["--all", "PL", "PR"], (m) => m.setAll(true).addCommit("PL").addCommit("PR"));
  });

  it('t6010-merge-base.sh: "--independent with unsynchronized clocks"', async () => {
    await twin(["--independent", "IB", "IH"], (m) =>
      m.setMode("independent").addCommit("IB").addCommit("IH"),
    );
  });

  it('t6010-merge-base.sh: "merge-base A B C"', async () => {
    const abc = (m: import("../src/index.js").MergeBaseCommand) =>
      m.addCommit("MMA").addCommit("MMB").addCommit("MMC");
    await twin(["--all", "MMA", "MMB", "MMC"], (m) => abc(m.setAll(true)));
    await twin(["--all", "--octopus", "MMA", "MMB", "MMC"], (m) =>
      abc(m.setAll(true).setMode("octopus")),
    );
    await twin(["--octopus", "MMA", "MMB", "MMC"], (m) => abc(m.setMode("octopus")));
  });

  it('t6010-merge-base.sh: "criss-cross merge-base for octopus-step"', async () => {
    const { lines } = await twin(
      ["--all", "CCB", "CCA^^", "CCA^^2"],
      (m) => m.setAll(true).addCommit("CCB").addCommit("CCA^^").addCommit("CCA^^2"),
      true,
    );
    expect(lines).toHaveLength(2);
  });

  it('t6010-merge-base.sh: "using reflog to find the fork point"', async () => {
    for (const count of [1, 2, 3]) {
      const derived = ids[`derived${count}`] as string;
      const { lines } = await twin(["--fork-point", "base", derived], (m) =>
        m.setMode("fork-point").addCommit("base").addCommit(derived),
      );
      expect(lines).toEqual([ids[`expect${count}`]]);
    }
    const { lines } = await twin(["--fork-point", "base"], (m) =>
      m.setMode("fork-point").addCommit("base"),
    );
    expect(lines).toEqual([ids.expect3]);
  });

  it('t6010-merge-base.sh: "--fork-point works with empty reflog"', async () => {
    await twin(["--fork-point", "no-reflog", "derived"], (m) =>
      m.setMode("fork-point").addCommit("no-reflog").addCommit("derived"),
    );
  });

  it('t6010-merge-base.sh: "merge-base --octopus --all for complex tree"', async () => {
    const { lines } = await twin(["--all", "--octopus", "JAA", "JDD", "JE"], (m) =>
      m.setAll(true).setMode("octopus").addCommit("JAA").addCommit("JDD").addCommit("JE"),
    );
    expect(lines).toEqual([native(repo, "rev-parse", "JC").stdout.trim()]);
  });

  const isAncestor = (a: string, b: string) =>
    twin(["--is-ancestor", a, b], (m) => m.setMode("is-ancestor").addCommit(a).addCommit(b));

  it('t6010-merge-base.sh: "--is-ancestor with an ancestor and a descendant"', async () => {
    expect((await isAncestor("E", "A")).status).toBe(0);
    expect((await isAncestor("A", "E")).status).toBe(1);
  });

  it('t6010-merge-base.sh: "--is-ancestor treats a commit as its own ancestor"', async () => {
    expect((await isAncestor("A", "A")).status).toBe(0);
  });

  it('t6010-merge-base.sh: "--is-ancestor with diverged commits"', async () => {
    expect((await isAncestor("G", "H")).status).toBe(1);
    expect((await isAncestor("H", "G")).status).toBe(1);
  });

  it('t6010-merge-base.sh: "--is-ancestor exits 128 on a bad commit"', async () => {
    expect((await isAncestor("A", "no-such-commit")).status).toBe(128);
    expect((await isAncestor("no-such-commit", "A")).status).toBe(128);
  });

  it('t6010-merge-base.sh: "--is-ancestor requires exactly two commits"', async () => {
    const usage = async (args: string[]) => {
      const expected = native(repo, "merge-base", ...args);
      const command = (await openOurs(repo)).mergeBase().setMode("is-ancestor");
      for (const a of args.slice(1)) command.addCommit(a);
      const error = await command.call().then(
        () => undefined,
        (e: unknown) => e as GitApiError,
      );
      expect(error?.exitCode).toBe(expected.status);
      return error;
    };
    expect((await usage(["--is-ancestor"]))?.exitCode).toBe(129);
    expect((await usage(["--is-ancestor", "A"]))?.exitCode).toBe(129);
    await twin(["--is-ancestor", "E", "A", "B"], (m) =>
      m.setMode("is-ancestor").addCommit("E").addCommit("A").addCommit("B"),
    );
  });

  it('t6010-merge-base.sh: "--is-ancestor and --all cannot be used together"', async () => {
    await twin(["--is-ancestor", "--all", "E", "A"], (m) =>
      m.setMode("is-ancestor").setAll(true).addCommit("E").addCommit("A"),
    );
  });

  it("--independent and --all cannot be used together; names that name no commit", async () => {
    await twin(["--independent", "--all", "E", "A"], (m) =>
      m.setMode("independent").setAll(true).addCommit("E").addCommit("A"),
    );
    await twin(["A", "nope"], (m) => m.addCommit("A").addCommit("nope"));
    await twin(["A", "A^{tree}"], (m) => m.addCommit("A").addCommit("A^{tree}"));
    await twin(["--fork-point", "nope"], (m) => m.setMode("fork-point").addCommit("nope"));
  });

  describe("t6099-merge-base-side-exhaustion", () => {
    let dir: string;
    beforeAll(() => {
      dir = join(root, "t6099");
      const s = new Script(dir);
      s.commit("C");
      s.git("checkout", "-q", "-b", "d-chain", "HEAD");
      s.commit("d1");
      s.commit("B");
      s.git("checkout", "-q", "-b", "e-path", "C");
      s.commit("e1");
      s.commit("e2");
      s.git("checkout", "-q", "-b", "f-path", "C");
      s.commit("f1");
      s.commit("f2");
      s.git("checkout", "-q", "-b", "branch-A", "e-path");
      s.merge("A", "B");
      s.git("checkout", "-q", "-b", "branch-X", "f-path");
      s.merge("X", "B");
      s.git("commit-graph", "write", "--reachable");
    });

    const check = async (args: string[]) => {
      const expected = native(dir, "merge-base", ...args);
      const command = (await openOurs(dir)).mergeBase();
      if (args.includes("--all")) command.setAll(true);
      for (const a of args.filter((a) => !a.startsWith("-"))) command.addCommit(a);
      const result = await command.call();
      expect(result.bases).toEqual(expected.stdout.split("\n").filter(Boolean));
      expect(result.bases).toEqual([native(dir, "rev-parse", "B").stdout.trim()]);
    };

    it('t6099-merge-base-side-exhaustion.sh: "merge-base --all excludes ancestor candidate"', async () => {
      await check(["--all", "A", "X"]);
    });

    it('t6099-merge-base-side-exhaustion.sh: "merge-base (single) finds shallowest"', async () => {
      await check(["A", "X"]);
    });

    it('t6099-merge-base-side-exhaustion.sh: "merge-base --all without commit-graph"', async () => {
      rmSync(join(dir, ".git/objects/info/commit-graph"), { force: true });
      await check(["--all", "A", "X"]);
    });
  });
});
