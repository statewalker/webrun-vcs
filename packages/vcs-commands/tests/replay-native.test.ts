/**
 * `git replay` (builtin/replay.c, replay.c), native twins of t3650-replay-basics.sh. The
 * repository is built by native git with t3650's setup; each scenario copies it twice, runs
 * native `git replay` in one copy and ours in the other with the same identities and dates,
 * and compares stdout, stderr (the first line only for usage errors), the exit status, every
 * ref, every reflog file, the set of objects and the worktree's state. git decides what each
 * version does: `git replay` is 2.44+ (2.43 has none: the twins skip), `--ref-action` and
 * ref updates 2.53+, `--revert`/`--ref`, root commits and dropped empty commits 2.54+, the
 * merge-failure error 2.55+, `--linearize` 2.56+; ours follows the native version through
 * `setCompatibility`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, ReplayCommand, ReplayCompatibility } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

function nativeMinor(): number {
  const r = spawnSync("git", ["--version"]);
  const m = r.stdout?.toString().match(/(\d+)\.(\d+)/);
  return m && Number(m[1]) === 2 ? Number(m[2]) : 99;
}

const MINOR = nativeGitAvailable() ? nativeMinor() : 0;
const describeGit =
  nativeGitAvailable() && process.platform !== "win32" && MINOR >= 44 ? describe : describe.skip;
const COMPATIBILITY: ReplayCompatibility = MINOR < 53 ? "2.52" : MINOR === 53 ? "2.53" : "2.56";
/** `--ref-action` (2.53+): without it, git replay prints the update lines */
const PRINT = MINOR >= 53 ? ["--ref-action=print"] : [];
const since = (minor: number) => MINOR >= minor;

let root: string;
let base: string;
let counter = 0;

/** The identities and dates both twins run with (t3650 sets the author). */
const ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "author@name",
  GIT_AUTHOR_EMAIL: "bogus@email@address",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_AUTHOR_DATE: "1112912893 -0700",
  GIT_COMMITTER_DATE: "1112912953 -0700",
};

function env(): Record<string, string> {
  return { ...nativeGitEnv(root), GIT_EDITOR: "true", ...ENV };
}

/** Runs a shell script in `dir` with test-lib's helpers. */
function sh(dir: string, body: string): string {
  const lib = `
set -e
test_tick () {
  if test -z "\${test_tick+set}"; then test_tick=1112911993; else test_tick=$((test_tick + 60)); fi
  GIT_COMMITTER_DATE="$test_tick -0700"; GIT_AUTHOR_DATE="$test_tick -0700"
  export GIT_COMMITTER_DATE GIT_AUTHOR_DATE
}
test_commit () {
  test_tick
  file=\${2:-$1.t}
  printf "%s\\n" "\${3:-$1}" >"$file"
  git add -- "$file"
  git commit -q -m "$1"
  git tag "\${4:-$1}"
}
test_merge () {
  label="$1"; shift
  test_tick
  git merge -q -m "$label" "$@"
  git tag "$label"
}
`;
  const r = spawnSync("sh", ["-c", `${lib}\n${body}`], { cwd: dir, env: env() });
  if (r.status !== 0) {
    throw new Error(`script failed: ${r.stderr.toString()}\n${r.stdout.toString()}`);
  }
  return r.stdout.toString();
}

function git(dir: string, args: string[]) {
  const r = spawnSync("git", args, { cwd: dir, env: env() });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? Buffer.alloc(0)).toString("latin1"),
    stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

/** Every file below `dir`, as `path: content` lines (reflogs). */
function filesBelow(dir: string, prefix = ""): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesBelow(path, `${prefix}${name}/`));
    else out.push(`${prefix}${name}: ${readFileSync(path, "utf8")}`);
  }
  return out;
}

/** What a twin compares besides the command's output. */
function state(dir: string, gitDir: string): Record<string, unknown> {
  return {
    refs: git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]).stdout,
    head: git(dir, ["rev-parse", "--symbolic-full-name", "HEAD"]).stdout,
    logs: filesBelow(join(dir, gitDir, "logs")),
    objects: git(dir, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]).stdout,
    status: gitDir === "." ? "" : git(dir, ["status", "--porcelain"]).stdout,
  };
}

