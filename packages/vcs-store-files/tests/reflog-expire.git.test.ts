/**
 * gc's reflog step against native git, after git's t1410-reflog and t6500-gc: the same
 * repository, reflog entries dated with `GIT_COMMITTER_DATE` relative to the clock (as both
 * gcs take "now" from it), is gc'ed by native git and by ours; the reflogs left, and the
 * objects left after `--prune=now`, are the same. Covers `gc.reflogExpire` (90 days),
 * `gc.reflogExpireUnreachable` (30 days), per-ref patterns, `refs/stash`, a linked worktree's
 * HEAD, and `never` for both (the step is skipped).
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { GitObjects } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend, expireReflogs, gc, wildmatch } from "../src/index.js";

const DAY = 24 * 3600;
const now = Math.floor(Date.now() / 1000);
const BASE_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};
/** git run as if `daysAgo` days before now (commit and reflog dates) */
const git = (cwd: string, args: string[], daysAgo = 0) => {
  const date = `${now - Math.round(daysAgo * DAY)} +0000`;
  return execFileSync("git", args, {
    cwd,
    env: { ...BASE_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    maxBuffer: 1 << 30,
  }).toString();
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "reflog-expire-"));
  dirs.push(d);
  return d;
};

let counter = 0;
function commit(dir: string, daysAgo: number, message: string) {
  writeFileSync(join(dir, "file.txt"), `${message} ${counter++}\n`);
  git(dir, ["add", "-A"], daysAgo);
  git(dir, ["commit", "-q", "-m", message], daysAgo);
}

/**
 * A repository whose reflogs hold entries of every age: reachable ones 120, 60 and 10 days
 * old, commits rewound away 60 and 10 days ago (unreachable), a branch deleted and
 * recreated, a stash 100 days old, a tag ref, and a linked worktree with its own HEAD log.
 */
function scenario(): string {
  const root = tmp();
  const dir = join(root, "repo");
  git(root, ["init", "-q", "--initial-branch=main", "repo"]);
  commit(dir, 120, "first");
  commit(dir, 100, "second");
  git(dir, ["branch", "keep-old"], 100);
  git(dir, ["branch", "topic"], 100);
  // a commit rewound away 60 days ago: its entries are unreachable from main
  commit(dir, 70, "lost-old");
  git(dir, ["reset", "-q", "--hard", "HEAD~1"], 60);
  commit(dir, 50, "third");
  // a stash 100 days old would expire, but refs/stash never does unless configured
  writeFileSync(join(dir, "file.txt"), "dirty\n");
  git(dir, ["stash", "-q"], 45);
  // rewound 10 days ago: younger than gc.reflogExpireUnreachable, kept
  commit(dir, 12, "lost-young");
  git(dir, ["reset", "-q", "--hard", "HEAD~1"], 10);
  commit(dir, 5, "fourth");
  git(dir, ["checkout", "-q", "topic"], 40);
  commit(dir, 40, "topic work");
  git(dir, ["reset", "-q", "--hard", "HEAD~1"], 35);
  git(dir, ["checkout", "-q", "main"], 2);
  git(dir, ["tag", "-a", "-m", "v1", "v1"], 80);
  git(dir, ["config", "core.logAllRefUpdates", "always"]);
  git(dir, ["tag", "-f", "-a", "-m", "v1 again", "v1"], 3);
  git(dir, ["worktree", "add", "-q", "--detach", join(root, "wt"), "HEAD~1"], 95);
  commit(join(root, "wt"), 94, "worktree old");
  git(join(root, "wt"), ["checkout", "-q", "--detach", "main"], 1);
  // ours keeps what pseudo-refs name (ORIG_HEAD here), git's prune does not: not this test's
  // subject
  rmSync(join(dir, ".git", "ORIG_HEAD"), { force: true });
  return dir;
}

