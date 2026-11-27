/**
 * Repository events (JGit's `ListenerList`: RefsChangedEvent, IndexChangedEvent,
 * ConfigChangedEvent, WorkingTreeModifiedEvent) against the writes native git makes.
 *
 * Native git has no listener API, so each scenario runs the command natively in one copy of a
 * repository and ours in the other, compares the repositories, and checks our events against
 * what native git wrote: its `reference-transaction` hook (`committed` with updates) for refs,
 * its post-index-change hook for the index (both log to one file, in order), the config
 * file's bytes, and the worktree's files. Inputs: JGit ConfigChangeEventTest
 * ("testFileRepository_ChangeEventsOnlyOnSave"), the ref, index and worktree scenarios from
 * JGit's RefsChangedEvent/IndexChangedEvent/WorkingTreeModifiedEvent uses (branch, add,
 * commit, checkout, rm).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import type { RepositoryEvent } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { type HookTwin, hookTwins, nativeIn, nativeIs25x } from "./hooks-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, putFile } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);
/** `git` that may fail (`symbolic-ref -q` of a detached HEAD): its stdout, else "". */
const gitMaybe = (cwd: string, args: string[]) => {
  try {
    return gitOut(root, cwd, args);
  } catch {
    return "";
  }
};

/** Hooks logging `index` after each index write and `refs` after each committed transaction. */
function installEventHooks(dir: string): void {
  const hooks = join(dir, ".git/hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "post-index-change"), `#!/bin/sh\necho index >> "$HOOK_LOG"\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(hooks, "reference-transaction"),
    `#!/bin/sh\nin=$(cat)\nif [ "$1" = committed ] && [ -n "$in" ]; then echo refs >> "$HOOK_LOG"; fi\n`,
    { mode: 0o755 },
  );
}

/** A repository with two files on main and a branch `other` changing one of them. */
function base(): string {
  const dir = join(root, "r");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, "a.txt", "a\n");
  putFile(dir, "d/f.txt", "f\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  git(dir, ["checkout", "-q", "-b", "other"]);
  putFile(dir, "a.txt", "other\n");
  git(dir, ["commit", "-qam", "other"]);
  git(dir, ["checkout", "-q", "main"]);
  installEventHooks(dir);
  return dir;
}

/** The worktree's files (`.git` left out): path to mode and content. */
function snapshot(dir: string, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === ".git") continue;
    if (entry.isDirectory()) {
      for (const [p, v] of snapshot(dir, path)) out.set(p, v);
    } else out.set(path, readFileSync(join(dir, path), "latin1"));
  }
  return out;
}

/** Paths whose file changed or appeared, and paths gone, between two snapshots. */
function worktreeChanges(before: Map<string, string>, after: Map<string, string>) {
  const modified = [...after].filter(([p, v]) => before.get(p) !== v).map(([p]) => p);
  const deleted = [...before.keys()].filter((p) => !after.has(p));
  return { modified: modified.sort(), deleted: deleted.sort() };
}

/** The repository state both twins must agree on. */
function state(dir: string): string {
  return [
    git(dir, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"]),
    gitMaybe(dir, ["symbolic-ref", "-q", "HEAD"]),
    git(dir, ["ls-files", "-s"]),
    git(dir, ["status", "--porcelain"]),
    readFileSync(join(dir, ".git/config"), "latin1"),
  ].join("\n");
}

/** Our working copy (GitWorkingCopy, as `openGitLinkedWorktrees` makes it) over a twin. */
async function oursIn(twin: HookTwin): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: twin.dir });
  const environment = createNodeGitHostEnvironment({ env: twin.env });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** The refs as git reads them, HEAD included. */
function refsState(dir: string): string {
  return [
    git(dir, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"]),
    git(dir, ["rev-parse", "HEAD"]),
    gitMaybe(dir, ["symbolic-ref", "-q", "HEAD"]),
  ].join("\n");
}

/** Runs of consecutive equal kinds, with their lengths. */
function counted(kinds: string[]): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const k of kinds) {
    const last = out[out.length - 1];
    if (last && last[0] === k) last[1]++;
    else out.push([k, 1]);
  }
  return out;
}