/** `git replay <argv>` mapped onto our ReplayCommand (cmd_replay's options, then revisions). */
function replayArgs(ours: Git, argv: string[]): ReplayCommand {
  const command = ours.replay().setCompatibility(COMPATIBILITY);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.indexOf("=");
    const [opt, inline] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const value = () => inline ?? (argv[++i] as string);
    switch (opt) {
      case "--onto":
        command.setOnto(value());
        break;
      case "--advance":
        command.setAdvance(value());
        break;
      case "--revert":
        command.setRevert(value());
        break;
      case "--ref":
        command.setRef(value());
        break;
      case "--ref-action":
        command.setRefAction(value());
        break;
      case "--contained":
        command.setContained(true);
        break;
      case "--linearize":
        command.setLinearize(true);
        break;
      case "--ancestry-path":
        command.configureWalk((walk) => walk.addAncestryPath(value()));
        break;
      default:
        command.addRevision(arg);
    }
  }
  return command;
}

interface TwinOptions {
  /** run in the bare clone (`bare/`) */
  bare?: boolean;
  /** run in this subdirectory (a repository the `before` script made) */
  sub?: string;
  /** compare only the first line of stderr (git's usage text follows it) */
  firstLine?: boolean;
  /** script run in both copies first (natively) */
  before?: string;
  /** earlier `git replay` runs, in both copies, compared too */
  steps?: string[][];
}

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs `git replay <argv>` natively and ours on twin copies; compares; native's outcome. */
async function twins(argv: string[], options: TwinOptions = {}): Promise<Outcome> {
  const id = counter++;
  const native = join(root, `native-${id}`);
  const our = join(root, `ours-${id}`);
  spawnSync("cp", ["-a", base, native]);
  spawnSync("cp", ["-a", base, our]);
  if (options.before) {
    sh(native, options.before);
    sh(our, options.before);
  }
  const at = (dir: string) => (options.bare ? join(dir, "bare") : join(dir, options.sub ?? ""));
  const gitDir = options.bare ? "." : ".git";
  const runs = [...(options.steps ?? []), argv];
  let last: Outcome | undefined;
  for (const run of runs) {
    const n = git(at(native), ["replay", ...run]);
    const ours = await openOurs(
      at(our),
      createNodeGitHostEnvironment({ env: env() }),
      undefined,
      "",
      false,
      options.bare ? "." : undefined,
    );
    const out = await replayArgs(ours, run).callOutput();
    const o: Outcome = {
      status: out.exitCode,
      stdout: Buffer.from(out.stdout).toString("latin1"),
      stderr: out.stderr,
    };
    const cut = (x: Outcome) =>
      options.firstLine ? { ...x, stderr: x.stderr.split("\n")[0] as string } : x;
    expect({ run, ...cut(o) }).toEqual({ run, ...cut(n) });
    last = n;
  }
  expect(state(at(our), gitDir)).toEqual(state(at(native), gitDir));
  return last as Outcome;
}

