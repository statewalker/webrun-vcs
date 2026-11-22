/**
 * `gc --auto` and its pre-auto-gc hook against native git (builtin/gc.c, need_to_gc): no
 * hook and nothing done below `gc.auto` (estimated from `objects/17`) and
 * `gc.autoPackLimit`; above, the hook runs first and a refusal leaves the repository as it
 * is. Each case runs `git gc --auto` in one copy of a repository and ours in the other.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type HookTwin,
  hookExit,
  hookLog,
  hookTwins,
  installHooks,
  nativeIn,
  oursIn,
} from "./hooks-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/** `count` blob contents whose ids start with `17` (the fan-out directory git counts). */
function seventeenBlobs(count: number): string[] {
  const out: string[] = [];
  for (let n = 0; out.length < count; n++) {
    const content = `blob ${n}\n`;
    const id = createHash("sha1")
      .update(`blob ${Buffer.byteLength(content)}\0${content}`)
      .digest("hex");
    if (id.startsWith("17")) out.push(content);
  }
  return out;
}

/** A repository with `loose` loose blobs in `objects/17`, gc.auto=1 and the logging hook. */
function base(loose: number): string {
  const dir = join(root, "r");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, "a.txt", "a\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  for (const content of seventeenBlobs(loose)) {
    spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: dir,
      env: testEnv(root),
      input: content,
    });
  }
  git(dir, ["config", "gc.auto", "1"]);
  git(dir, ["config", "gc.autoDetach", "false"]);
  installHooks(join(dir, ".git/hooks"), ["pre-auto-gc"]);
  return dir;
}

/**
 * Native `gc --auto` reading the repository's gc.auto: the test environment's command-line
 * `gc.auto=0` (GIT_CONFIG_KEY_1) left out, its `maintenance.auto=false` kept.
 */
const gcAuto = (twin: HookTwin) =>
  nativeIn(twin, root, ["gc", "--auto"], { GIT_CONFIG_COUNT: "1" });

/** Ours alike: the command line (which ours reads too) without `gc.auto=0`. */
const oursAuto = (twin: HookTwin) => oursIn(twin, { GIT_CONFIG_COUNT: "1" });

const seventeen = (twin: HookTwin) => readdirSync(join(twin.dir, ".git/objects/17")).sort();

describeGit("pre-auto-gc hook: gc --auto as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-auto-gc-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("below the thresholds: no hook, nothing done", async () => {
    const [theirs, mine] = hookTwins(root, base(1));
    const native = gcAuto(theirs);
    const result = await (await oursAuto(mine)).gc().setAuto(true).call();
    expect(native.status).toBe(0);
    expect(result.autoSkipped).toBe("not-needed");
    expect(hookLog(mine)).toBe(hookLog(theirs));
    expect(hookLog(mine)).toBe("");
  });

  it("above gc.auto: the hook runs first; its refusal leaves everything as it is", async () => {
    const [theirs, mine] = hookTwins(root, base(2));
    for (const t of [theirs, mine]) hookExit(t, "pre-auto-gc", 1);
    const native = gcAuto(theirs);
    const result = await (await oursAuto(mine)).gc().setAuto(true).call();
    expect(native.status).toBe(0);
    expect(result.autoSkipped).toBe("hook");
    expect(hookLog(mine)).toBe(hookLog(theirs));
    expect(hookLog(mine)).toContain("== pre-auto-gc");
    expect(seventeen(mine)).toEqual(seventeen(theirs));
    expect(seventeen(mine)).toHaveLength(2);
  });

  it("above gc.auto, the hook agreeing: housekeeping runs, git's message", async () => {
    const [theirs, mine] = hookTwins(root, base(2));
    const native = gcAuto(theirs);
    const result = await (await oursAuto(mine)).gc().setAuto(true).call();
    expect(native.status).toBe(0);
    expect(result.autoSkipped).toBeUndefined();
    expect(hookLog(mine)).toBe(hookLog(theirs));
    expect(native.stderr).toContain(result.messages?.join("\n") ?? "<none>");
  });

  it("gc.auto=0: auto gc off, no hook", async () => {
    const dir = base(2);
    git(dir, ["config", "gc.auto", "0"]);
    const [theirs, mine] = hookTwins(root, dir);
    gcAuto(theirs);
    const result = await (await oursAuto(mine)).gc().setAuto(true).call();
    expect(result.autoSkipped).toBe("not-needed");
    expect(hookLog(mine)).toBe(hookLog(theirs));
    expect(hookLog(mine)).toBe("");
  });
});

/**
 * `gc --auto` packs refs with `pack-refs --all --prune`, which 2.5x runs with `--auto`
 * (should_pack_refs: at least 16 loose refs while packed-refs is small); 2.43 always packs.
 */
describeGit("gc --auto: pack-refs --auto in 2.5x (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-auto-gc-refs-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const refState = (dir: string) =>
    [
      spawnSync("find", [".git/refs", "-type", "f"], { cwd: dir })
        .stdout.toString()
        .split("\n")
        .sort()
        .join("\n"),
      existsSync(join(dir, ".git/packed-refs"))
        ? readFileSync(join(dir, ".git/packed-refs"), "latin1")
        : "<none>",
    ].join("\n");

  for (const branches of [3, 20]) {
    it(`${branches} loose branches: the refs packed as native git packs them`, async () => {
      const dir = base(2);
      for (let i = 1; i <= branches; i++) git(dir, ["branch", `b${i}`]);
      installHooks(join(dir, ".git/hooks"), ["reference-transaction"]);
      const [theirs, mine] = hookTwins(root, dir);
      const native = gcAuto(theirs);
      const result = await (await oursAuto(mine)).gc().setAuto(true).call();
      expect(native.status).toBe(0);
      expect(result.autoSkipped).toBeUndefined();
      expect(hookLog(mine)).toBe(hookLog(theirs));
      expect(refState(mine.dir)).toBe(refState(theirs.dir));
    });
  }
});
