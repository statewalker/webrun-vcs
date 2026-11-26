/**
 * Pseudo-merge bitmaps (`bitmapPseudoMerge.*`) against native git, t5333-pseudo-merge-bitmaps's
 * scenarios. git 2.46+ only (2.43 has no pseudo-merges: skipped there). 2.46 to 2.54 write the
 * pseudo-merge commit table sorted by object id with extended offsets 4 bytes per commit too
 * early and keep the bitmap entries newest first; 2.55+ sorts the table by bit position and
 * the entries oldest first: the version on PATH picks the layout compared.
 *
 *  - our `.bitmap` of git's pack is git's, byte for byte, for each configuration;
 *  - git's pseudo-merges read by ours: the counts `rev-list --use-bitmap-index` gives, the
 *    pseudo-merges applied as git's trace2 `pseudo_merges_satisfied` counts them;
 *  - ours read by git: our repack's bitmap gives native git the same counts, its
 *    pseudo-merges satisfied, and our multi-pack-index bitmap is git's;
 *  - out-of-order thresholds die with git's message.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bitmapWalk, type PackFile, writePackBitmap } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import {
  createGitFilesBackend,
  listReachableObjects,
  multiPackIndexWrite,
  PseudoMergeConfigError,
  pseudoMergeInput,
  readBitmapSettings,
  repack,
} from "../src/index.js";

const GIT_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
  GIT_TEST_MULTI_PACK_INDEX_WRITE_BITMAP: "0",
};
const git = (cwd: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  execFileSync("git", args, {
    cwd,
    env: { ...GIT_ENV, ...env },
    maxBuffer: 1 << 28,
    stdio: ["pipe", "pipe", "pipe"],
    ...(input !== undefined ? { input } : {}),
  }).toString();

const version = execFileSync("git", ["--version"], { encoding: "utf8" });
const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
const hasPseudoMerges = major > 2 || minor >= 46;
/** 2.55 sorts the entries oldest first and rewrote the pseudo-merge table. */
const modern = major > 2 || minor >= 55;
const compatibility: "2.43" | "2.56" = modern ? "2.56" : "2.43";
const layout = modern ? "2.55" : "2.46";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

let clock = 1_600_000_000;
/**
 * `test_commit_bulk`-like commits through fast-import on main, each with a date of its own
 * (from `date` on, else the running clock): t5333 gives a bulk one date (`--notick`), but git
 * orders commits of one date by its C library's qsort, so the twins keep dates distinct.
 */
function bulk(dir: string, n: number, options: { message?: string; date?: number } = {}) {
  const lines: string[] = [];
  const hasHead = spawnSync("git", ["rev-parse", "-q", "--verify", "HEAD"], {
    cwd: dir,
    env: GIT_ENV,
  });
  const parent = hasHead.status === 0 ? hasHead.stdout.toString().trim() : undefined;
  for (let i = 0; i < n; i++) {
    const date = options.date === undefined ? clock++ : options.date + i;
    lines.push("commit refs/heads/main", `mark :${i + 1}`);
    lines.push(`author A <a@b> ${date} +0000`, `committer C <c@d> ${date} +0000`);
    const msg = `${options.message ?? "commit"} ${i}`;
    lines.push(`data ${msg.length}`, msg);
    if (i > 0) lines.push(`from :${i}`);
    else if (parent) lines.push(`from ${parent}`);
    const content = `${msg}\n`;
    lines.push(
      `M 100644 inline ${options.message ?? "f"}-${i}.t`,
      `data ${content.length}`,
      content,
    );
  }
  lines.push("");
  git(dir, ["fast-import", "--quiet"], {}, lines.join("\n"));
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
}
function init(prefix: string): string {
  const dir = tmp(prefix);
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  return dir;
}
/** t5333's tag_everything: a lightweight tag `refs/tags/<id>` per commit. */
function tagEverything(dir: string) {
  const ids = git(dir, ["rev-list", "--all", "--no-object-names"]).split("\n").filter(Boolean);
  git(
    dir,
    ["update-ref", "--stdin"],
    {},
    ids.map((id) => `create refs/tags/${id} ${id}\n`).join(""),
  );
}
const configArgs = (config: Record<string, string>) =>
  Object.entries(config).flatMap(([k, v]) => ["-c", `${k}=${v}`]);
const packDir = (dir: string) => join(dir, ".git", "objects", "pack");
const bitmapFile = (dir: string, prefix = "pack-") =>
  readdirSync(packDir(dir)).find((f) => f.startsWith(prefix) && f.endsWith(".bitmap"));

async function open(dir: string) {
  const files = createNodeFilesApi({ rootDir: dir });
  const backend = await createGitFilesBackend({ files, gitDir: ".git" });
  await backend.packs.refresh();
  return { files, backend };
}

