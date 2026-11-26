/**
 * `git stash export` and `git stash import` (git 2.51+) against native git (t3903-stash):
 * twin copies of one repository built by native git, the subcommand run by native git in
 * one and by ours in the other, then the refs, every reflog file, stdout, stderr and the
 * exit status compared. A native git without the subcommands (2.43) runs only the
 * refusal twins, ours answering as 2.43 (`setCompatibility("2.43")`).
 */
import { execFileSync, spawnSync } from "node:child_process";
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
/** Whether the native git has `stash export`/`import` (2.51+) */
let nativeHasExport = false;

function sh(dir: string, script: string): void {
  execFileSync("sh", ["-ec", script], { cwd: dir, env: testEnv(root), stdio: "pipe" });
}

/** t3903's base repository, `script` run on it, copied twice. */
function twins(script: string): [string, string] {
  const dirs: [string, string] = [join(root, `n${counter}`), join(root, `o${counter}`)];
  counter++;
  const [first, second] = dirs;
  mkdirSync(first, { recursive: true });
  sh(
    first,
    [
      "git init -q -b main",
      "mkdir subdir",
      "printf '1\\n2\\n3\\n' >file",
      "echo other >other",
      "git add file other",
      "git commit -qm initial",
      script,
    ].join("\n"),
  );
  execFileSync("cp", ["-a", first, second]);
  return dirs;
}

