/**
 * `git branch` upstream management and its small modes against native git: `-u` /
 * `--set-upstream-to`, `--unset-upstream`, `-t` / `--track[=direct|inherit]`, `--no-track`,
 * `branch.autoSetupMerge`, `branch.autoSetupRebase` (t3200-branch.sh), `checkout --track -b`
 * (t2027-checkout-track.sh), `--show-current` (t3203-branch-output.sh), `--edit-description`
 * and `--create-reflog` (t3200-branch.sh). Each case copies one fixture twice, runs the
 * command through native git in one copy and through ours in the other, and compares the
 * exit status, stdout, stderr, `.git/config` (byte for byte), the branches and their
 * reflogs.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, GitApiError, TrackMode } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let version = "";
let counter = 0;

const env = (): Record<string, string> => ({ ...nativeGitEnv(root), TZ: "UTC" });
const compatibility = (): "2.43" | "2.56" => (gitAtLeast(version, 2, 45) ? "2.56" : "2.43");

function run(cwd: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync("git", args, { cwd, env: { ...env(), ...extra } });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout as Buffer).toString("latin1"),
    stderr: (r.stderr as Buffer).toString("latin1"),
  };
}

/** Runs a setup script (bash) in `dir`. */
function sh(dir: string, script: string): void {
  const r = spawnSync("bash", ["-c", `set -e\n${script}`], { cwd: dir, env: env() });
  if (r.status !== 0) throw new Error(`setup failed: ${r.stderr.toString()}`);
}

async function openOurs(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const e = env();
  const environment = createNodeGitHostEnvironment({
    env: e,
    hookRunner: createNodeHookRunner({ env: e, compatibility: compatibility() }),
  });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

const lines = (list: string[]) => list.map((l) => `${l}\n`).join("");

/** `git branch <args>` (or `git checkout <args>` when `args[0]` is `checkout`) through ours. */
async function runOurs(dir: string, args: string[], editorText?: string): Promise<Outcome> {
  const git = await openOurs(dir);
  let stdout = "";
  let stderr = "";
  try {
    if (args[0] === "checkout") {
      const command = git.checkout();
      const rest = args.slice(1);
      const positional: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i] as string;
        if (arg === "-b") {
          command.setCreateBranch(true).setName(rest[++i] as string);
        } else if (arg === "--track" || arg === "-t" || arg === "--track=direct") {
          command.setTrack(TrackMode.DIRECT);
        } else if (arg === "--track=inherit") {
          command.setTrack(TrackMode.INHERIT);
        } else if (arg === "--no-track") {
          command.setTrack(TrackMode.NONE);
        } else positional.push(arg);
      }
      if (positional[0]) command.setStartPoint(positional[0]);
      const result = await command.call();
      stdout = lines(result.output ?? []);
      stderr = lines(result.warnings ?? []);
      return { status: 0, stdout, stderr };
    }
    const positional: string[] = [];
    let mode: "create" | "set" | "unset" | "current" | "describe" = "create";
    let upstream = "";
    let track = TrackMode.DEFAULT;
    let reflog = false;
    let force = false;
    let quiet = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (arg === "-u" || arg === "--set-upstream-to") {
        mode = "set";
        upstream = args[++i] as string;
      } else if (arg.startsWith("--set-upstream-to=")) {
        mode = "set";
        upstream = arg.slice("--set-upstream-to=".length);
      } else if (arg === "--unset-upstream") mode = "unset";
      else if (arg === "--show-current") mode = "current";
      else if (arg === "--edit-description") mode = "describe";
      else if (arg === "-t" || arg === "--track" || arg === "--track=direct") {
        track = TrackMode.DIRECT;
      } else if (arg === "--track=inherit") track = TrackMode.INHERIT;
      else if (arg === "--no-track") track = TrackMode.NONE;
      else if (arg === "--create-reflog") reflog = true;
      else if (arg === "-f") force = true;
      else if (arg === "-q") quiet = true;
      else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
      else positional.push(arg);
    }
    switch (mode) {
      case "set": {
        if (positional.length > 1) {
          throw new GitApiError("fatal: too many arguments to set new upstream");
        }
        const command = git.branchSetUpstream().setUpstream(upstream).setQuiet(quiet);
        if (positional[0] !== undefined) command.setBranch(positional[0]);
        try {
          await command.call();
        } finally {
          stdout = lines(command.getOutput());
          stderr = lines(command.getWarnings());
        }
        break;
      }
      case "unset": {
        if (positional.length > 1) {
          throw new GitApiError("fatal: too many arguments to unset upstream");
        }
        const command = git.branchUnsetUpstream();
        if (positional[0] !== undefined) command.setBranch(positional[0]);
        await command.call();
        break;
      }
      case "current": {
        const name = await git.branchShowCurrent().call();
        stdout = name === undefined ? "" : `${name}\n`;
        break;
      }
      case "describe": {
        const command = git.branchEditDescription();
        if (positional[0] !== undefined) command.setBranch(positional[0]);
        if (editorText !== undefined) command.setEditor(async () => editorText);
        await command.call();
        break;
      }
      default: {
        const command = git
          .branchCreate()
          .setName(positional[0] as string)
          .setTrack(track)
          .setCreateReflog(reflog)
          .setForce(force)
          .setQuiet(quiet);
        if (positional[1] !== undefined) command.setStartPoint(positional[1]);
        try {
          await command.call();
        } finally {
          stdout = lines(command.getOutput());
          stderr = lines(command.getWarnings());
        }
      }
    }
    return { status: 0, stdout, stderr };
  } catch (e) {
    if (!(e instanceof GitApiError)) throw e;
    return { status: e.exitCode, stdout, stderr: `${stderr}${e.message}\n` };
  }
}