describeGit("git replay, native twins (t3650)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "replay-native-"));
    base = join(root, "base");
    spawnSync("git", ["init", "-q", "-b", "main", base], { env: env() });
    // t3650-replay-basics.sh: "setup", "setup bare"
    sh(
      base,
      `
test_commit A
test_commit B
git switch -q -c topic1
test_commit C
git switch -q -c topic2
test_commit D
test_commit E
git switch -q topic1
test_commit F
git switch -q -c topic3
test_commit G
test_commit H
git switch -q -c empty
git commit -q --allow-empty -m empty
git switch -q -c topic4 main
test_commit I
test_commit J
git switch -q -c next main
test_commit K
git merge -q -m "Merge topic1" topic1
git merge -q -m "Merge topic2" topic2
git merge -q -m "Merge topic3" topic3
>evil
git add evil
git commit -q --amend
git merge -q -m "Merge topic4" topic4
git switch -q main
test_commit L
test_commit M
git switch -q --detach topic4
test_commit N
test_commit O
git switch -q -c topic-with-merge topic4
test_merge P O --no-ff
git switch -q main
git switch -q --orphan unrelated
test_commit unrelated-root
git switch -q -c conflict B
test_commit C.conflict C.t conflict
git branch -q -D unrelated
git switch -q -c divergent-x main
test_commit X
git switch -q -c divergent-y main
test_commit Y
git switch -q divergent-x
test_merge Z divergent-y --no-ff
git clone -q --bare . bare
`,
    );
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('t3650-replay-basics.sh: "argument to --advance must be a reference"', async () => {
    const oid = git(base, ["rev-parse", "main"]).stdout.trim();
    const out = await twins([`--advance=${oid}`, "topic1..topic2"]);
    expect(out.status).toBe(128);
  });

  it('t3650-replay-basics.sh: "--onto with invalid commit-ish"', async () => {
    const out = await twins(["--onto=refs/not-valid", "topic1..topic2"]);
    expect(out.status).toBe(128);
  });

  it('t3650-replay-basics.sh: "exactly one of --onto, --advance, or --revert is required"', async () => {
    const out = await twins(["topic1..topic2"], { firstLine: true });
    expect(out.status).toBe(129);
  });

  it('t3650-replay-basics.sh: "replay down to root onto another branch"', async () => {
    await twins([...PRINT, "--onto", "main", "topic2"]);
  });

  it('t3650-replay-basics.sh: "--advance and --contained cannot be used together"', async () => {
    const out = await twins(["--advance=main", "--contained", "topic1..topic2"]);
    expect(out.stderr).toContain("cannot be used together");
  });

  it('t3650-replay-basics.sh: "cannot advance target ... ordering would be ill-defined"', async () => {
    const out = await twins(["--advance=main", "main", "topic1", "topic2"]);
    expect(out.status).toBe(128);
  });

  it('t3650-replay-basics.sh: "replaying merge commits is not supported yet"', async () => {
    await twins(["--advance=main", "main..topic-with-merge"]);
  });

  it('t3650-replay-basics.sh: "using replay to rebase two branches, one on top of other"', async () => {
    const out = await twins([...PRINT, "--onto", "main", "topic1..topic2"]);
    expect(out.stdout).toMatch(/^update refs\/heads\/topic2 [0-9a-f]{40} [0-9a-f]{40}\n$/);
  });

  it('t3650-replay-basics.sh: "using replay on bare repo to rebase two branches, one on top of other"', async () => {
    await twins([...PRINT, "--onto", "main", "topic1..topic2"], { bare: true });
  });

  it('t3650-replay-basics.sh: "using replay to rebase with a conflict"', async () => {
    const out = await twins(["--onto", "topic1", "B..conflict"]);
    expect(out.status).toBe(1);
  });

  it('t3650-replay-basics.sh: "using replay on bare repo to rebase with a conflict"', async () => {
    await twins(["--onto", "topic1", "B..conflict"], { bare: true });
  });

  it('t3650-replay-basics.sh: "using replay to perform basic cherry-pick"', async () => {
    await twins([...PRINT, "--advance", "main", "topic1..topic2"]);
  });

  it('t3650-replay-basics.sh: "using replay on bare repo to perform basic cherry-pick"', async () => {
    await twins([...PRINT, "--advance", "main", "topic1..topic2"], { bare: true });
  });

  it('t3650-replay-basics.sh: "commits that become empty are dropped"', async () => {
    await twins(["--onto", "main", "--branches", "--ancestry-path=empty", "^A"], {
      steps: [["--advance", "main", "topic1^!"]],
    });
  });

  it('t3650-replay-basics.sh: "replay on bare repo fails with both --advance and --onto"', async () => {
    const out = await twins(["--advance", "main", "--onto", "main", "topic1..topic2"], {
      bare: true,
    });
    expect(out.status).toBe(128);
  });

  it('t3650-replay-basics.sh: "replay fails when both --advance and --onto are omitted"', async () => {
    await twins(["topic1..topic2"], { firstLine: true });
  });

  it('t3650-replay-basics.sh: "using replay to also rebase a contained branch"', async () => {
    const out = await twins([...PRINT, "--contained", "--onto", "main", "main..topic3"]);
    expect(out.stdout.split("\n")).toHaveLength(3);
  });

  it('t3650-replay-basics.sh: "using replay on bare repo to also rebase a contained branch"', async () => {
    await twins([...PRINT, "--contained", "--onto", "main", "main..topic3"], { bare: true });
  });

  it('t3650-replay-basics.sh: "using replay to rebase multiple divergent branches"', async () => {
    await twins([...PRINT, "--onto", "main", "^topic1", "topic2", "topic4"]);
  });

  it('t3650-replay-basics.sh: "using replay on bare repo to rebase multiple divergent branches, including contained ones"', async () => {
    const out = await twins(
      [...PRINT, "--contained", "--onto", "main", "^main", "topic2", "topic3", "topic4"],
      { bare: true },
    );
    expect(out.stdout.split("\n")).toHaveLength(5);
  });

  it('t3650-replay-basics.sh: "using replay to update detached HEAD"', async () => {
    await twins([...PRINT, "--onto", "HEAD~2", ...PRINT, "HEAD~..HEAD"], {
      before: "git switch -q --detach\ntest_commit something",
    });
  });

  it('t3650-replay-basics.sh: "merge.directoryRenames=false"', async () => {
    await twins(["--onto", "rename-onto", "rename-onto..rename-from"], {
      before: `
git switch -q -c rename-onto
mkdir -p to-rename
test_commit to-rename/move
mkdir -p renamed-directory
git mv to-rename/move* renamed-directory/
test_tick
git commit -q -m renamed-directory
git switch -q -c rename-from HEAD^
test_commit to-rename/add-a-file
echo modified >to-rename/add-a-file.t
test_tick
git commit -q -m modified to-rename/add-a-file.t
git config merge.directoryRenames false
`,
    });
  });

  it.skipIf(!since(53))(
    't3650-replay-basics.sh: "default atomic behavior updates refs directly"',
    async () => {
      const out = await twins(["--onto", "main", "topic1..test-atomic"], {
        before: "git branch test-atomic topic2",
      });
      expect(out.stdout).toBe("");
    },
  );

  it.skipIf(!since(53))(
    't3650-replay-basics.sh: "atomic behavior in bare repository"',
    async () => {
      await twins(["--onto", "main", "topic1..topic2"], { bare: true });
    },
  );

  it.skipIf(!since(53))('t3650-replay-basics.sh: "reflog message for --advance mode"', async () => {
    await twins(["--advance", "main", "topic1..topic2"]);
  });

  it.skipIf(!since(53))(
    't3650-replay-basics.sh: "replay.refAction=print config option"',
    async () => {
      const out = await twins(["--onto", "main", "topic1..topic2"], {
        before: "git config replay.refAction print",
      });
      expect(out.stdout).toMatch(/^update refs\/heads\/topic2 /);
    },
  );

  it.skipIf(!since(53))(
    't3650-replay-basics.sh: "replay.refAction=update config option"',
    async () => {
      await twins(["--onto", "main", "topic1..topic2"], {
        before: "git config replay.refAction update",
      });
    },
  );

  it.skipIf(!since(53))(
    't3650-replay-basics.sh: "command-line --ref-action overrides config"',
    async () => {
      await twins(["--ref-action=print", "--onto", "main", "topic1..topic2"], {
        before: "git config replay.refAction update",
      });
    },
  );

  it.skipIf(!since(53))('t3650-replay-basics.sh: "invalid replay.refAction value"', async () => {
    const out = await twins(["--onto", "main", "topic1..topic2"], {
      before: "git config replay.refAction invalid",
    });
    expect(out.status).toBe(128);
  });

  describe.skipIf(!since(54))("--revert and --ref (2.54+)", () => {
    it('t3650-replay-basics.sh: "argument to --revert must be a reference"', async () => {
      const oid = git(base, ["rev-parse", "main"]).stdout.trim();
      await twins([`--revert=${oid}`, "topic1..topic2"]);
    });

    it('t3650-replay-basics.sh: "cannot revert with multiple sources"', async () => {
      await twins(["--revert", "main", "main", "topic1", "topic2"]);
    });

    it('t3650-replay-basics.sh: "using replay --revert to revert commits"', async () => {
      await twins(["--revert", "topic4", "topic4~2..topic4"]);
    });

    it('t3650-replay-basics.sh: "using replay --revert in bare repo"', async () => {
      await twins(["--revert", "topic4", "topic4~1..topic4"], { bare: true });
    });

    it('t3650-replay-basics.sh: "revert of revert uses Reapply"', async () => {
      await twins(["--revert", "topic4", "topic4~1..topic4"], {
        steps: [["--revert", "topic4", "topic4~1..topic4"]],
      });
    });

    it('t3650-replay-basics.sh: "git replay --revert with conflict"', async () => {
      const out = await twins(["--revert", "conflict", "B..topic1"]);
      expect(out.status).toBe(1);
    });

    it('t3650-replay-basics.sh: "git replay --revert incompatible with --contained"', async () => {
      await twins(["--revert", "topic4", "--contained", "topic4~1..topic4"]);
    });

    it('t3650-replay-basics.sh: "git replay --revert incompatible with --onto"', async () => {
      await twins(["--revert", "topic4", "--onto", "main", "topic4~1..topic4"]);
    });

    it('t3650-replay-basics.sh: "git replay --revert incompatible with --advance"', async () => {
      await twins(["--revert", "topic4", "--advance", "main", "topic4~1..topic4"]);
    });

    it('t3650-replay-basics.sh: "using --onto with --ref"', async () => {
      await twins(
        ["--ref-action=print", "--onto=main", "--ref=refs/heads/test-ref-onto", "topic1..topic2"],
        { before: "git branch test-ref-onto topic2" },
      );
    });

    it('t3650-replay-basics.sh: "using --advance with --ref"', async () => {
      await twins(
        [
          "--ref-action=print",
          "--advance=test-ref-advance",
          "--ref=refs/heads/test-ref-target",
          "topic1..topic2",
        ],
        { before: "git branch test-ref-advance main\ngit branch test-ref-target main" },
      );
    });

    it('t3650-replay-basics.sh: "using --revert with --ref"', async () => {
      await twins(
        [
          "--ref-action=print",
          "--revert=test-ref-revert",
          "--ref=refs/heads/test-ref-revert-target",
          "topic4~1..topic4",
        ],
        { before: "git branch test-ref-revert topic4\ngit branch test-ref-revert-target topic4" },
      );
    });

    it('t3650-replay-basics.sh: "--ref is incompatible with --contained"', async () => {
      await twins(["--onto=main", "--ref=refs/heads/main", "--contained", "topic1..topic2"]);
    });

    it('t3650-replay-basics.sh: "--ref with nonexistent fully-qualified ref"', async () => {
      await twins(["--onto=main", "--ref=refs/heads/new-branch", "topic1..topic2"]);
    });

    it('t3650-replay-basics.sh: "--ref must be a valid refname"', async () => {
      await twins(["--onto=main", "--ref=refs/heads/bad..ref", "topic1..topic2"]);
    });

    it('t3650-replay-basics.sh: "--ref requires fully qualified ref"', async () => {
      await twins(["--onto=main", "--ref=main", "topic1..topic2"]);
    });

    it('t3650-replay-basics.sh: "--onto with --ref rejects multiple revision ranges"', async () => {
      await twins(["--onto=main", "--ref=refs/heads/topic2", "^topic1", "topic2", "topic4"]);
    });
  });

  describe.skipIf(!since(56))("--linearize (2.56+)", () => {
    it('t3650-replay-basics.sh: "replay to rebase merge commit with --linearize"', async () => {
      await twins(["--ref-action=print", "--linearize", "--onto", "main", "I..topic-with-merge"]);
    });

    it('t3650-replay-basics.sh: "replay to rebase merge commit with --linearize down to the root commit"', async () => {
      await twins([
        "--ref-action=print",
        "--linearize",
        "--onto",
        "unrelated-root",
        "topic-with-merge",
      ]);
    });

    it('t3650-replay-basics.sh: "replay to cherry-pick merge commit with --linearize"', async () => {
      await twins([
        "--ref-action=print",
        "--linearize",
        "--advance",
        "main",
        "I..topic-with-merge",
      ]);
    });

    it('t3650-replay-basics.sh: "--linearize rejects multiple branches"', async () => {
      await twins([
        "--ref-action=print",
        "--linearize",
        "--onto",
        "main",
        "^B",
        "topic2",
        "topic3",
        "topic4",
      ]);
    });

    it('t3650-replay-basics.sh: "replay with --linearize of a divergent merge keeps both sides"', async () => {
      await twins(["--ref-action=print", "--linearize", "--onto", "main", "main..divergent-x"]);
    });

    it('t3650-replay-basics.sh: "--linearize and --contained cannot be used together"', async () => {
      await twins([
        "--ref-action=print",
        "--linearize",
        "--contained",
        "--onto",
        "main",
        "^B",
        "topic-with-merge",
      ]);
    });

    it('t3650-replay-basics.sh: "replay --revert with --linearize reverts a range containing a merge"', async () => {
      await twins([
        "--ref-action=print",
        "--revert=divergent-x",
        "--linearize",
        "main..divergent-x",
      ]);
    });
  });

  it.skipIf(!since(55))(
    't3650-replay-basics.sh: "replay fails without segfault when objects are missing"',
    async () => {
      const out = await twins(["--onto", "onto", "base..side"], {
        before: `
mkdir unreadable
cd unreadable
git init -q -b main
printf "%s\\n" l1 l2 l3 l4 l5 l6 l7 l8 >f
git add f
git commit -q -m base
git branch base
printf "%s\\n" l1 l2 l3 l4 l5 l6 l7 CHANGED >f
git commit -q -am side
git branch side
git switch -q -c onto base
printf "%s\\n" CHANGED l2 l3 l4 l5 l6 l7 l8 >f
git commit -q -am onto
tree=$(git rev-parse onto^{tree})
mv .git/objects/$(echo $tree | cut -c1-2)/$(echo $tree | cut -c3-) saved-tree
`,
        sub: "unreadable",
      });
      expect(out.status).not.toBe(0);
    },
  );
});
