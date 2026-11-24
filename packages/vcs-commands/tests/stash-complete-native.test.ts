/**
 * `git stash pop`, `show`, `branch`, `store` and `list` against native git (t3903-stash,
 * t3905-stash-include-untracked, t3907-stash-show-config): twin copies of one repository
 * built by native git, the subcommand run by native git in one and by ours in the other,
 * then the worktree, the index, the refs, `refs/stash`'s reflog, stdout, stderr and the
 * exit status compared. Run with git 2.43 and 2.56 on `PATH`: ours answers as the version
 * found (`setCompatibility`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GitApiError } from "../src/errors/index.js";
import type { Git, StashCompatibility, StashInfoCommand } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
let compatibility: StashCompatibility = "2.56";

/** Runs a shell script with native git's test environment. */
function sh(dir: string, script: string): void {
  execFileSync("sh", ["-ec", script], { cwd: dir, env: testEnv(root), stdio: "pipe" });
}

/** The base repository (t3903's `file` and `other`), `script` run on it, copied twice. */
function twins(script: string): [string, string] {
  const dirs: [string, string] = [join(root, `n${counter}`), join(root, `o${counter}`)];
  counter++;
  const [first, second] = dirs;
  mkdirSync(first, { recursive: true });
  sh(
    first,
    [
      "git init -q -b main",
      "printf '1\\n2\\n3\\n' >file",
      "echo other >other",
      "git add file other",
      "git commit -qm initial",
      script,
      "git update-index -q --refresh || :",
    ].join("\n"),
  );
  execFileSync("cp", ["-a", first, second]);
  sh(second, "git update-index -q --refresh || :");
  return dirs;
}

