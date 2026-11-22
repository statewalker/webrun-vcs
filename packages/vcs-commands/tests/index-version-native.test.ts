/**
 * The index version and the untracked cache an index write takes from the configuration,
 * against native git: read-cache.c's `get_index_format_default` (`$GIT_INDEX_VERSION`,
 * `index.version`, `feature.manyFiles`) for an index with no file behind it, the version read
 * kept for one rewritten, and repo-settings.c's `core.untrackedCache` applied to every index
 * git reads (`tweak_untracked_cache`: an empty cache added, or the cache removed), which any
 * command writing the index then writes.
 *
 * The twins run in one directory: the index (and shared indexes) are put back before our run,
 * so both write the same stat data, and the bytes are compared.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { parseIndexFile, parseUntrackedCache } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Git, IndexVersionConfigError, ResetMode, takeIndexWarnings } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
const env = (extra: Record<string, string> = {}) => ({ ...nativeGitEnv(root), ...extra });
const git = (cwd: string, args: string[], extra?: Record<string, string>) =>
  execFileSync("git", args, {
    cwd,
    env: env(extra),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "index-version-native-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Seconds far in the past, a fresh one each time: no entry is ever racily clean. */
let clock = 1_500_000_000;
function put(dir: string, path: string, content: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
  clock += 10;
  utimesSync(join(dir, path), clock, clock);
}