/** Branches with their ids, and the reflogs of `refs/heads/`. */
function state(dir: string): string {
  const refs = execFileSync("git", ["for-each-ref", "--format=%(objectname) %(refname)"], {
    cwd: dir,
    env: env(),
    encoding: "latin1",
  });
  let out = refs;
  const logs = join(dir, ".git", "logs", "refs", "heads");
  const walk = (path: string, prefix: string): void => {
    if (!existsSync(path)) return;
    for (const name of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, name.name);
      if (name.isDirectory()) walk(full, `${prefix}${name.name}/`);
      else out += `log ${prefix}${name.name}:\n${readFileSync(full, "latin1")}`;
    }
  };
  walk(logs, "");
  return out;
}

/** A case: the t/ source, a script run in both copies first, the git arguments. */
interface Case {
  source: string;
  before?: string;
  args: string[];
  /** what the editor writes for `--edit-description` */
  editor?: string;
  /** [major, minor] native git must be at least */
  since?: [number, number];
}

/** Runs `c` against copies of `fixture` and compares. */
async function twin(fixture: string, c: Case): Promise<void> {
  if (c.since && !gitAtLeast(version, c.since[0], c.since[1])) return;
  const n = counter++;
  const native = join(root, `n${n}`);
  const ours = join(root, `o${n}`);
  execFileSync("cp", ["-a", fixture, native]);
  execFileSync("cp", ["-a", fixture, ours]);
  if (c.before) {
    sh(native, c.before);
    sh(ours, c.before);
  }
  const label = `${c.source}: ${c.args[0] === "checkout" ? "" : "branch "}${c.args.join(" ")}`;
  let extra: Record<string, string> = {};
  if (c.editor !== undefined) {
    const file = join(root, `editor-${n}.txt`);
    writeFileSync(file, c.editor);
    extra = { GIT_EDITOR: `cp ${file}` };
  }
  const expected = run(native, c.args[0] === "checkout" ? c.args : ["branch", ...c.args], extra);
  if (c.args[0] === "checkout") {
    // checkout's own progress line is not this test's subject
    expected.stderr = expected.stderr.replace(/^Switched to a new branch '.*'\n/m, "");
  }
  const actual = await runOurs(ours, c.args, c.editor);
  expect({ label, ...actual }).toEqual({ label, ...expected });
  expect(readFileSync(join(ours, ".git", "config"), "latin1"), `${label} (config)`).toBe(
    readFileSync(join(native, ".git", "config"), "latin1"),
  );
  expect(state(ours), `${label} (refs)`).toBe(state(native));
  if (c.editor !== undefined) {
    const read = (dir: string) => {
      const path = join(dir, ".git", "EDIT_DESCRIPTION");
      return existsSync(path) ? readFileSync(path, "latin1") : undefined;
    };
    expect(read(ours), `${label} (EDIT_DESCRIPTION)`).toBe(read(native));
  }
}

