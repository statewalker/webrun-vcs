/**
 * `GIT_REF_PARANOIA` twins (t5312-prune-corruption.sh): with git's default (paranoia on, since
 * git 2.36) a ref with a bad name or naming a missing object makes prune and repack die
 * before deleting anything; `GIT_REF_PARANOIA=0` skips such refs as git's ref iterator does.
 * Each case runs native git on one copy of a repository and ours on another, and compares the
 * exit status, git's fatal or error line and which objects are left.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Git } from "../src/index.js";
import {
  copyTwin,
  gcEnv,
  initRepo,
  type NativeRepo,
  newCase,
  openOursGc,
} from "./gc-native-twins-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;

interface Outcome {
  status: number;
  /** git's `fatal:`/`error:` lines */
  lines: string[];
}

/** git's diagnostic lines of a stderr (progress and hints left out). */
const diagnostics = (text: string) => text.split("\n").filter((l) => /^(fatal|error):/.test(l));

/** Our outcome of a command that may throw git's death. */
async function oursOutcome(run: () => Promise<{ status: number; stderr: string }>) {
  try {
    const r = await run();
    return { status: r.status, lines: diagnostics(r.stderr) };
  } catch (e) {
    const message = (e as Error).message;
    const line = /^(fatal|error):/.test(message) ? message : `fatal: ${message}`;
    return { status: 128, lines: diagnostics(line) };
  }
}

/** Whether an object is in a repository (native `cat-file -e`). */
function hasObject(repo: string, id: string): boolean {
  return spawnSync("git", ["cat-file", "-e", id], { cwd: repo, env: gcEnv(root) }).status === 0;
}

/**
 * Runs `git <args>` in a native copy of `<caseDir>/src/repo` and `ours` in another, both with
 * `env`; returns the outcomes and the copies' repositories.
 */
async function twins(
  caseDir: string,
  label: string,
  args: string[],
  ours: (git: Git) => Promise<{ status: number; stderr: string }>,
  env: Record<string, string> = {},
): Promise<{ native: Outcome; ours: Outcome; repos: { native: string; ours: string } }> {
  const nativeDir = copyTwin(caseDir, `native-${label}`);
  const oursDir = copyTwin(caseDir, `ours-${label}`);
  const r = spawnSync("git", args, { cwd: join(nativeDir, "repo"), env: gcEnv(root, env) });
  const git = await openOursGc(root, oursDir, "repo", env);
  return {
    native: { status: r.status ?? -1, lines: diagnostics(r.stderr.toString()) },
    ours: await oursOutcome(() => ours(git)),
    repos: { native: join(nativeDir, "repo"), ours: join(oursDir, "repo") },
  };
}

const prune = (git: Git) =>
  git
    .prune()
    .setExpire("now")
    .callOutput()
    .then((o) => ({ status: o.exitCode, stderr: o.stderr }));

const repack =
  (configure: (c: ReturnType<Git["repack"]>) => ReturnType<Git["repack"]>) => (git: Git) =>
    configure(git.repack().setQuiet(true))
      .call()
      .then((r) => ({ status: 0, stderr: r.warnings.join("\n") }));

/**
 * t5312's first history: `main` and a commit `bogus` reachable only from a ref named
 * `refs/heads/bogus..name` (test-tool's REF_SKIP_REFNAME_VERIFICATION: written by hand here),
 * reflogs off.
 */
function bogusRefCase(name: string, packed: boolean): { caseDir: string; bogus: string } {
  const caseDir = newCase(root, name);
  const r: NativeRepo = initRepo(root, caseDir);
  r.git(["config", "core.logallrefupdates", "false"]);
  r.commit("main");
  r.commit("bogus");
  const bogus = r.git(["rev-parse", "HEAD"]);
  r.git(["reset", "-q", "--hard", "HEAD^"]);
  if (packed) {
    // 'put bogus object into pack'
    r.git(["tag", "reachable", bogus]);
    r.git(["repack", "-adq"]);
    r.git(["tag", "-d", "reachable"]);
  }
  r.git(["reflog", "expire", "--expire=all", "--all"]);
  writeFileSync(join(r.dir, ".git/refs/heads/bogus..name"), `${bogus}\n`);
  return { caseDir, bogus };
}

/** t5312's second history: `main` at a commit whose object is gone, HEAD detached at its base. */
function missingTipCase(name: string): { caseDir: string; recoverable: string } {
  const caseDir = newCase(root, name);
  const r = initRepo(root, caseDir);
  r.git(["config", "core.logallrefupdates", "false"]);
  r.commit("base");
  const base = r.git(["rev-parse", "HEAD"]);
  r.commit("one");
  const recoverable = r.git(["rev-parse", "HEAD"]);
  r.commit("two");
  const missing = r.git(["rev-parse", "HEAD"]);
  r.git(["checkout", "-q", "--detach", base]);
  r.git(["reflog", "expire", "--expire=all", "--all"]);
  unlinkSync(join(r.dir, ".git/objects", missing.slice(0, 2), missing.slice(2)));
  return { caseDir, recoverable };
}

