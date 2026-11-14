/**
 * repack and gc against native git: after ours, `git fsck --full --strict`, `git count-objects
 * -v` and `git verify-pack` accept the repository; a repository native git packed (a `.keep`
 * pack, several packs, loose objects) is repacked by us and stays valid; objects reachable only
 * from the index or a reflog survive; native `git gc` runs after ours.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend, gc, repack } from "../src/index.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, maxBuffer: 1 << 30 }).toString();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A repository with `n` commits on main editing a few files (deltas to find), a tag and a branch. */
function repo(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "repack-gc-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  git(dir, ["config", "gc.auto", "0"]);
  for (let c = 0; c < n; c++) commitFiles(dir, c);
  git(dir, ["tag", "-a", "-m", "release", "v1"]);
  git(dir, ["branch", "topic", "HEAD~1"]);
  return dir;
}

function commitFiles(dir: string, c: number) {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}: lorem ipsum dolor sit amet`);
  for (let f = 0; f < 3; f++) {
    for (let k = 0; k <= c; k++) lines[(k * 37 + f * 11) % lines.length] = `edited ${c}/${k} ${f}`;
    writeFileSync(join(dir, `file${f}.txt`), `${lines.join("\n")}\n`);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `commit ${c}`]);
}

const packDir = (dir: string) => join(dir, ".git/objects/pack");
const packsOf = (dir: string, ext: string) =>
  readdirSync(packDir(dir))
    .filter((f) => f.endsWith(ext))
    .sort();

function countObjects(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of git(dir, ["count-objects", "-v"]).split("\n")) {
    const [k, v] = line.split(": ");
    if (k && v) out[k] = Number(v);
  }
  return out;
}

/** fsck, count-objects and verify-pack all accept the repository. */
function expectValid(dir: string) {
  git(dir, ["fsck", "--full", "--strict", "--no-progress"]);
  const counts = countObjects(dir);
  expect(counts.garbage).toBe(0);
  for (const idx of packsOf(dir, ".idx")) git(dir, ["verify-pack", join(packDir(dir), idx)]);
  return counts;
}

const allObjects = (dir: string) =>
  git(dir, ["rev-list", "--objects", "--all", "--reflog", "--indexed-objects"])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(0, 40))
    .sort();

async function backend(dir: string) {
  return createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
}

describe("repack and gc against native git", () => {
  it("fsck, count-objects and verify-pack accept the repository after our repack and gc", async () => {
    const dir = repo(6);
    const objects = allObjects(dir);
    const b = await backend(dir);

    const r = await repack(b);
    expect(r?.objectCount).toBe(objects.length);
    let counts = expectValid(dir);
    expect(counts.count).toBe(0); // no loose objects left
    expect(counts.packs).toBe(1);
    expect(counts["in-pack"]).toBe(objects.length);
    // the pack has deltas: the search ran
    const verbose = git(dir, [
      "verify-pack",
      "-v",
      join(packDir(dir), packsOf(dir, ".idx")[0] ?? ""),
    ]);
    expect(verbose).toMatch(/chain length = 1:/);

    await gc({ history: b.history, files: b.files, pruneExpireMs: 0 });
    counts = expectValid(dir);
    expect(counts.packs).toBe(1);
    expect(allObjects(dir)).toEqual(objects);
    expect(existsSync(join(dir, ".git/packed-refs"))).toBe(true);
  });

  it("repacks a repository native git packed, with a .keep pack, several packs and loose objects", async () => {
    const dir = repo(3);
    git(dir, ["repack", "-adq"]);
    const [keptPack] = packsOf(dir, ".pack");
    const keep = join(packDir(dir), (keptPack ?? "").replace(/\.pack$/, ".keep"));
    writeFileSync(keep, "kept\n");
    for (let c = 3; c < 5; c++) commitFiles(dir, c);
    git(dir, ["repack", "-dq"]); // a second pack, incremental
    for (let c = 5; c < 7; c++) commitFiles(dir, c); // loose
    expect(packsOf(dir, ".pack").length).toBe(2);
    expect(countObjects(dir).count).toBeGreaterThan(0);
    const objects = allObjects(dir);

    const r = await repack(await backend(dir));

    expect(r?.keptPacks).toEqual([(keptPack ?? "").replace(/\.pack$/, "")]);
    expect(r?.packsRemoved.length).toBe(1);
    expect(existsSync(keep)).toBe(true);
    expect(packsOf(dir, ".pack")).toEqual([keptPack, `${r?.packName}.pack`].sort());
    const counts = expectValid(dir);
    expect(counts.count).toBe(0);
    expect(allObjects(dir)).toEqual(objects);
  });

  it("keeps objects reachable only from the index or a reflog; native git gc runs after ours", async () => {
    const dir = repo(4);
    commitFiles(dir, 4); // past the tag and the branches
    git(dir, ["reset", "-q", "--hard", "HEAD~1"]); // that commit is now only in the reflogs
    writeFileSync(join(dir, "staged.txt"), "staged, never committed\n");
    git(dir, ["add", "staged.txt"]); // a blob only the index names
    const objects = allObjects(dir);
    const b = await backend(dir);

    const result = await gc({ history: b.history, files: b.files, pruneExpireMs: 0 });

    expect(result.removedObjects).toBe(0);
    expectValid(dir);
    expect(allObjects(dir)).toEqual(objects);
    expect(git(dir, ["cat-file", "-p", ":staged.txt"])).toBe("staged, never committed\n");

    // the reflog entries are dated 2023 (GIT_COMMITTER_DATE): keep git gc from expiring them
    const noExpiry = ["-c", "gc.reflogExpire=never", "-c", "gc.reflogExpireUnreachable=never"];
    git(dir, [...noExpiry, "gc", "--quiet", "--prune=now"]);
    expectValid(dir);
    expect(allObjects(dir)).toEqual(objects);
  });
});