/** Writes `config` into the repository (as t5333's test_config) and repacks natively. */
function nativeRepack(dir: string, config: Record<string, string>) {
  for (const [k, v] of Object.entries(config)) git(dir, ["config", k, v]);
  git(dir, ["repack", "-adbq"]);
}

/** Our bitmap of git's pack, with the pseudo-merges the repository's config asks for. */
async function oursOfNativePack(dir: string): Promise<Uint8Array> {
  const { files, backend } = await open(dir);
  const [pack] = await backend.packs.packs();
  const settings = await readBitmapSettings(files, ".git");
  const listed = await listReachableObjects({
    files,
    gitDir: ".git",
    refs: backend.history.refs,
    objects: backend.objects,
  });
  const pseudoMerges = await pseudoMergeInput(
    settings,
    backend.history.refs,
    backend.objects,
    "2.56",
  );
  return writePackBitmap({
    pack: pack as PackFile,
    objects: backend.objects,
    listed,
    hashCache: settings.hashCache,
    lookupTable: settings.lookupTable,
    compatibility,
    ...(pseudoMerges ? { pseudoMerges: { ...pseudoMerges, layout } } : {}),
  });
}

async function expectSameBitmap(dir: string) {
  const native = readFileSync(join(packDir(dir), bitmapFile(dir) as string));
  const ours = await oursOfNativePack(dir);
  expect(Buffer.from(ours).toString("hex")).toBe(native.toString("hex"));
  return native;
}

/** The pseudo-merges a native `rev-list --use-bitmap-index` applies (trace2). */
function nativeSatisfied(dir: string, args: string[]): { count: number; satisfied: number } {
  const trace = join(tmp("trace-"), "trace2.json");
  const count = Number(
    git(dir, ["rev-list", "--count", ...args, "--use-bitmap-index"], { GIT_TRACE2_EVENT: trace }),
  );
  let satisfied = 0;
  for (const line of readFileSync(trace, "utf8").split("\n")) {
    if (!line.includes('"pseudo_merges_satisfied"')) continue;
    satisfied = Number(JSON.parse(line).value);
  }
  return { count, satisfied };
}

const allRefs = (dir: string) =>
  git(dir, ["for-each-ref", "--format=%(objectname)"]).split("\n").filter(Boolean);