/** Builds a fixture with `script` (two commits on main, a remote's tracking branches). */
function fixture(name: string, script: string): string {
  const dir = join(root, name);
  sh(
    root,
    `git init -q -b main ${name}
cd ${name}
echo one >one.t && git add one.t && git commit -q -m one && git tag one
echo two >two.t && git add two.t && git commit -q -m two && git tag two
${script}`,
  );
  return dir;
}

const REMOTES = `
git config remote.origin.url ../elsewhere
git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git update-ref refs/remotes/origin/main HEAD
git update-ref refs/remotes/origin/topic HEAD^
git update-ref refs/remotes/origin/o/o HEAD
git config remote.local.url .
git config remote.local.fetch 'refs/heads/*:refs/remotes/local/*'
git update-ref refs/remotes/local/main HEAD
git branch mybase HEAD^
git branch my1 local/main
git config branch.my1.remote local
git config branch.my1.merge refs/heads/main
`;

describeGit("git branch upstream management against native git", () => {
  let base = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "branch-upstream-"));
    version = run(root, ["--version"]).stdout;
    base = fixture("base", REMOTES);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("t3200: --track, --no-track and branch.autoSetupMerge", { timeout: 120_000 }, async () => {
    const cases: Case[] = [
      { source: "t3200 test tracking setup via --track", args: ["--track", "my2", "local/main"] },
      { source: "t3200 --track (remote)", args: ["-t", "t1", "origin/main"] },
      { source: "t3200 --track=direct", args: ["--track=direct", "t2", "origin/topic"] },
      {
        source: "t3200 test tracking setup (non-wildcard, matching)",
        before: "git config remote.local.fetch refs/heads/main:refs/remotes/local/main",
        args: ["--track", "my4", "local/main"],
      },
      {
        source: "t3200 tracking setup fails on non-matching refspec",
        before: "git config remote.local.fetch refs/heads/s:refs/remotes/local/s",
        args: ["--track", "my5", "local/main"],
      },
      {
        source: "t3200 test tracking setup via config",
        before: "git config branch.autosetupmerge true",
        args: ["my3", "local/main"],
      },
      { source: "t3200 default tracks a remote-tracking start", args: ["d1", "origin/main"] },
      { source: "t3200 default does not track a local start", args: ["d2", "main"] },
      {
        source: "t3200 test overriding tracking setup via --no-track",
        before: "git config branch.autosetupmerge true",
        args: ["--no-track", "my2", "local/main"],
      },
      {
        source: "t3200 autoSetupMerge=false",
        before: "git config branch.autosetupmerge false",
        args: ["nt", "origin/main"],
      },
      {
        source: "t3200 test tracking setup via --track but deeper",
        args: ["--track", "my7", "origin/o/o"],
      },
      { source: "t3200 test --track without .fetch entries", args: ["--track", "my8"] },
      {
        source: "t3200 branch from non-branch HEAD w/autosetupmerge=always",
        before: "git config branch.autosetupmerge always",
        args: ["my9", "HEAD^"],
      },
      {
        source: "t3200 autosetupmerge=always on a local branch",
        before: "git config branch.autosetupmerge always",
        args: ["al", "mybase"],
      },
      {
        source: "t3200 branch from non-branch HEAD w/--track causes failure",
        args: ["--track", "my10", "HEAD^"],
      },
      {
        source: "t3200 branch from tag w/--track causes failure",
        args: ["--track", "my11", "one"],
      },
      { source: "t3200 --track of a missing start", args: ["--track", "my12", "nothing"] },
      { source: "t3200 a missing start", args: ["my12", "nothing"] },
      {
        source: "t3200 simple tracking works when remote branch name matches",
        before: "git config branch.autosetupmerge simple",
        args: ["topic", "origin/topic"],
      },
      {
        source: "t3200 simple tracking skips when remote branch name does not match",
        before: "git config branch.autosetupmerge simple",
        args: ["my-other", "local/main"],
      },
      {
        source: "t3200 simple tracking skips when remote ref is not a branch",
        before: `git config branch.autosetupmerge simple
git config remote.localtags.url .
git config remote.localtags.fetch 'refs/tags/*:refs/remotes/localtags/*'
git update-ref refs/remotes/localtags/mytag12 HEAD`,
        args: ["mytag12", "localtags/mytag12"],
      },
      {
        source: "t3200 avoid ambiguous track and advise",
        before: `git config branch.autosetupmerge true
git config remote.ambi1.url lalala
git config remote.ambi1.fetch refs/heads/lalala:refs/heads/main
git config remote.ambi2.url lilili
git config remote.ambi2.fetch refs/heads/lilili:refs/heads/main`,
        args: ["all1", "main"],
      },
      {
        source: "t3200 tracking with unexpected .fetch refspec",
        before: `git config remote.c.url ../c
git config remote.c.fetch '+refs/remotes/*:refs/remotes/*'
git update-ref refs/remotes/a/main HEAD`,
        args: ["--track", "local/a/main", "remotes/a/main"],
      },
      { source: "t3200 -q", args: ["-q", "--track", "qq", "origin/main"] },
      { source: "t3200 -f resets and tracks", args: ["-f", "--track", "mybase", "origin/topic"] },
    ];
    for (const c of cases) await twin(base, c);
  });

  it("t3200: branch.autoSetupRebase", { timeout: 120_000 }, async () => {
    const cases: Case[] = [];
    for (const setting of ["never", "local", "remote", "always", undefined]) {
      const before = setting ? `git config branch.autosetuprebase ${setting}` : undefined;
      const source = `t3200 autosetuprebase ${setting ?? "unconfigured"}`;
      cases.push(
        {
          source: `${source} on a tracked local branch`,
          before,
          args: ["--track", "myr1", "mybase"],
        },
        {
          source: `${source} on a tracked remote branch`,
          before,
          args: ["--track", "myr2", "local/main"],
        },
        {
          source: `${source} on an untracked local branch`,
          before,
          args: ["--no-track", "myr3", "mybase"],
        },
        {
          source: `${source} on an untracked remote branch`,
          before,
          args: ["--no-track", "myr4", "local/main"],
        },
      );
    }
    cases.push({
      source: "t3200 autosetuprebase always on detached HEAD",
      before:
        "git config branch.autosetupmerge always\ngit config branch.autosetuprebase always\ngit checkout -q HEAD^0",
      args: ["my11"],
    });
    for (const c of cases) await twin(base, c);
  });

  it("t3200: --track=inherit and autoSetupMerge=inherit", { timeout: 120_000 }, async () => {
    const cases: Case[] = [
      {
        source: "t3200 tracking info copied with --track=inherit",
        args: ["--track=inherit", "foo2", "my1"],
      },
      {
        source: "t3200 tracking info copied with autoSetupMerge=inherit",
        before: "git config branch.autoSetupMerge inherit",
        args: ["foo3", "my1"],
      },
      {
        source: "t3200 autoSetupMerge=inherit: no tracking info to inherit from main",
        before: "git config branch.autoSetupMerge inherit",
        args: ["main2", "main"],
      },
      {
        source: "t3200 --track=inherit without merge",
        before: "git config branch.mybase.remote origin",
        args: ["--track=inherit", "fm", "mybase"],
      },
      {
        source: "t3200 --track overrides branch.autoSetupMerge",
        before: "git config branch.autoSetupMerge inherit",
        args: ["--track=direct", "foo4", "my1"],
      },
      {
        source: "t3200 --no-track overrides branch.autoSetupMerge",
        before: "git config branch.autoSetupMerge inherit",
        args: ["--no-track", "foo5", "my1"],
      },
      {
        source: "t3200 --track=inherit of a local upstream (remote = .)",
        before: "git branch --track lb main",
        args: ["--track=inherit", "lc", "lb"],
      },
      {
        source: "t3200 --track=inherit of several merges",
        before: "git config --add branch.my1.merge refs/heads/x",
        args: ["--track=inherit", "multi", "my1"],
      },
      {
        source: "t3200 --track=inherit of several merges when rebasing",
        before:
          "git config --add branch.my1.merge refs/heads/x\ngit config branch.autosetuprebase always",
        args: ["--track=inherit", "multi", "my1"],
      },
      {
        source: "t3200 --track=inherit of a remote-tracking start",
        args: ["--track=inherit", "ri", "origin/main"],
      },
    ];
    for (const c of cases) await twin(base, c);
  });

  it("t3200: --set-upstream-to and --unset-upstream", { timeout: 120_000 }, async () => {
    const cases: Case[] = [
      {
        source: "t3200 --set-upstream-to fails on multiple branches",
        args: ["--set-upstream-to", "main", "a", "b", "c"],
      },
      {
        source: "t3200 --set-upstream-to fails on detached HEAD",
        before: "git checkout -q HEAD^{}",
        args: ["--set-upstream-to", "main"],
      },
      {
        source: "t3200 --set-upstream-to fails on a missing dst branch",
        args: ["--set-upstream-to", "main", "does-not-exist"],
      },
      {
        source: "t3200 --set-upstream-to suggests <remote>/<branch> on slip",
        before: "git update-ref refs/remotes/origin/slip-feature HEAD",
        args: ["--set-upstream-to", "origin", "slip-feature"],
      },
      {
        source: "t3200 --set-upstream-to slip without the advice",
        before:
          "git update-ref refs/remotes/origin/slip-feature HEAD\ngit config advice.setUpstreamFailure false",
        args: ["--set-upstream-to", "origin", "slip-feature"],
      },
      {
        source: "t3200 --set-upstream-to does not suggest when no matching remote ref",
        args: ["--set-upstream-to", "origin", "no-such-branch"],
      },
      {
        source: "t3200 --set-upstream-to to a local branch is not mistaken for a slip",
        before: "git branch slip-local-target",
        args: ["--set-upstream-to=mybase", "slip-local-target"],
      },
      {
        source: "t3200 --set-upstream-to fails on a missing src branch",
        args: ["--set-upstream-to", "does-not-exist", "main"],
      },
      {
        source: "t3200 --set-upstream-to missing src without the advice",
        before: "git config advice.setUpstreamFailure false",
        args: ["--set-upstream-to", "does-not-exist", "main"],
      },
      {
        source: "t3200 --set-upstream-to fails on a non-ref",
        args: ["--set-upstream-to", "HEAD^{}"],
      },
      { source: "t3200 --set-upstream-to of a tag", args: ["-u", "one"] },
      {
        source: "t3200 use --set-upstream-to modify HEAD",
        before: "git config branch.main.remote foo\ngit config branch.main.merge foo",
        args: ["--set-upstream-to", "mybase"],
      },
      {
        source: "t3200 use --set-upstream-to modify a particular branch",
        args: ["--set-upstream-to", "main", "mybase"],
      },
      { source: "t3200 -u origin/main", args: ["-u", "origin/main"] },
      { source: "t3200 -u origin/main HEAD", args: ["-u", "origin/main", "HEAD"] },
      {
        source: "t3200 -u of a branch with more config",
        before:
          "git config branch.mybase.description desc\ngit config branch.mybase.merge refs/heads/old",
        args: ["-u", "origin/topic", "mybase"],
      },
      {
        source: "t3200 -u with autosetuprebase",
        before: "git config branch.autosetuprebase remote",
        args: ["-u", "origin/topic"],
      },
      {
        source: "t3200 -u on an unborn branch",
        before: "git checkout -q --orphan unborn",
        args: ["-u", "origin/main"],
      },
      {
        source: "t3200 -u naming an unborn branch checked out",
        before: "git checkout -q --orphan unborn",
        args: ["-u", "origin/main", "unborn"],
      },
      { source: "t3200 -u origin (no origin/HEAD)", args: ["-u", "origin"] },
      {
        source: "t3200 -u origin (origin/HEAD)",
        before: "git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/topic",
        args: ["-u", "origin"],
      },
      {
        source: "t3200 -u @{-1}",
        before: "git checkout -q mybase\ngit checkout -q main",
        args: ["-u", "origin/topic", "@{-1}"],
      },
      {
        source: "t3200 --unset-upstream should fail if given a non-existent branch",
        args: ["--unset-upstream", "i-dont-exist"],
      },
      {
        source: "t3200 test --unset-upstream on HEAD",
        before: "git branch --set-upstream-to mybase",
        args: ["--unset-upstream"],
      },
      {
        source: "t3200 test --unset-upstream on HEAD without upstream",
        args: ["--unset-upstream"],
      },
      {
        source: "t3200 --unset-upstream should fail on multiple branches",
        args: ["--unset-upstream", "a", "b", "c"],
      },
      {
        source: "t3200 --unset-upstream should fail on detached HEAD",
        before: "git checkout -q HEAD^{}",
        args: ["--unset-upstream"],
      },
      {
        source: "t3200 test --unset-upstream on a particular branch",
        args: ["--unset-upstream", "my1"],
      },
      {
        source: "t3200 --unset-upstream keeps rebase and other keys",
        before: "git config branch.my1.rebase true\ngit config branch.my1.description d",
        args: ["--unset-upstream", "my1"],
      },
      {
        source: "t3200 --set-upstream-to notices an error to set branch as own upstream",
        args: ["--set-upstream-to", "refs/heads/mybase", "mybase"],
      },
      {
        source: "t3200 --set-upstream-to ambiguous remotes",
        before: `git config remote.ambi1.url lalala
git config remote.ambi1.fetch refs/heads/lalala:refs/heads/main
git config remote.ambi2.url lilili
git config remote.ambi2.fetch refs/heads/lilili:refs/heads/main`,
        args: ["-u", "main", "mybase"],
      },
    ];
    for (const c of cases) await twin(base, c);
  });

  it("t3200: --create-reflog", { timeout: 120_000 }, async () => {
    const cases: Case[] = [
      {
        source: "t3200 git branch --create-reflog d/e/f should create a branch and a log",
        before: "git config core.logallrefupdates false",
        args: ["--create-reflog", "d/e/f"],
      },
      {
        source: "t3200 no log without --create-reflog when core.logAllRefUpdates=false",
        before: "git config core.logallrefupdates false",
        args: ["g"],
      },
      { source: "t3200 --create-reflog with logs on", args: ["--create-reflog", "h", "mybase"] },
      {
        source: "t3200 --create-reflog -f appends",
        before: "git config core.logallrefupdates false",
        args: ["--create-reflog", "-f", "mybase", "main"],
      },
    ];
    for (const c of cases) await twin(base, c);
  });

  it("t3203: --show-current", { timeout: 120_000 }, async () => {
    const cases: Case[] = [
      { source: "t3203 git branch --show-current shows current branch", args: ["--show-current"] },
      {
        source: "t3203 git branch --show-current is silent when detached HEAD",
        before: "git checkout -q HEAD^0",
        args: ["--show-current"],
      },
      {
        source: "t3203 git branch --show-current works properly when tag exists",
        before: "git checkout -q -b mytag\ngit tag mytag",
        args: ["--show-current"],
      },
      {
        source: "t3203 --show-current on an unborn branch",
        before: "git checkout -q --orphan unborn",
        args: ["--show-current"],
      },
      {
        source: "t3203 --show-current outside refs/heads",
        before: "git symbolic-ref HEAD refs/remotes/origin/main",
        args: ["--show-current"],
      },
    ];
    for (const c of cases) await twin(base, c);
  });

  it("t3200: --edit-description", { timeout: 120_000 }, async () => {
    const cases: Case[] = [
      {
        source: "t3200 use --edit-description (unchanged)",
        args: ["--edit-description"],
        editor: "",
      },
      {
        source: "t3200 use --edit-description",
        args: ["--edit-description"],
        editor: "New contents\n",
      },
      {
        source: "t3200 --edit-description strips comments and blank lines",
        args: ["--edit-description", "mybase"],
        editor: "\n\nhello  \n# c\n\n\nworld\n\n",
      },
      {
        source: "t3200 --edit-description keeps the old description",
        before: "git config branch.mybase.description 'old one'",
        args: ["--edit-description", "mybase"],
        editor: "old one\n# Please edit\n",
      },
      {
        source: "t3200 --edit-description emptied removes it",
        before: "git config branch.mybase.description 'old one'",
        args: ["--edit-description", "mybase"],
        editor: "# nothing\n",
      },
      {
        source: "t3200 --edit-description with core.commentChar",
        before: "git config core.commentChar ';'",
        args: ["--edit-description"],
        editor: "# kept\n; dropped\n",
      },
      {
        source: "t3200 detect typo in branch name when using --edit-description",
        args: ["--edit-description", "no-such-branch"],
        editor: "New contents\n",
      },
      {
        source: "t3200 refuse --edit-description on unborn branch for now",
        before: "git checkout -q --orphan unborn",
        args: ["--edit-description"],
        editor: "New contents\n",
      },
      {
        source: "t3200 --edit-description on a detached HEAD",
        before: "git checkout -q HEAD^0",
        args: ["--edit-description"],
        editor: "New contents\n",
      },
    ];
    for (const c of cases) await twin(base, c);
  });

  it("t2027: checkout --track -b", { timeout: 120_000 }, async () => {
    const cases: Case[] = [
      {
        source: "t2027 checkout --track -b creates a new tracking branch",
        args: ["checkout", "--track", "-b", "branch1", "main"],
      },
      {
        source: "t2027 checkout --track=inherit -b copies main's tracking",
        before: `git config branch.main.remote origin
git config branch.main.merge refs/heads/some-branch
git config branch.autoSetupMerge inherit`,
        args: ["checkout", "--track=inherit", "-b", "b1", "main"],
      },
      {
        source: "t2027 checkout -b with autoSetupMerge=inherit",
        before: `git config branch.main.remote origin
git config branch.main.merge refs/heads/some-branch
git config branch.autoSetupMerge inherit`,
        args: ["checkout", "-b", "b2", "main"],
      },
      {
        source: "t2027 checkout --track -b overrides autoSetupMerge=inherit",
        before: `git config branch.main.remote origin
git config branch.main.merge refs/heads/some-branch
git config branch.autoSetupMerge inherit`,
        args: ["checkout", "--track", "-b", "b3", "main"],
      },
      {
        source: "t2027 checkout --track=direct -b overrides autoSetupMerge=inherit",
        before: `git config branch.main.remote origin
git config branch.main.merge refs/heads/some-branch
git config branch.autoSetupMerge inherit`,
        args: ["checkout", "--track=direct", "-b", "b4", "main"],
      },
      {
        source: "t2027 checkout -b of a remote-tracking branch",
        args: ["checkout", "-b", "t5", "origin/topic"],
      },
    ];
    for (const c of cases) await twin(base, c);
  });
});