interface Observed {
  events: RepositoryEvent[];
  stop: () => void;
}

function observe(g: Git): Observed {
  const events: RepositoryEvent[] = [];
  const listeners = g.workingCopy.listeners;
  if (!listeners) throw new Error("no listeners on the working copy");
  const stop = listeners.addListener((event) => events.push(event));
  return { events, stop };
}

/**
 * Runs `args` natively and `run` in ours over twins of `dir` (after `prepare`), then checks
 * the repositories match and our events follow native git's writes.
 */
async function expectEvents(
  dir: string,
  args: string[],
  run: (g: Git) => Promise<unknown>,
  prepare?: (twinDir: string) => void,
): Promise<RepositoryEvent[]> {
  const [theirs, mine] = hookTwins(root, dir);
  prepare?.(theirs.dir);
  prepare?.(mine.dir);
  // only the command's writes: not the twins' refresh nor `prepare`'s
  rmSync(theirs.log, { force: true });
  const refsBefore = refsState(theirs.dir);
  const configBefore = readFileSync(join(theirs.dir, ".git/config"), "latin1");
  const worktreeBefore = snapshot(theirs.dir);
  const native = nativeIn(theirs, root, args);
  expect(native.status, native.stderr).toBe(0);
  const configChanged = readFileSync(join(theirs.dir, ".git/config"), "latin1") !== configBefore;
  const nativeWorktree = worktreeChanges(worktreeBefore, snapshot(theirs.dir));
  // git 2.43 writes HEAD outside a transaction (no hook): after the index, as checkout does
  const nativeWrites = nativeLog(theirs);
  if (refsState(theirs.dir) !== refsBefore && !nativeWrites.includes("refs")) {
    nativeWrites.push("refs");
  }

  const g = await oursIn(mine);
  const seen = observe(g);
  await run(g);
  seen.stop();

  const label = args.join(" ");
  expect(state(mine.dir), label).toBe(state(theirs.dir));
  // worktree, index and refs writes in native git's order (git writes an operation's files
  // first), each run no longer than native git's: once per write
  const kinds = seen.events
    .filter((e) => e.type !== "config-changed")
    .map((e) =>
      e.type === "refs-changed" ? "refs" : e.type === "index-changed" ? "index" : "worktree",
    );
  const expected = [
    ...(nativeWorktree.modified.length + nativeWorktree.deleted.length > 0 ? ["worktree"] : []),
    ...nativeWrites,
  ];
  const ours = counted(kinds);
  const theirsRuns = counted(expected);
  expect(
    ours.map(([k]) => k),
    label,
  ).toEqual(theirsRuns.map(([k]) => k));
  ours.forEach(([kind, n], i) => {
    // git 2.43 updates HEAD outside a transaction: one ref write more than its hook tells
    const allowed = theirsRuns[i][1] + (kind === "refs" && !nativeIs25x ? 1 : 0);
    expect(n, `${label}: ${kind} events of run ${i}`).toBeLessThanOrEqual(allowed);
  });
  // the config once per write of the file
  const configEvents = seen.events.filter((e) => e.type === "config-changed").length;
  expect(configEvents, label).toBe(configChanged ? 1 : 0);
  // the worktree's files as native git changed them
  const modified = new Set<string>();
  const deleted = new Set<string>();
  for (const e of seen.events) {
    if (e.type !== "working-tree-modified") continue;
    for (const p of e.modified) modified.add(p);
    for (const p of e.deleted) deleted.add(p);
  }
  expect({ modified: [...modified].sort(), deleted: [...deleted].sort() }, label).toEqual(
    nativeWorktree,
  );
  return seen.events;
}

function nativeLog(twin: HookTwin): string[] {
  if (!existsSync(twin.log)) return [];
  return readFileSync(twin.log, "latin1").split("\n").filter(Boolean);
}