describe.skipIf(!hasPseudoMerges)("pseudo-merge bitmaps (t5333)", () => {
  // the 512-commit history every scenario of t5333's first part shares
  let shared: string | undefined;
  const sharedRepo = () => {
    if (!shared) {
      shared = init("pm-shared-");
      bulk(shared, 512);
      tagEverything(shared);
    }
    return shared;
  };

  it('t5333-pseudo-merge-bitmaps.sh: "bitmap traversal without pseudo-merges"', async () => {
    const dir = sharedRepo();
    git(dir, ["repack", "-adbq"]);
    await expectSameBitmap(dir);
    const { backend } = await open(dir);
    const index = await backend.packs.bitmap?.();
    expect(index?.pseudoMerges.length).toBe(0);
  });

  it('t5333-pseudo-merge-bitmaps.sh: "pseudo-merges accurately represent their objects"', async () => {
    const dir = sharedRepo();
    nativeRepack(dir, {
      "bitmapPseudoMerge.test.pattern": "refs/tags/",
      "bitmapPseudoMerge.test.maxMerges": "8",
      "bitmapPseudoMerge.test.stableThreshold": "never",
    });
    await expectSameBitmap(dir);
    const { backend } = await open(dir);
    const index = await backend.packs.bitmap?.();
    expect(index?.pseudoMerges.length).toBe(8);
    // each pseudo-merge's bitmap is what its commits reach
    for (const m of index?.pseudoMerges ?? []) {
      const commits = [...m.commits.bits()].map((p) => index?.idAt(p) as string);
      const expected = git(
        dir,
        ["rev-list", "--objects", "--no-object-names", "--stdin"],
        {},
        `${commits.join("\n")}\n`,
      )
        .split("\n")
        .filter(Boolean)
        .sort();
      const actual = [...m.bitmap.bits()].map((p) => index?.idAt(p) as string).sort();
      expect(actual).toEqual(expected);
    }
  });

  it('t5333-pseudo-merge-bitmaps.sh: "bitmap traversal with pseudo-merges"', async () => {
    const dir = sharedRepo();
    const native = nativeSatisfied(dir, ["--all", "--objects"]);
    const { backend } = await open(dir);
    const index = await backend.packs.bitmap?.();
    if (!index) throw new Error("no bitmap");
    const result = await bitmapWalk(index, backend.objects, { wants: allRefs(dir) });
    expect(result.count).toBe(Number(git(dir, ["rev-list", "--count", "--all", "--objects"])));
    expect(result.count).toBe(native.count);
    expect(result.pseudoMergesSatisfied).toBe(native.satisfied);
    expect(result.pseudoMergesSatisfied).toBe(8);
  });

  it('t5333-pseudo-merge-bitmaps.sh: "stale bitmap traversal with pseudo-merges"', async () => {
    const dir = init("pm-stale-");
    cpSync(join(sharedRepo(), ".git"), join(dir, ".git"), { recursive: true });
    bulk(dir, 1, { message: "other" });
    const native = nativeSatisfied(dir, ["--all", "--objects"]);
    const { backend } = await open(dir);
    const index = await backend.packs.bitmap?.();
    if (!index) throw new Error("no bitmap");
    const result = await bitmapWalk(index, backend.objects, { wants: allRefs(dir) });
    expect(result.count).toBe(native.count);
    expect(result.pseudoMergesSatisfied).toBe(native.satisfied);
  });

  it('t5333-pseudo-merge-bitmaps.sh: "bitmapPseudoMerge.sampleRate adjusts commit selection rate"', async () => {
    const dir = init("pm-rate-");
    cpSync(join(sharedRepo(), ".git"), join(dir, ".git"), { recursive: true });
    for (const rate of ["1.0", "0.5", "0.25"]) {
      nativeRepack(dir, {
        "bitmapPseudoMerge.test.pattern": "refs/tags/",
        "bitmapPseudoMerge.test.maxMerges": "1",
        "bitmapPseudoMerge.test.stableThreshold": "never",
        "bitmapPseudoMerge.test.sampleRate": rate,
      });
      await expectSameBitmap(dir);
    }
  });

  it('t5333-pseudo-merge-bitmaps.sh: "bitmapPseudoMerge.threshold excludes newer commits"', async () => {
    const dir = init("pm-threshold-");
    const newDate = 1672549200;
    const oldDate = 1641013200;
    bulk(dir, 128, { message: "new", date: newDate });
    bulk(dir, 128, { message: "old", date: oldDate });
    tagEverything(dir);
    nativeRepack(dir, {
      "bitmapPseudoMerge.test.pattern": "refs/tags/",
      "bitmapPseudoMerge.test.maxMerges": "1",
      "bitmapPseudoMerge.test.threshold": String(newDate - 1),
      "bitmapPseudoMerge.test.stableThreshold": "never",
    });
    await expectSameBitmap(dir);

    // 'bitmapPseudoMerge.stableThreshold creates stable groups'
    const midDate = 1654059600;
    bulk(dir, 128, { message: "mid", date: midDate });
    const tags = git(dir, ["for-each-ref", "--format=delete %(refname)", "refs/tags"]);
    git(dir, ["update-ref", "--stdin"], {}, tags);
    tagEverything(dir);
    nativeRepack(dir, {
      "bitmapPseudoMerge.test.stableThreshold": String(midDate - 1),
      "bitmapPseudoMerge.test.stableSize": "10",
    });
    await expectSameBitmap(dir);
  });

  it('t5333-pseudo-merge-bitmaps.sh: "out of order thresholds are rejected"', async () => {
    const dir = init("pm-order-");
    bulk(dir, 3);
    const config = {
      "bitmapPseudoMerge.test.pattern": "refs/*",
      "bitmapPseudoMerge.test.threshold": "1.month.ago",
      "bitmapPseudoMerge.test.stableThreshold": "1.week.ago",
    };
    const native = spawnSync("git", [...configArgs(config), "repack", "-adb"], {
      cwd: dir,
      env: { ...GIT_ENV, GIT_TEST_NAME_HASH_VERSION: "1" },
      encoding: "utf8",
    });
    expect(native.status).toBe(128);
    for (const [k, v] of Object.entries(config)) git(dir, ["config", k, v]);
    const packsBefore = readdirSync(packDir(dir)).sort();
    const { backend } = await open(dir);
    const error = await repack({ ...backend, writeBitmaps: true }).catch((e) => e);
    expect(error).toBeInstanceOf(PseudoMergeConfigError);
    // as git (pack-objects dies before the pack is renamed), no new pack is left behind
    expect(readdirSync(packDir(dir)).sort()).toEqual(packsBefore);
    expect(`fatal: ${(error as Error).message}\n`).toBe(native.stderr);
  });

  it('t5333-pseudo-merge-bitmaps.sh: "pseudo-merge pattern with capture groups"', async () => {
    const dir = init("pm-captures-");
    bulk(dir, 128);
    tagEverything(dir);
    for (let r = 1; r <= 8; r++) {
      bulk(dir, 16);
      const ids = git(dir, ["rev-list", "HEAD~16.."]).split("\n").filter(Boolean);
      git(
        dir,
        ["update-ref", "--stdin"],
        {},
        ids.map((id) => `create refs/remotes/${r}/tags/${id} ${id}\n`).join(""),
      );
    }
    nativeRepack(dir, {
      "bitmapPseudoMerge.tags.pattern": "refs/remotes/([0-9]+)/tags/",
      "bitmapPseudoMerge.tags.maxMerges": "1",
    });
    await expectSameBitmap(dir);
  });

  it('t5333-pseudo-merge-bitmaps.sh: "pseudo-merge overlap setup"', async () => {
    const dir = init("pm-overlap-");
    bulk(dir, 256);
    tagEverything(dir);
    nativeRepack(dir, {
      "bitmapPseudoMerge.all.pattern": "refs/",
      "bitmapPseudoMerge.all.maxMerges": "1",
      "bitmapPseudoMerge.all.stableThreshold": "never",
      "bitmapPseudoMerge.tags.pattern": "refs/tags/",
      "bitmapPseudoMerge.tags.maxMerges": "1",
      "bitmapPseudoMerge.tags.stableThreshold": "never",
    });
    await expectSameBitmap(dir);

    // "pseudo-merge overlap traversal"
    const native = nativeSatisfied(dir, ["--all", "--objects"]);
    const { backend } = await open(dir);
    const index = await backend.packs.bitmap?.();
    if (!index) throw new Error("no bitmap");
    expect(index.pseudoMerges.length).toBe(2);
    const result = await bitmapWalk(index, backend.objects, { wants: allRefs(dir) });
    expect(result.count).toBe(native.count);
    expect(result.pseudoMergesSatisfied).toBe(native.satisfied);
  });

  it('t5333-pseudo-merge-bitmaps.sh: "empty pseudo-merge group"', async () => {
    const dir = init("pm-empty-");
    bulk(dir, 1, { date: 1112912053 });
    nativeRepack(dir, { "bitmapPseudoMerge.empty.pattern": "refs/" });
    const native = await expectSameBitmap(dir);
    const { backend } = await open(dir);
    expect((await backend.packs.bitmap?.())?.pseudoMerges.length).toBe(1);
    expect(native.length).toBeGreaterThan(0);
  });

  it('t5333-pseudo-merge-bitmaps.sh: "pseudo-merge closure"', async () => {
    const dir = init("pm-closure-");
    bulk(dir, 1, { message: "A" });
    git(dir, ["repack", "-dq"]);
    bulk(dir, 1, { message: "B" });
    git(dir, ["config", "bitmapPseudoMerge.test.pattern", "refs/"]);
    git(dir, ["config", "bitmapPseudoMerge.test.threshold", "now"]);
    const twin = init("pm-closure-twin-");
    cpSync(join(dir, ".git"), join(twin, ".git"), { recursive: true });
    git(dir, ["multi-pack-index", "write", "--bitmap"]);
    const nativeName = bitmapFile(dir, "multi-pack-index-") as string;
    const { files } = await open(twin);
    // one entry: the order of entries does not matter, and "2.43" would write no pseudo-merges
    await multiPackIndexWrite({ files, gitDir: ".git", bitmap: true, compatibility: "2.56" });
    const oursName = bitmapFile(twin, "multi-pack-index-") as string;
    expect(oursName).toBe(nativeName);
    // ours, as git's, has a pseudo-merge of A alone
    const ours = readFileSync(join(packDir(twin), oursName));
    const native = readFileSync(join(packDir(dir), nativeName));
    expect(ours.toString("hex")).toBe(native.toString("hex"));
  });

  it("our repack's pseudo-merges read by native git", async () => {
    const dir = init("pm-ours-");
    cpSync(join(sharedRepo(), ".git"), join(dir, ".git"), { recursive: true });
    for (const [k, v] of Object.entries({
      "bitmapPseudoMerge.test.pattern": "refs/tags/",
      "bitmapPseudoMerge.test.maxMerges": "8",
      "bitmapPseudoMerge.test.stableThreshold": "never",
    }))
      git(dir, ["config", k, v]);
    const { backend } = await open(dir);
    await repack({ ...backend, writeBitmaps: true });
    const after = await open(dir);
    expect((await after.backend.packs.bitmap?.())?.pseudoMerges.length).toBe(8);
    const native = nativeSatisfied(dir, ["--all", "--objects"]);
    expect(native.count).toBe(Number(git(dir, ["rev-list", "--count", "--all", "--objects"])));
    expect(native.satisfied).toBe(8);
    git(dir, ["rev-list", "--test-bitmap", "HEAD"]);
  });
});