describeGit("GIT_REF_PARANOIA twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ref-paranoia-twins-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t5312-prune-corruption.sh: "pruning does not drop bogus object"', async () => {
    const { caseDir, bogus } = bogusRefCase("prune-bogus", false);
    const t = await twins(caseDir, "prune", ["prune", "--expire=now"], prune);
    expect(t.native.status).toBe(128);
    expect(t.ours).toEqual(t.native);
    expect(hasObject(t.repos.ours, bogus)).toBe(true);
    expect(hasObject(t.repos.native, bogus)).toBe(true);
  });

  it('t5312-prune-corruption.sh: "non-destructive repack bails on bogus ref"', async () => {
    const { caseDir } = bogusRefCase("repack-k-bogus", true);
    const t = await twins(
      caseDir,
      "repack",
      ["repack", "-adkq"],
      repack((c) => c.setAll(true).setDeleteRedundant(true).setKeepUnreachable(true)),
    );
    expect(t.native.status).toBe(128);
    expect(t.ours).toEqual(t.native);
  });

  it('t5312-prune-corruption.sh: "GIT_REF_PARANOIA=0 overrides safety"', async () => {
    const { caseDir, bogus } = bogusRefCase("repack-k-paranoia0", true);
    const t = await twins(
      caseDir,
      "repack",
      ["repack", "-adkq"],
      repack((c) => c.setAll(true).setDeleteRedundant(true).setKeepUnreachable(true)),
      { GIT_REF_PARANOIA: "0" },
    );
    expect(t.native.status).toBe(0);
    expect(t.ours).toEqual(t.native);
    // -k keeps the unreachable object either way
    expect(hasObject(t.repos.ours, bogus)).toBe(hasObject(t.repos.native, bogus));
  });

  it('t5312-prune-corruption.sh: "destructive repack keeps packed object"', async () => {
    const { caseDir, bogus } = bogusRefCase("repack-ad-bogus", true);
    const t = await twins(
      caseDir,
      "repack-ad",
      ["repack", "-adq"],
      repack((c) => c.setAll(true).setDeleteRedundant(true)),
    );
    expect(t.native.status).toBe(128);
    expect(t.ours).toEqual(t.native);
    expect(hasObject(t.repos.ours, bogus)).toBe(true);
    const unpack = await twins(
      caseDir,
      "repack-A",
      ["repack", "-Adq", "--unpack-unreachable=now"],
      repack((c) =>
        c.setLoosenUnreachable(true).setDeleteRedundant(true).setUnpackUnreachable("now"),
      ),
    );
    expect(unpack.native.status).toBe(128);
    expect(unpack.ours).toEqual(unpack.native);
    expect(hasObject(unpack.repos.ours, bogus)).toBe(true);
  });

  it("GIT_REF_PARANOIA=0 prune drops what only a bogus-named ref reaches", async () => {
    const { caseDir, bogus } = bogusRefCase("prune-bogus-paranoia0", false);
    const t = await twins(caseDir, "prune", ["prune", "--expire=now"], prune, {
      GIT_REF_PARANOIA: "0",
    });
    expect(t.native.status).toBe(0);
    expect(t.ours).toEqual(t.native);
    expect(hasObject(t.repos.native, bogus)).toBe(false);
    expect(hasObject(t.repos.ours, bogus)).toBe(false);
  });

  it('t5312-prune-corruption.sh: "destructive repack not confused by dangling symref"', async () => {
    const { caseDir } = bogusRefCase("dangling-symref", true);
    // the bogus ref is gone again (test_when_finished), a dangling symref added
    rmSync(join(caseDir, "src/repo/.git/refs/heads/bogus..name"));
    writeFileSync(
      join(caseDir, "src/repo/.git/refs/heads/dangling"),
      "ref: refs/heads/does-not-exist\n",
    );
    const t = await twins(
      caseDir,
      "repack",
      ["repack", "-adq"],
      repack((c) => c.setAll(true).setDeleteRedundant(true)),
    );
    expect(t.native.status).toBe(0);
    expect(t.ours).toEqual(t.native);
  });

  it('t5312-prune-corruption.sh: "pruning with a corrupted tip does not drop history"', async () => {
    const { caseDir, recoverable } = missingTipCase("missing-tip");
    const t = await twins(caseDir, "prune", ["prune", "--expire=now"], prune);
    expect(t.native.status).toBe(128);
    expect(t.ours).toEqual(t.native);
    expect(hasObject(t.repos.ours, recoverable)).toBe(true);
  });

  it("GIT_REF_PARANOIA=0 prune skips a ref naming a missing object, with git's error", async () => {
    const { caseDir, recoverable } = missingTipCase("missing-tip-paranoia0");
    const t = await twins(caseDir, "prune", ["prune", "--expire=now"], prune, {
      GIT_REF_PARANOIA: "0",
    });
    expect(t.native.status).toBe(0);
    expect(t.native.lines).toEqual(["error: refs/heads/main does not point to a valid object!"]);
    expect(t.ours).toEqual(t.native);
    expect(hasObject(t.repos.ours, recoverable)).toBe(hasObject(t.repos.native, recoverable));
    expect(existsSync(t.repos.ours)).toBe(true);
  });
});