/** A repository with files (none added yet), `core.trustctime` off (ctime cannot be dated). */
function repo(): string {
  const dir = mkdtempSync(join(root, "repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "core.trustctime", "false"]);
  put(dir, "a.txt", "a\n");
  put(dir, "dir/sub/one.txt", "one\n");
  put(dir, "dir/sub/two.txt", "two\n");
  put(dir, "dir/three.txt", "three\n");
  put(dir, "zeta.txt", "z\n");
  return dir;
}

const STATE = [
  "index",
  "HEAD",
  "ORIG_HEAD",
  "refs/heads/main",
  "refs/heads/topic",
  "logs/HEAD",
  "logs/refs/heads/main",
  "logs/refs/heads/topic",
];

/** The index, the shared indexes and HEAD's branch, as bytes by name (absent ones left out). */
function saveState(dir: string): Map<string, Buffer> {
  const state = new Map<string, Buffer>();
  const gitDir = join(dir, ".git");
  for (const name of readdirSync(gitDir)) {
    if (name.startsWith("sharedindex.")) state.set(name, readFileSync(join(gitDir, name)));
  }
  for (const p of STATE) {
    try {
      state.set(p, readFileSync(join(gitDir, p)));
    } catch {
      // absent
    }
  }
  return state;
}

function restoreState(dir: string, state: Map<string, Buffer>): void {
  const gitDir = join(dir, ".git");
  for (const name of readdirSync(gitDir)) {
    if (name.startsWith("sharedindex.")) unlinkSync(join(gitDir, name));
  }
  for (const p of STATE) rmSync(join(gitDir, p), { force: true });
  for (const [p, bytes] of state) {
    mkdirSync(join(gitDir, p, ".."), { recursive: true });
    writeFileSync(join(gitDir, p), bytes);
  }
}

function indexFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const gitDir = join(dir, ".git");
  for (const name of readdirSync(gitDir).sort()) {
    if (name === "index" || name.startsWith("sharedindex.")) {
      out.set(name, readFileSync(join(gitDir, name)));
    }
  }
  return out;
}

async function ours(dir: string, extra?: Record<string, string>): Promise<Git> {
  return openOurs(dir, createNodeGitHostEnvironment({ env: env(extra) }));
}

interface TwinResult {
  theirs: Map<string, Buffer>;
  ours: Map<string, Buffer>;
  /** native git's stderr */
  stderr: string;
}

/** Runs native `git <args>` and then our `run` from the same state; both runs' index files. */
async function twins(
  dir: string,
  args: string[],
  run: (git: Git) => Promise<unknown>,
  extra?: Record<string, string>,
): Promise<TwinResult & { git: Git }> {
  const before = saveState(dir);
  const native = spawnSync("git", args, { cwd: dir, env: env(extra), encoding: "utf8" });
  if (native.status !== 0) throw new Error(`git ${args.join(" ")}: ${native.stderr}`);
  const theirs = indexFiles(dir);
  restoreState(dir, before);
  const g = await ours(dir, extra);
  await run(g);
  return { theirs, ours: indexFiles(dir), stderr: native.stderr, git: g };
}

function expectSame(result: TwinResult, label = ""): void {
  expect([...result.ours.keys()], label).toEqual([...result.theirs.keys()]);
  for (const [name, bytes] of result.theirs) {
    expect(result.ours.get(name)?.equals(bytes), `${label} ${name}`).toBe(true);
  }
}

/** A version 2 index with each entry's stat data (ctime to inode) and the trailer zeroed. */
function zeroStat(bytes: Buffer): Buffer {
  const out = Buffer.from(bytes);
  const count = out.readUInt32BE(8);
  let at = 12;
  for (let i = 0; i < count; i++) {
    out.fill(0, at, at + 24);
    const nameLength = out.readUInt16BE(at + 60) & 0xfff;
    at += (62 + nameLength + 8) & ~7;
  }
  out.fill(0, out.length - 20);
  return out;
}

function withoutStat(result: TwinResult): TwinResult {
  const strip = (files: Map<string, Buffer>) =>
    new Map([...files].map(([name, bytes]) => [name, zeroStat(bytes)]));
  return { ...result, theirs: strip(result.theirs), ours: strip(result.ours) };
}

/** The index file's header version. */
const versionOf = (bytes: Buffer | undefined) => bytes?.readUInt32BE(4);

async function untrackedOf(bytes: Buffer | undefined) {
  if (!bytes) return undefined;
  const parsed = await parseIndexFile(new Uint8Array(bytes));
  const ext = parsed.extensionData.find((e) => e.signature === "UNTR");
  return ext ? parseUntrackedCache(ext.data) : undefined;
}

/** The staging a `Git` writes through, for its index warnings. */
const stagingOf = (g: Git) =>
  (g as unknown as { workingCopy: { checkout: { staging: object } } }).workingCopy.checkout.staging;

describeGit("index.version, GIT_INDEX_VERSION and feature.manyFiles against native git", () => {
  it("a new index takes index.version=4; a rewrite keeps the version read", async () => {
    const dir = repo();
    git(dir, ["config", "index.version", "4"]);
    const added = await twins(dir, ["add", "."], (g) => g.add().addFilepattern(".").call());
    expectSame(added);
    expect(versionOf(added.ours.get("index"))).toBe(4);
    // the v4 index read and rewritten (prefix-compressed names, a cache-tree)
    const committed = await twins(dir, ["commit", "-q", "-m", "init"], (g) =>
      g.commit().setMessage("init\n").call(),
    );
    expectSame(committed);
    expect(versionOf(committed.ours.get("index"))).toBe(4);
    put(dir, "dir/sub/one.txt", "one, changed\n");
    put(dir, "dir/new.txt", "new\n");
    const again = await twins(dir, ["add", "dir"], (g) => g.add().addFilepattern("dir").call());
    expectSame(again);
    git(dir, ["fsck", "--no-dangling"]);
    expect(git(dir, ["status", "--porcelain"])).toBe("A  dir/new.txt\nM  dir/sub/one.txt");
  });

  it("an existing version 2 index stays version 2 under index.version=4", async () => {
    const dir = repo();
    git(dir, ["add", "."]);
    git(dir, ["config", "index.version", "4"]);
    put(dir, "b.txt", "b\n");
    const added = await twins(dir, ["add", "b.txt"], (g) => g.add().addFilepattern("b.txt").call());
    expectSame(added);
    expect(versionOf(added.ours.get("index"))).toBe(2);
  });

  it("feature.manyFiles: version 4, a null trailer and an empty untracked cache", async () => {
    const dir = repo();
    git(dir, ["config", "feature.manyFiles", "true"]);
    const added = await twins(dir, ["add", "."], (g) => g.add().addFilepattern(".").call());
    expectSame(added);
    const index = added.ours.get("index");
    expect(versionOf(index)).toBe(4);
    expect(index?.subarray(-20).every((b) => b === 0)).toBe(true);
    const cache = await untrackedOf(index);
    expect(cache?.root).toBeUndefined();
    expect(cache?.dirFlags).toBe(6);
    // index.version overrides feature.manyFiles
    const other = repo();
    git(other, ["config", "feature.manyFiles", "true"]);
    git(other, ["config", "index.version", "2"]);
    const two = await twins(other, ["add", "."], (g) => g.add().addFilepattern(".").call());
    expectSame(two);
    expect(versionOf(two.ours.get("index"))).toBe(2);
  });

  it("GIT_INDEX_VERSION comes before index.version", async () => {
    const dir = repo();
    git(dir, ["config", "index.version", "2"]);
    const added = await twins(dir, ["add", "."], (g) => g.add().addFilepattern(".").call(), {
      GIT_INDEX_VERSION: "4",
    });
    expectSame(added);
    expect(versionOf(added.ours.get("index"))).toBe(4);
  });

  it("an invalid version falls back to 3 with git's warning", async () => {
    for (const [config, extra, warning] of [
      [["index.version", "9"], {}, "warning: index.version set, but the value is invalid."],
      [[], { GIT_INDEX_VERSION: "x" }, "warning: GIT_INDEX_VERSION set, but the value is invalid."],
    ] as const) {
      const dir = repo();
      if (config.length > 0) git(dir, ["config", ...config]);
      const added = await twins(
        dir,
        ["add", "."],
        (g) => g.add().addFilepattern(".").call(),
        extra,
      );
      expectSame(added);
      // 3 without extended flags is written as 2
      expect(versionOf(added.ours.get("index"))).toBe(2);
      const expected = `${warning}\nUsing version 3`;
      expect(added.stderr.trimEnd()).toBe(expected);
      expect(takeIndexWarnings(stagingOf(added.git))).toEqual([expected]);
      // a rewrite keeps the version read: no warning
      put(dir, "b.txt", "b\n");
      const rewritten = await twins(
        dir,
        ["add", "b.txt"],
        (g) => g.add().addFilepattern("b.txt").call(),
        extra,
      );
      expectSame(rewritten);
      expect(rewritten.stderr).toBe("");
      expect(takeIndexWarnings(stagingOf(rewritten.git))).toEqual([]);
    }
  });

  it("an index.version that is not a number: git dies, ours refuses the write", async () => {
    const dir = repo();
    git(dir, ["config", "index.version", "four"]);
    const native = spawnSync("git", ["add", "."], { cwd: dir, env: env(), encoding: "utf8" });
    expect(native.status).toBe(128);
    expect(native.stderr.trimEnd()).toBe(
      "fatal: bad numeric config value 'four' for 'index.version' in file .git/config: invalid unit",
    );
    const g = await ours(dir);
    const error = await g
      .add()
      .addFilepattern(".")
      .call()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IndexVersionConfigError);
    expect((error as IndexVersionConfigError).lines).toEqual([native.stderr.trimEnd()]);
    expect(indexFiles(dir).size).toBe(0);
  });

  it("a split index under index.version=4: shared and split files in version 4", async () => {
    const dir = repo();
    git(dir, ["config", "index.version", "4"]);
    git(dir, ["config", "core.splitIndex", "true"]);
    const added = await twins(dir, ["add", "."], (g) => g.add().addFilepattern(".").call());
    expectSame(added);
    const names = [...added.ours.keys()];
    expect(names.filter((n) => n.startsWith("sharedindex."))).toHaveLength(1);
    for (const bytes of added.ours.values()) expect(versionOf(bytes)).toBe(4);
    put(dir, "b.txt", "b\n");
    expectSame(await twins(dir, ["add", "b.txt"], (g) => g.add().addFilepattern("b.txt").call()));
    expect(git(dir, ["ls-files"]).split("\n")).toHaveLength(6);
  });
});