/** Every file below `dir` with its content (the reflogs). */
function filesBelow(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(join(dir, prefix))) return out;
  for (const name of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${name.name}` : name.name;
    if (name.isDirectory()) Object.assign(out, filesBelow(dir, path));
    else out[path] = readFileSync(join(dir, path), "latin1");
  }
  return out;
}

/** What export and import may change, read with native git. */
function state(dir: string) {
  return {
    refs: gitOut(root, dir, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    logs: filesBelow(join(dir, ".git/logs")),
  };
}

type Outcome = { status: number; stdout: string; stderr: string };

async function ours<T>(command: StashInfoCommand<T>): Promise<Outcome> {
  command.setCompatibility(compatibility);
  try {
    const value = (await command.call()) as { errors?: string[] };
    return {
      status: 0,
      stdout: command.getOutput(),
      stderr: (value?.errors ?? []).join("\n"),
    };
  } catch (error) {
    if (!(error instanceof GitApiError)) throw error;
    return { status: error.exitCode, stdout: command.getOutput(), stderr: error.message };
  }
}

function native(dir: string, args: string[]): Outcome {
  const r = gitRun(root, dir, args);
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr.replace(/\n$/, "") };
}

/**
 * Runs `args` natively in one twin and `make(git)` in the other, comparing outcomes and
 * states; `firstLine` compares only stderr's first line (a usage error's message).
 */
async function twin<T>(
  script: string,
  args: string[],
  make: (git: Git) => StashInfoCommand<T>,
  options: { firstLine?: boolean } = {},
): Promise<Outcome> {
  const [theirs, mine] = twins(script);
  const expected = native(theirs, args);
  const git = await openRepo(root, mine);
  const actual = await ours(make(git));
  expect({ status: actual.status, stdout: actual.stdout }, args.join(" ")).toEqual({
    status: expected.status,
    stdout: expected.stdout,
  });
  const line = (s: string) => (options.firstLine ? s.split("\n")[0] : s);
  expect(line(actual.stderr)).toBe(line(expected.stderr));
  expect(state(mine)).toEqual(state(theirs));
  return expected;
}

/** t3903's two stashes: `stash@{1}` of tracked files, `stash@{0}` with untracked ones. */
const TWO_STASHES = [
  ">untracked",
  ">tracked1",
  ">tracked2",
  "git add tracked*",
  "git stash -q --",
  ">subdir/untracked",
  ">subdir/tracked1",
  ">subdir/tracked2",
  "git add subdir/tracked*",
  "git stash -q --include-untracked -- subdir/",
].join("\n");

/** TWO_STASHES exported to `refs/heads/foo` by native git, then the stash cleared. */
const EXPORTED = `${TWO_STASHES}\ngit stash export --to-ref refs/heads/foo\ngit stash clear`;

describeGit("stash export and import against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "stash-export-"));
    const probe = spawnSync("git", ["stash", "export", "-h"], { env: testEnv(root) });
    nativeHasExport = `${probe.stdout}${probe.stderr}`.includes("--to-ref");
    compatibility = nativeHasExport ? "2.56" : "2.43";
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const it51 = (name: string, fn: () => Promise<void>) =>
    it(name, async (context) => {
      if (!nativeHasExport) context.skip();
      await fn();
    });

  it51('t3903-stash.sh: "stash export and import round-trip stashes" (--print)', async () => {
    const expected = await twin(TWO_STASHES, ["stash", "export", "--print"], (g) =>
      g.stashExport().setPrint(true),
    );
    expect(expected.stdout).toMatch(/^[0-9a-f]{40}\n$/);
  });

  it51('t3903-stash.sh: "stash export and import round-trip stashes" (--to-ref)', async () => {
    await twin(TWO_STASHES, ["stash", "export", "--to-ref", "refs/heads/foo"], (g) =>
      g.stashExport().setToRef("refs/heads/foo"),
    );
  });

  it51('t3903-stash.sh: "stash export and import round-trip stashes" (import)', async () => {
    await twin(EXPORTED, ["stash", "import", "foo"], (g) => g.stashImport().setCommit("foo"));
  });

  it51('t3903-stash.sh: "stash import appends commits"', async () => {
    await twin(`${EXPORTED}\ngit stash import foo`, ["stash", "import", "refs/heads/foo"], (g) =>
      g.stashImport().setCommit("refs/heads/foo"),
    );
  });

  it51('t3903-stash.sh: "stash export can accept specified stashes"', async () => {
    await twin(
      TWO_STASHES,
      ["stash", "export", "--to-ref", "refs/heads/bar", "stash@{1}", "stash@{0}"],
      (g) => g.stashExport().setToRef("refs/heads/bar").addStash("stash@{1}").addStash("stash@{0}"),
    );
    await twin(TWO_STASHES, ["stash", "export", "--print", "1"], (g) =>
      g.stashExport().setPrint(true).addStash("1"),
    );
    // a stash the reflog lacks, and a commit that is no stash
    await twin(TWO_STASHES, ["stash", "export", "--print", "5"], (g) =>
      g.stashExport().setPrint(true).addStash("5"),
    );
    await twin(TWO_STASHES, ["stash", "export", "--print", "HEAD"], (g) =>
      g.stashExport().setPrint(true).addStash("HEAD"),
    );
  });

  it51(
    "refs/stash's reflog holding a commit that is no stash: exit 0, nothing written",
    async () => {
      const expected = await twin(
        `${TWO_STASHES}\ngit update-ref -m bad refs/stash main`,
        ["stash", "export", "--to-ref", "refs/heads/foo"],
        (g) => g.stashExport().setToRef("refs/heads/foo"),
      );
      expect(expected.stderr).toContain("does not look like a stash commit");
    },
  );

  it51('t3903-stash.sh: "stash export rejects invalid arguments"', async () => {
    await twin(TWO_STASHES, ["stash", "export", "--print", "--to-ref", "refs/heads/invalid"], (g) =>
      g.stashExport().setPrint(true).setToRef("refs/heads/invalid"),
    );
    await twin(TWO_STASHES, ["stash", "export"], (g) => g.stashExport());
  });

  it51('t3903-stash.sh: "stash can import and export zero stashes"', async () => {
    await twin("", ["stash", "export", "--to-ref", "refs/heads/baz"], (g) =>
      g.stashExport().setToRef("refs/heads/baz"),
    );
    await twin("git stash export --to-ref refs/heads/baz", ["stash", "import", "baz"], (g) =>
      g.stashImport().setCommit("baz"),
    );
  });

  it51('t3903-stash.sh: "stash rejects invalid attempts to import commits"', async () => {
    const imported = `${EXPORTED}\ngit stash import foo`;
    await twin(imported, ["stash", "import", "HEAD"], (g) => g.stashImport().setCommit("HEAD"));
    const fake = (parents: string) =>
      [
        imported,
        "git checkout -q --orphan orphan",
        `c=$(git commit-tree $(git hash-object -t tree /dev/null) ${parents} -m "")`,
        'git update-ref refs/heads/orphan "$c"',
      ].join("\n");
    await twin(
      fake('-p "$(git rev-parse main)" -p "$(git rev-parse foo)"'),
      ["stash", "import", "orphan"],
      (g) => g.stashImport().setCommit("orphan"),
    );
    await twin(fake(""), ["stash", "import", "orphan"], (g) => g.stashImport().setCommit("orphan"));
    // a revision naming nothing, a blob, no revision at all
    await twin(imported, ["stash", "import", "nothing"], (g) =>
      g.stashImport().setCommit("nothing"),
    );
    await twin(imported, ["stash", "import", "HEAD:file"], (g) =>
      g.stashImport().setCommit("HEAD:file"),
    );
    await twin(imported, ["stash", "import"], (g) => g.stashImport(), { firstLine: true });
  });

  it("git 2.43 has neither subcommand", async (context) => {
    if (nativeHasExport) context.skip();
    await twin(TWO_STASHES, ["stash", "export", "--print"], (g) => g.stashExport().setPrint(true), {
      firstLine: true,
    });
    await twin(
      TWO_STASHES,
      ["stash", "export", "--to-ref", "refs/heads/foo"],
      (g) => g.stashExport().setToRef("refs/heads/foo"),
      { firstLine: true },
    );
    await twin(TWO_STASHES, ["stash", "export"], (g) => g.stashExport());
    await twin(TWO_STASHES, ["stash", "import", "HEAD"], (g) => g.stashImport().setCommit("HEAD"));
  });
});