describeGit("repository events: as native git writes", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "repository-events-"));
  });
  afterEach(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it('ConfigChangeEventTest: "testFileRepository_ChangeEventsOnlyOnSave"', async () => {
    const dir = base();
    // set a value: no event until the config is saved, then one
    await expectEvents(dir, ["config", "test.section.event", "value"], async (g) => {
      const config = g.workingCopy.config as unknown as {
        set(key: string, value: string): void;
        save(): Promise<void>;
      };
      let fired = 0;
      const stop = g.workingCopy.listeners?.addConfigChangedListener(() => fired++);
      config.set("test.section.event", "value");
      expect(fired).toBe(0);
      await config.save();
      expect(fired).toBe(1);
      stop?.();
    });
    // unset it again: the same
    const set = (d: string) => git(d, ["config", "test.section.event", "value"]);
    await expectEvents(
      dir,
      ["config", "--unset", "test.section.event"],
      async (g) => {
        const config = g.workingCopy.config as unknown as {
          unset(key: string): void;
          save(): Promise<void>;
        };
        config.unset("test.section.event");
        await config.save();
      },
      set,
    );
  });

  it("git config set and unset (ConfigChangeEventTest inputs through the command)", async () => {
    const dir = base();
    await expectEvents(dir, ["config", "test.section.event", "value"], (g) =>
      g.config().set("test.section.event", "value").call(),
    );
    await expectEvents(
      dir,
      ["config", "--unset", "test.section.event"],
      (g) => g.config().unset("test.section.event").call(),
      (d) => git(d, ["config", "test.section.event", "value"]),
    );
    // a failing unset writes nothing and tells nothing
    const [, mine] = hookTwins(root, dir);
    const g = await oursIn(mine);
    const seen = observe(g);
    await g.config().unset("test.none").call();
    expect(seen.events).toEqual([]);
  });

  it("branch create and delete: refs changed", async () => {
    const dir = base();
    await expectEvents(dir, ["branch", "topic"], (g) => g.branchCreate().setName("topic").call());
    await expectEvents(
      dir,
      ["branch", "-D", "topic"],
      (g) => g.branchDelete().setBranchNames("topic").setForce(true).call(),
      (d) => git(d, ["branch", "topic"]),
    );
  });

  it("add, commit and rm: index, refs and worktree", async () => {
    const dir = base();
    const change = (d: string) => putFile(d, "a.txt", "changed\n");
    const added = await expectEvents(
      dir,
      ["add", "a.txt"],
      (g) => g.add().addFilepattern("a.txt").call(),
      change,
    );
    expect(added.map((e) => e.type)).toEqual(["index-changed"]);
    await expectEvents(
      dir,
      ["commit", "-qm", "two"],
      (g) => g.commit().setMessage("two").call(),
      (d) => {
        change(d);
        git(d, ["add", "a.txt"]);
      },
    );
    await expectEvents(dir, ["rm", "-q", "d/f.txt"], (g) =>
      g.rm().addFilepattern("d/f.txt").call(),
    );
  });

  it("checkout of a branch, checkout -b and a path checkout", async () => {
    const dir = base();
    await expectEvents(dir, ["checkout", "-q", "other"], (g) =>
      g.checkout().setName("other").call(),
    );
    await expectEvents(dir, ["checkout", "-q", "-b", "fresh"], (g) =>
      g.checkout().setCreateBranch(true).setName("fresh").call(),
    );
    await expectEvents(
      dir,
      ["checkout", "--", "a.txt"],
      (g) => g.checkout().addPath("a.txt").call(),
      (d) => putFile(d, "a.txt", "dirty\n"),
    );
  });

  it("a read-only command tells nothing; a listener removed hears nothing", async () => {
    const dir = base();
    const [, mine] = hookTwins(root, dir);
    const g = await oursIn(mine);
    const seen = observe(g);
    for await (const _ of await g.log().call());
    expect(seen.events).toEqual([]);
    seen.stop();
    await g.branchCreate().setName("later").call();
    expect(seen.events).toEqual([]);
    execFileSync("git", ["rev-parse", "--verify", "later"], { cwd: mine.dir });
  });
});