describeGit("core.untrackedCache in index writers other than status, against native git", () => {
  /** A committed repository with an untracked file and directory. */
  function committed(): string {
    const dir = repo();
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "init"]);
    put(dir, "untracked.txt", "u\n");
    put(dir, "new/u.txt", "u\n");
    return dir;
  }

  it("add writes the empty cache core.untrackedCache=true adds, even adding nothing", async () => {
    const dir = committed();
    git(dir, ["config", "core.untrackedCache", "true"]);
    // nothing to add: the cache alone makes git write the index (SKIP_IF_UNCHANGED)
    const nothing = await twins(dir, ["add", "a.txt"], (g) =>
      g.add().addFilepattern("a.txt").call(),
    );
    expectSame(nothing);
    const cache = await untrackedOf(nothing.ours.get("index"));
    expect(cache).toBeDefined();
    // add runs read_directory without the cache: nothing is filled in
    expect(cache?.root).toBeUndefined();
    const added = await twins(dir, ["add", "untracked.txt"], (g) =>
      g.add().addFilepattern("untracked.txt").call(),
    );
    expectSame(added);
    // status fills it; a later add keeps it, its directories invalidated
    git(dir, ["status", "--porcelain"]);
    put(dir, "new/v.txt", "v\n");
    const after = await twins(dir, ["add", "new/v.txt"], (g) =>
      g.add().addFilepattern("new/v.txt").call(),
    );
    expectSame(after);
    expect((await untrackedOf(after.ours.get("index")))?.root).toBeDefined();
  });

  it("a fresh repository's first add writes the cache, the flags of status.showUntrackedFiles", async () => {
    const dir = repo();
    git(dir, ["config", "core.untrackedCache", "true"]);
    git(dir, ["config", "status.showUntrackedFiles", "all"]);
    const added = await twins(dir, ["add", "a.txt"], (g) => g.add().addFilepattern("a.txt").call());
    expectSame(added);
    expect((await untrackedOf(added.ours.get("index")))?.dirFlags).toBe(0);
  });

  it("core.untrackedCache=false removes the cache in add, commit -a and reset", async () => {
    for (const [args, run] of [
      [["add", "a.txt"], (g: Git) => g.add().addFilepattern("a.txt").call()],
      [
        ["commit", "-q", "-a", "-m", "next"],
        (g: Git) => g.commit().setAll(true).setMessage("next\n").call(),
      ],
      [["reset", "-q"], (g: Git) => g.reset().setMode(ResetMode.MIXED).call()],
    ] as const) {
      const dir = committed();
      git(dir, ["config", "core.untrackedCache", "true"]);
      git(dir, ["status", "--porcelain"]);
      expect(await untrackedOf(indexFiles(dir).get("index"))).toBeDefined();
      git(dir, ["config", "core.untrackedCache", "false"]);
      put(dir, "a.txt", "a, changed\n");
      const result = await twins(dir, [...args], run);
      expectSame(result, args.join(" "));
      expect(await untrackedOf(result.ours.get("index"))).toBeUndefined();
    }
  });

  it("commit -a, reset and checkout write the cache core.untrackedCache=true adds", async () => {
    for (const [args, run] of [
      [
        ["commit", "-q", "-a", "-m", "next"],
        (g: Git) => g.commit().setAll(true).setMessage("next\n").call(),
      ],
      [["reset", "-q", "--hard"], (g: Git) => g.reset().setMode(ResetMode.HARD).call()],
      [
        ["checkout", "-q", "-b", "topic"],
        (g: Git) => g.checkout().setName("topic").setCreateBranch(true).call(),
      ],
    ] as const) {
      const dir = committed();
      git(dir, ["config", "core.untrackedCache", "true"]);
      put(dir, "a.txt", "a, changed\n");
      const result = await twins(dir, [...args], run);
      // our reset --hard rewrites every file (git keeps the clean ones): stat data aside
      if (args[0] === "reset") expectSame(withoutStat(result), args.join(" "));
      else expectSame(result, args.join(" "));
      const cache = await untrackedOf(result.ours.get("index"));
      expect(cache).toBeDefined();
      expect(cache?.root).toBeUndefined();
    }
  });
});