/** Every file of the worktree with its content. */
function worktreeFiles(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${name.name}` : name.name;
    if (path === ".git") continue;
    if (name.isDirectory()) Object.assign(out, worktreeFiles(dir, path));
    else out[path] = readFileSync(join(dir, path), "latin1");
  }
  return out;
}

/** What a stash subcommand may change, read with native git. */
function state(dir: string) {
  const stashLog = gitRun(root, dir, [
    "reflog",
    "show",
    "--format=%H %gs <%gn %ge>",
    "refs/stash",
    "--",
  ]);
  return {
    files: worktreeFiles(dir),
    index: gitOut(root, dir, ["ls-files", "-s"]),
    status: gitOut(root, dir, ["status", "--porcelain=v1", "-uall"]),
    head: gitRun(root, dir, ["symbolic-ref", "-q", "HEAD"]).stdout,
    refs: gitOut(root, dir, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    stashLog: stashLog.status === 0 ? stashLog.stdout : "",
    stashLogFile: existsSync(join(dir, ".git/logs/refs/stash")),
  };
}

type Outcome = { status: number; stdout: string; stderr: string };

/** Ours run as native git reports it: exit status, stdout, stderr. */
async function ours<T>(
  command: StashInfoCommand<T>,
  stdoutOf: (value: T, command: StashInfoCommand<T>) => string = (_v, c) => c.getOutput(),
): Promise<Outcome & { value?: T }> {
  command.setCompatibility(compatibility);
  try {
    const value = await command.call();
    // a conflicted apply exits 1 (STASH_APPLY_CONFLICT)
    const conflicted = (value as { status?: string } | undefined)?.status === "conflicts";
    return { status: conflicted ? 1 : 0, stdout: stdoutOf(value, command), stderr: "", value };
  } catch (error) {
    if (!(error instanceof GitApiError)) throw error;
    return { status: error.exitCode, stdout: command.getOutput(), stderr: error.message };
  }
}

/** Native git's outcome, stderr lines trimmed of the trailing newline. */
function native(dir: string, args: string[], extra?: Record<string, string>): Outcome {
  const r = gitRun(root, dir, args, extra);
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr.replace(/\n$/, "") };
}

/**
 * Runs `args` natively in one twin and `make(git)` in the other, comparing outcomes and
 * states; `compareStderr` false where only the status and stdout are compared.
 */
async function twin<T>(
  script: string,
  args: string[],
  make: (git: Git) => StashInfoCommand<T>,
  options: {
    compareStderr?: boolean;
    stdoutOf?: (value: T, command: StashInfoCommand<T>) => string;
  } = {},
): Promise<{ expected: Outcome; actual: Outcome }> {
  const [theirs, mine] = twins(script);
  const expected = native(theirs, args);
  const git = await openRepo(root, mine);
  const actual = await ours(make(git), options.stdoutOf);
  expect(
    { status: actual.status, stdout: actual.stdout },
    `${args.join(" ")}\n${expected.stderr}`,
  ).toEqual({ status: expected.status, stdout: expected.stdout });
  if (options.compareStderr !== false) expect(actual.stderr).toBe(expected.stderr);
  expect(state(mine)).toEqual(state(theirs));
  return { expected, actual };
}

/** Two stashes: `stash@{1}` a change of `file`, `stash@{0}` a staged and unstaged change. */
const TWO_STASHES = [
  "echo 4 >>file",
  "git stash -q",
  "echo staged >other",
  "git add other",
  "echo 5 >>file",
  "git stash -q -m second",
].join("\n");

describeGit("stash pop, show, branch, store and list against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "stash-complete-"));
    const version = gitOut(root, root, ["--version"]);
    compatibility = /git version 2\.43\./.test(version) ? "2.43" : "2.56";
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // --- pop (t3903-stash.sh) ---

  it("t3903 'stash pop': applies stash@{0} and drops it", async () => {
    const { expected } = await twin(TWO_STASHES, ["stash", "pop"], (g) => g.stashPop());
    expect(expected.stdout).toContain("Dropped refs/stash@{0}");
  });

  it("t3903 'pop -q works and is quiet'", async () => {
    await twin(TWO_STASHES, ["stash", "pop", "-q"], (g) => g.stashPop().setQuiet(true));
  });

  it("t3903 'drop middle stash' (pop stash@{1}, and pop 1)", async () => {
    await twin(TWO_STASHES, ["stash", "pop", "stash@{1}"], (g) =>
      g.stashPop().setStashRef("stash@{1}"),
    );
    await twin(TWO_STASHES, ["stash", "pop", "1"], (g) => g.stashPop().setStashRef("1"));
  });

  it("t3903 'stash pop --index': the index restored", async () => {
    await twin(TWO_STASHES, ["stash", "pop", "--index"], (g) => g.stashPop().setRestoreIndex(true));
  });

  it("t3903 'stash.index=true': pop defaults to --index (2.5x), ignored by 2.43", async () => {
    const script = `${TWO_STASHES}\ngit config stash.index true`;
    await twin(script, ["stash", "pop"], (g) => g.stashPop());
  });

  it("t3903 'pop -q --index' with a conflict: the entry is kept", async () => {
    const script = [
      "echo 4 >>file",
      "git stash -q",
      "echo conflicting >>file",
      "git commit -qam conflicting",
    ].join("\n");
    const { expected } = await twin(script, ["stash", "pop"], (g) => g.stashPop());
    expect(expected.status).toBe(1);
    expect(expected.stdout).toContain("The stash entry is kept in case you need it again.");
    await twin(
      script,
      ["stash", "pop", "-q", "--index"],
      (g) => g.stashPop().setQuiet(true).setRestoreIndex(true),
      { compareStderr: false },
    );
  });

  it("t3903 'stash pop' refused by local changes: the entry is kept", async () => {
    const script = ["echo 4 >>file", "git stash -q", "echo local >>file"].join("\n");
    const { expected } = await twin(script, ["stash", "pop"], (g) => g.stashPop(), {
      compareStderr: false,
    });
    expect(expected.status).toBe(compatibility === "2.43" ? 1 : 128);
  });

  it("t3905: pop restores the untracked files", async () => {
    const script = [
      "echo 4 >>file",
      "echo u >untracked",
      "mkdir d",
      "echo x >d/x",
      "git stash -q -u",
    ].join("\n");
    await twin(script, ["stash", "pop"], (g) => g.stashPop());
  });

  it("t3903 'pop: fails on stash-like commit not in stash' and other refusals", async () => {
    const n = counter;
    const script = `${TWO_STASHES}\ngit rev-parse stash@{0} >../id-${n}`;
    const id = () => readFileSync(join(root, `id-${n}`), "utf8").trim();
    const [theirs, mine] = twins(script);
    const expected = native(theirs, ["stash", "pop", id()]);
    const actual = await ours((await openRepo(root, mine)).stashPop().setStashRef(id()));
    expect(actual).toMatchObject(expected);
    expect(state(mine)).toEqual(state(theirs));

    await twin(TWO_STASHES, ["stash", "pop", "HEAD"], (g) => g.stashPop().setStashRef("HEAD"));
    await twin(TWO_STASHES, ["stash", "pop", "stash@{5}"], (g) =>
      g.stashPop().setStashRef("stash@{5}"),
    );
    await twin(TWO_STASHES, ["stash", "pop", "does-not-exist"], (g) =>
      g.stashPop().setStashRef("does-not-exist"),
    );
    await twin("", ["stash", "pop"], (g) => g.stashPop());
  });

  it("t3903: pop of `stash` (no entry number) applies, then cannot drop", async () => {
    await twin(TWO_STASHES, ["stash", "pop", "stash"], (g) => g.stashPop().setStashRef("stash"));
  });

  // --- show (t3903, t3905, t3907) ---

  const show = (script: string, args: string[], make: (g: Git) => StashInfoCommand<string>) =>
    twin(script, ["stash", "show", ...args], make, { stdoutOf: (text) => text });

  it("t3907: stash.showStat and stash.showPatch choose the output", async () => {
    const values = ["<unset>", "false", "true"];
    for (const stat of values) {
      for (const patch of values) {
        const config = [
          stat === "<unset>" ? "" : `git config stash.showStat ${stat}`,
          patch === "<unset>" ? "" : `git config stash.showPatch ${patch}`,
        ].join("\n");
        await show(`${TWO_STASHES}\n${config}`, [], (g) => g.stashShow());
      }
    }
  });

  it("t3903 'stash show format defaults to --stat', -p, --numstat, entries and commits", async () => {
    const n = counter;
    const script = `${TWO_STASHES}\ngit rev-parse stash@{1} >../id-${n}`;
    await show(script, [], (g) => g.stashShow());
    await show(script, ["-p"], (g) => g.stashShow().setFormats(["patch"]));
    await show(script, ["--numstat", "1"], (g) =>
      g.stashShow().setFormats(["numstat"]).setStashRef("1"),
    );
    await show(script, ["--stat", "-p", "stash@{1}"], (g) =>
      g.stashShow().setFormats(["patch", "stat"]).setStashRef("stash@{1}"),
    );
    await show(script, ["--name-status", "-R"], (g) =>
      g.stashShow().setFormats(["name-status"]).setOptions({ reverse: true }),
    );
    await show(script, ["--patience"], (g) => g.stashShow().setOptions({ algorithm: "patience" }));
    await show(script, ["--src-prefix=foo/", "--dst-prefix=bar/"], (g) =>
      g.stashShow().setOptions({ srcPrefix: "foo/", dstPrefix: "bar/" }),
    );
    // 'stash show - no stashes on stack, stash-like argument'
    const id = readFileSync(join(root, `id-${n}`), "utf8").trim();
    await show(`${script}\ngit stash clear`, ["-p", id], (g) =>
      g.stashShow().setFormats(["patch"]).setStashRef(id),
    );
  });

  it("t3903 'invalid ref of the form stash@{n}' and other refusals", async () => {
    await show(TWO_STASHES, ["stash@{5}"], (g) => g.stashShow().setStashRef("stash@{5}"));
    await show(TWO_STASHES, ["does-not-exist"], (g) => g.stashShow().setStashRef("does-not-exist"));
    await show(TWO_STASHES, ["HEAD"], (g) => g.stashShow().setStashRef("HEAD"));
    await show("", [], (g) => g.stashShow());
  });

  const UNTRACKED = [
    "echo 4 >>file",
    ">tracked",
    "git add tracked",
    "echo u >untracked",
    "mkdir -p dir",
    "echo x >dir/x",
    "git stash -q -u",
  ].join("\n");

  it("t3905 'stash show --include-untracked shows untracked files'", async () => {
    await show(UNTRACKED, ["--include-untracked"], (g) => g.stashShow().setUntracked("include"));
    await show(UNTRACKED, ["-u", "-p"], (g) =>
      g.stashShow().setUntracked("include").setFormats(["patch"]),
    );
    await show(UNTRACKED, ["-u", "--name-status", "-R"], (g) =>
      g
        .stashShow()
        .setUntracked("include")
        .setFormats(["name-status"])
        .setOptions({ reverse: true }),
    );
    await show(`${UNTRACKED}\ngit config stash.showIncludeUntracked true`, ["-p"], (g) =>
      g.stashShow().setFormats(["patch"]),
    );
    await show(`${UNTRACKED}\ngit config diff.mnemonicPrefix true`, ["-u", "-p"], (g) =>
      g.stashShow().setUntracked("include").setFormats(["patch"]),
    );
  });

  it("t3905 'stash show --only-untracked only shows untracked files'", async () => {
    await show(UNTRACKED, ["--only-untracked"], (g) => g.stashShow().setUntracked("only"));
    await show(UNTRACKED, ["--only-untracked", "-p"], (g) =>
      g.stashShow().setUntracked("only").setFormats(["patch"]),
    );
    await show(UNTRACKED, ["--only-untracked", "--no-include-untracked"], (g) =>
      g.stashShow().setUntracked("only").setUntracked("none"),
    );
  });

  it("t3905 'stash show --{include,only}-untracked on stashes without untracked entries'", async () => {
    await show(TWO_STASHES, ["-u"], (g) => g.stashShow().setUntracked("include"));
    await show(TWO_STASHES, ["--only-untracked"], (g) => g.stashShow().setUntracked("only"));
  });

  it("t3905 'stash show --include-untracked errors on duplicate files'", async () => {
    const script = (untracked: string) =>
      [
        ">tracked",
        "git add tracked",
        "tree=$(git write-tree)",
        'i=$(git commit-tree -p HEAD -m "index on any-branch" "$tree")',
        `u=$(GIT_INDEX_FILE=../uidx-$$; export GIT_INDEX_FILE; ${untracked}; ut=$(git write-tree); rm -f "$GIT_INDEX_FILE"; git commit-tree -m untracked "$ut")`,
        'w=$(git commit-tree -p HEAD -p "$i" -p "$u" -m "WIP on any-branch" "$tree")',
        'git stash store "$w"',
        "git rm -q --cached tracked",
        "rm -f tracked",
      ].join("\n");
    const { expected } = await show(
      script("git update-index --add tracked"),
      ["--include-untracked"],
      (g) => g.stashShow().setUntracked("include"),
    );
    expect(expected.stderr).toContain("duplicate entries: tracked");
    // a file of the worktree tree where the untracked tree has a directory
    await show(
      script("git update-index --add --cacheinfo 100644,$(git hash-object -w /dev/null),tracked/x"),
      ["-u"],
      (g) => g.stashShow().setUntracked("include"),
    );
  });

  // --- branch (t3903) ---

  it("t3903 'stash branch': the base checked out, the stash applied with its index, dropped", async () => {
    const script = [
      "echo 4 >>file",
      "git add file",
      "echo 5 >>file",
      "git stash -q",
      "echo moved >other",
      "git commit -qam moved",
    ].join("\n");
    const { expected } = await twin(
      script,
      ["stash", "branch", "stashbranch"],
      (g) => g.stashBranch().setBranchName("stashbranch"),
      { compareStderr: false },
    );
    expect(expected.stdout).toContain("Dropped refs/stash@{0}");
  });

  it("t3903 'stash branch - stashes on stack, stash-like argument': nothing dropped", async () => {
    const n = counter;
    const script = `${TWO_STASHES}\ngit rev-parse stash@{0} >../id-${n}`;
    const [theirs, mine] = twins(script);
    const id = readFileSync(join(root, `id-${n}`), "utf8").trim();
    const expected = native(theirs, ["stash", "branch", "b", id]);
    const actual = await ours(
      (await openRepo(root, mine)).stashBranch().setBranchName("b").setStashRef(id),
    );
    expect({ status: actual.status, stdout: actual.stdout }).toEqual({
      status: expected.status,
      stdout: expected.stdout,
    });
    expect(state(mine)).toEqual(state(theirs));
  });

  it("t3903 'stash branch' refusals: a branch of that name, no name, a bad stash", async () => {
    await twin(`${TWO_STASHES}\ngit branch taken`, ["stash", "branch", "taken"], (g) =>
      g.stashBranch().setBranchName("taken"),
    );
    await twin(TWO_STASHES, ["stash", "branch"], (g) => g.stashBranch());
    // 'stash branch exits with a non-1 status on errors'
    await twin(TWO_STASHES, ["stash", "branch", "x", "refs/heads/does-not-exist"], (g) =>
      g.stashBranch().setBranchName("x").setStashRef("refs/heads/does-not-exist"),
    );
  });

  // --- store (t3903) ---

  it("t3903 'store updates stash ref and reflog' (with and without -m)", async () => {
    const n = counter;
    const script = [
      "echo 4 >>file",
      `git stash create >../created-${n}`,
      "git stash -q -m older",
      "git checkout -q -- file",
    ].join("\n");
    const id = () => readFileSync(join(root, `created-${n}`), "utf8").trim();
    for (const message of [undefined, "custom message"]) {
      const [theirs, mine] = twins(script);
      const expected = native(theirs, [
        "stash",
        "store",
        ...(message ? ["-m", message] : []),
        id(),
      ]);
      const command = (await openRepo(root, mine)).stashStore().setCommit(id());
      if (message) command.setMessage(message);
      const actual = await ours(command, () => "");
      expect(actual).toMatchObject(expected);
      expect(state(mine)).toEqual(state(theirs));
    }
  });

  it("t3903 'store': refusals of commits that are no stash", async () => {
    await twin(TWO_STASHES, ["stash", "store", "HEAD"], (g) => g.stashStore().setCommit("HEAD"), {
      stdoutOf: () => "",
    });
    await twin(TWO_STASHES, ["stash", "store", "nope"], (g) => g.stashStore().setCommit("nope"), {
      stdoutOf: () => "",
    });
  });

  // --- list (t3903) ---

  it("t3903 'stash list' with log options", async () => {
    const script = `${TWO_STASHES}\necho 6 >>file\ngit stash -q -m third`;
    const [theirs, mine] = twins(script);
    const check = async (
      args: string[],
      options: Parameters<ReturnType<Git["stashList"]>["callText"]>[0],
      walk?: Parameters<ReturnType<Git["stashList"]>["callText"]>[1],
    ) => {
      const expected = gitOut(root, theirs, ["stash", "list", ...args]);
      const git = await openRepo(root, mine);
      expect(await git.stashList().callText(options, walk), args.join(" ")).toBe(expected);
    };
    await check([], {});
    await check(["--oneline"], { oneline: true });
    await check(["-p"], { patch: true });
    await check(["--stat", "-n1"], { stat: true }, (log) => log.setMaxCount(1));
    await check(["--skip=1"], {}, (log) => log.setSkip(1));
    await check(["--pretty=medium"], { pretty: "medium" });
    await check(["--format=%gd %gD %gs %gn %ge %h %s"], {
      pretty: "%gd %gD %gs %gn %ge %h %s",
    });
    await check(["--date=iso"], { date: "iso" });
    await check(["--grep=second"], {}, (log) => log.addGrep("second"));
    expect(state(mine)).toEqual(state(theirs));

    const [empty] = twins("");
    expect(gitOut(root, empty, ["stash", "list"])).toBe("");
    expect(await (await openRepo(root, empty)).stashList().callText()).toBe("");
  });
});
