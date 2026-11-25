/**
 * Packs not named `pack-<id>` (statewalker/webrun-vcs#363). git reads every `*.idx` of
 * `objects/pack` (`prepare_packed_git_one`), so a pack written as
 * `git pack-objects objects/pack/custom` (`custom-<id>.pack`, as t4301-merge-tree-write-tree.sh
 * writes `side3-tree-is-missing-<id>`) holds objects native git reads. Each scenario builds a
 * repository whose objects live only in such a pack, copies it (`cp -a`), and compares ours
 * with native git: reads (`cat-file`, `merge-tree`), gc and repack (which take the pack as any
 * other: repacked, then removed, or left alone with a `.keep`), and a multi-pack-index naming
 * it (git writes the pack's own `.idx` name in PNAM).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  copyTwin,
  fsck,
  gcEnv,
  initRepo,
  type NativeRepo,
  nativeGc,
  newCase,
  openOursGc,
} from "./gc-native-twins-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "custom-pack-name-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Native git in `cwd`: its stdout, stderr and exit status. */
function git(home: string, cwd: string, args: string[], input?: string) {
  const r = spawnSync("git", args, {
    cwd,
    env: gcEnv(home),
    ...(input !== undefined ? { input } : {}),
  });
  return {
    stdout: r.stdout.toString("latin1"),
    stderr: r.stderr.toString("latin1"),
    status: r.status,
  };
}