/** Every reflog of the repository and its worktrees, by path, as text. */
function reflogs(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const gitDir = join(dir, ".git");
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(gitDir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(join(gitDir, "logs"));
  const wts = join(gitDir, "worktrees");
  if (existsSync(wts)) for (const id of readdirSync(wts)) walk(join(wts, id, "logs"));
  return out;
}

const allObjects = (dir: string) =>
  git(dir, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
    .split("\n")
    .filter(Boolean)
    .sort();

/** Two copies of `dir`: native git runs in one, ours in the other. */
function twins(dir: string): [string, string] {
  const root = tmp();
  const a = join(root, "native");
  const b = join(root, "ours");
  cpSync(dir, a, { recursive: true });
  cpSync(dir, b, { recursive: true });
  return [a, b];
}

async function ourGc(dir: string) {
  const files = createNodeFilesApi({ rootDir: dir });
  const b = await createGitFilesBackend({ files });
  return gc({ history: b.history, files, pruneExpireMs: 0 });
}

describe("gc's reflog step (t1410, t6500)", () => {
  it("expires as git gc does with the default 90 and 30 days, then prunes the same objects", async () => {
    const dir = scenario();
    const before = reflogs(dir);
    // the scenario has entries to expire of both kinds
    expect(before["logs/HEAD"]?.split("\n").length).toBeGreaterThan(5);
    const [native, ours] = twins(dir);
    git(native, ["gc", "-q", "--prune=now"]);
    const r = await ourGc(ours);
    expect(r.reflogEntriesPruned).toBeGreaterThan(0);
    expect(reflogs(ours)).toEqual(reflogs(native));
    expect(allObjects(ours)).toEqual(allObjects(native));
    git(ours, ["fsck", "--no-progress"]);
  });

  it("honours gc.reflogExpire, gc.reflogExpireUnreachable and their per-ref patterns", async () => {
    const dir = scenario();
    git(dir, ["config", "gc.reflogExpire", "55.days.ago"]);
    git(dir, ["config", "gc.reflogExpireUnreachable", "7.days.ago"]);
    git(dir, ["config", "gc.refs/heads/keep*.reflogExpire", "never"]);
    git(dir, ["config", "gc.refs/heads/topic.reflogExpireUnreachable", "now"]);
    git(dir, ["config", "gc.refs/stash.reflogExpire", "30.days.ago"]);
    const [native, ours] = twins(dir);
    git(native, ["gc", "-q", "--prune=now"]);
    await ourGc(ours);
    expect(reflogs(ours)).toEqual(reflogs(native));
    expect(allObjects(ours)).toEqual(allObjects(native));
  });

  it("reflog expire --all with --expire=now drops every entry (t1410 'prune and fsck')", async () => {
    const dir = scenario();
    const [native, ours] = twins(dir);
    git(native, ["reflog", "expire", "--all", "--expire=now"]);
    const files = createNodeFilesApi({ rootDir: ours });
    const b = await createGitFilesBackend({ files });
    await expireReflogs({
      files,
      refs: b.history.refs,
      objects: b.history.objects as GitObjects,
      now,
      expire: Number.POSITIVE_INFINITY,
    });
    expect(reflogs(ours)).toEqual(reflogs(native));
  });

  it("skips the step when both settings are never", async () => {
    const dir = scenario();
    git(dir, ["config", "gc.reflogExpire", "never"]);
    git(dir, ["config", "gc.reflogExpireUnreachable", "never"]);
    const before = reflogs(dir);
    const [native, ours] = twins(dir);
    git(native, ["gc", "-q", "--prune=now"]);
    const r = await ourGc(ours);
    expect(r.reflogEntriesPruned).toBeUndefined();
    expect(reflogs(ours)).toEqual(before);
    expect(reflogs(native)).toEqual(before);
    expect(allObjects(ours)).toEqual(allObjects(native));
  });

  it("matches ref names with wildmatch, '*' crossing '/'", () => {
    expect(wildmatch("refs/heads/*", "refs/heads/a/b")).toBe(true);
    expect(wildmatch("refs/heads/keep*", "refs/heads/keep-old")).toBe(true);
    expect(wildmatch("refs/heads/[a-c]?", "refs/heads/bz")).toBe(true);
    expect(wildmatch("refs/heads/[!a-c]?", "refs/heads/bz")).toBe(false);
    expect(wildmatch("refs/stash", "refs/stash")).toBe(true);
  });
});