/** The names in `objects/pack`, sorted. */
function packFiles(repo: string): string[] {
  const dir = join(repo, ".git", "objects", "pack");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/**
 * Two diverging branches (t4301's side1/side2 shape), every object moved into packs named
 * `<prefix>-<id>`, no loose object left. Returns the repository and every object id.
 */
function customPackedRepo(caseDir: string, home: string, prefixes: string[] = ["custom"]) {
  const repo = initRepo(home, caseDir);
  repo.commit("base", { "a.txt": "a\n", "dir/b.txt": "b\n" });
  repo.git(["branch", "side1"]);
  repo.git(["checkout", "-q", "-b", "side2"]);
  repo.commit("side2", { "c.txt": "c\n", "dir/b.txt": "b2\n" });
  repo.git(["checkout", "-q", "side1"]);
  repo.commit("side1", { "a.txt": "a1\n", "d.txt": "d\n" });
  const all = repo.git(["rev-list", "--objects", "--all"]);
  const ids = all.split("\n").map((l) => l.split(" ")[0] as string);
  // one pack per prefix, each holding a share of the objects
  prefixes.forEach((prefix, i) => {
    const share = ids.filter((_, n) => n % prefixes.length === i);
    repo.git(["pack-objects", "-q", `.git/objects/pack/${prefix}`], {
      input: `${share.join("\n")}\n`,
    });
  });
  repo.git(["prune-packed"]);
  return { repo, ids };
}

/** Our `cat-file --batch-check` of `ids` and native git's, in the two twins. */
async function catFileBoth(caseDir: string, home: string, ids: string[]) {
  const input = `${ids.join("\n")}\n`;
  const native = git(home, join(caseDir, "native", "repo"), ["cat-file", "--batch-check"], input);
  const ours = await (await openOursGc(home, join(caseDir, "ours")))
    .catFile()
    .setBatch("check")
    .setStdin(input)
    .callOutput();
  return { native, ours };
}

describeGit("packs not named pack-<id> against native git (#363)", () => {
  let home: string;
  beforeAll(() => {
    home = join(root, "home");
  });

  it("reads a pack written as `git pack-objects objects/pack/custom` (cat-file --batch-check)", async () => {
    const caseDir = newCase(root, "cat-file");
    const { repo, ids } = customPackedRepo(caseDir, home);
    expect(packFiles(repo.dir).some((n) => n.startsWith("custom-"))).toBe(true);
    copyTwin(caseDir, "native");
    copyTwin(caseDir, "ours");
    const { native, ours } = await catFileBoth(caseDir, home, ids);
    expect(native.stdout).not.toContain("missing");
    expect(new TextDecoder().decode(ours.stdout)).toBe(native.stdout);
  });

  it("t4301-merge-tree-write-tree.sh: merge-tree over commits in a custom-named pack", async () => {
    const caseDir = newCase(root, "merge-tree");
    customPackedRepo(caseDir, home, ["side3-tree-is-missing", "side1-whatever-is-missing"]);
    copyTwin(caseDir, "native");
    copyTwin(caseDir, "ours");
    const native = git(home, join(caseDir, "native", "repo"), [
      "merge-tree",
      "--write-tree",
      "side1",
      "side2",
    ]);
    const ours = await (await openOursGc(home, join(caseDir, "ours")))
      .mergeTree()
      .setBranches("side1", "side2")
      .callOutput();
    expect(native.status).toBe(0);
    expect(ours.exitCode).toBe(native.status);
    expect(new TextDecoder().decode(ours.stdout)).toBe(native.stdout);
  });

  it("gc repacks a custom-named pack and removes it afterwards, as git's gc", async () => {
    const caseDir = newCase(root, "gc");
    const { ids } = customPackedRepo(caseDir, home);
    const nativeDir = join(copyTwin(caseDir, "native"), "repo");
    const oursDir = join(copyTwin(caseDir, "ours"), "repo");
    const n = nativeGc(home, nativeDir, ["-q", "--prune=now"]);
    expect(n.status).toBe(0);
    await (await openOursGc(home, join(caseDir, "ours")))
      .gc()
      .setQuiet(true)
      .setPrune("now")
      .call();
    const kinds = (repo: string) =>
      packFiles(repo).map((name) => name.replace(/^pack-[0-9a-f]{40}\./, "pack-<id>."));
    expect(kinds(oursDir)).toEqual(kinds(nativeDir));
    expect(packFiles(oursDir).some((n) => n.startsWith("custom-"))).toBe(false);
    expect(fsck(home, oursDir).status).toBe(0);
    const check = git(home, oursDir, ["cat-file", "--batch-check"], `${ids.join("\n")}\n`);
    expect(check.stdout).not.toContain("missing");
  });

  it("gc leaves a kept custom-named pack (`custom-<id>.keep`) alone, as git's gc", async () => {
    const caseDir = newCase(root, "gc-keep");
    const { repo, ids } = customPackedRepo(caseDir, home);
    for (const name of packFiles(repo.dir))
      if (name.endsWith(".pack"))
        writeFileSync(join(repo.gitDir, "objects", "pack", name.replace(/\.pack$/, ".keep")), "");
    const nativeDir = join(copyTwin(caseDir, "native"), "repo");
    const oursDir = join(copyTwin(caseDir, "ours"), "repo");
    expect(nativeGc(home, nativeDir, ["-q", "--prune=now"]).status).toBe(0);
    await (await openOursGc(home, join(caseDir, "ours")))
      .gc()
      .setQuiet(true)
      .setPrune("now")
      .call();
    const custom = (r: string) => packFiles(r).filter((n) => n.startsWith("custom-"));
    expect(custom(nativeDir).length).toBeGreaterThan(0);
    expect(custom(oursDir)).toEqual(custom(nativeDir));
    expect(fsck(home, oursDir).status).toBe(0);
    const check = git(home, oursDir, ["cat-file", "--batch-check"], `${ids.join("\n")}\n`);
    expect(check.stdout).not.toContain("missing");
  });

  it("gc removes `pack-<id>` but keeps a kept `custom-<id>` of the same id, as git's gc", async () => {
    const caseDir = newCase(root, "gc-same-id");
    const { repo, ids } = customPackedRepo(caseDir, home);
    const packDir = join(repo.gitDir, "objects", "pack");
    for (const name of packFiles(repo.dir)) {
      const copy = name.replace(/^custom-/, "pack-");
      cpSync(join(packDir, name), join(packDir, copy));
      if (name.endsWith(".pack"))
        writeFileSync(join(packDir, name.replace(/\.pack$/, ".keep")), "");
    }
    const nativeDir = join(copyTwin(caseDir, "native"), "repo");
    const oursDir = join(copyTwin(caseDir, "ours"), "repo");
    expect(nativeGc(home, nativeDir, ["-q", "--prune=now"]).status).toBe(0);
    await (await openOursGc(home, join(caseDir, "ours")))
      .gc()
      .setQuiet(true)
      .setPrune("now")
      .call();
    const custom = (r: string) => packFiles(r).filter((n) => n.startsWith("custom-"));
    expect(custom(nativeDir).filter((n) => n.endsWith(".keep")).length).toBe(1);
    expect(custom(oursDir)).toEqual(custom(nativeDir));
    expect(fsck(home, oursDir).status).toBe(0);
    const check = git(home, oursDir, ["cat-file", "--batch-check"], `${ids.join("\n")}\n`);
    expect(check.stdout).not.toContain("missing");
  });

  it("reads through a multi-pack-index naming custom-named packs", async () => {
    const caseDir = newCase(root, "midx");
    const { repo, ids } = customPackedRepo(caseDir, home, ["alpha", "beta", "gamma"]);
    repo.git(["multi-pack-index", "write"]);
    copyTwin(caseDir, "native");
    copyTwin(caseDir, "ours");
    const { native, ours } = await catFileBoth(caseDir, home, ids);
    expect(native.stdout).not.toContain("missing");
    expect(new TextDecoder().decode(ours.stdout)).toBe(native.stdout);
    expect(ours.stderr).toBe("");
    // the midx stays valid for native git after ours read through it
    expect(git(home, join(caseDir, "ours", "repo"), ["multi-pack-index", "verify"]).status).toBe(0);
  });
});

export type { NativeRepo };
