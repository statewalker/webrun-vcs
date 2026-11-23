/**
 * gc's cruft packs against native git, after git's t5329-pack-objects-cruft and t6500-gc:
 * the same repository (copied with its file times) is gc'ed by native `git gc` and by ours,
 * and both end with the same objects in the same kinds of packs (one pack of what is
 * reachable, cruft packs of what is not), the same `.mtimes` times for the same objects, and
 * the same objects pruned. The packs' bytes are not compared: delta choices may differ.
 * `gc.pruneExpire` is pinned to a number of seconds, so both gcs expire at the same instant.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePackMtimes } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend, gc } from "../src/index.js";

const DAY = 24 * 3600;
const now = Math.floor(Date.now() / 1000);
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
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};
const git = (cwd: string, args: string[], input?: string | Buffer) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, maxBuffer: 1 << 30, input }).toString();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "cruft-"));
  dirs.push(d);
  return d;
};

/** Sets a file's mtime `daysAgo` days before now. */
const age = (path: string, daysAgo: number) => {
  const t = new Date((now - Math.round(daysAgo * DAY)) * 1000);
  utimesSync(path, t, t);
};
const looseOf = (dir: string, id: string) => join(dir, ".git/objects", id.slice(0, 2), id.slice(2));
const blob = (dir: string, content: string | Buffer) =>
  git(dir, ["hash-object", "-w", "--stdin"], content).trim();

/** A commit no ref names, on `parent`, holding `files` (written loose). */
function danglingCommit(dir: string, parent: string, files: Record<string, string>): string[] {
  const ids: string[] = [];
  const entries = Object.entries(files).map(([name, content]) => {
    const id = blob(dir, content);
    ids.push(id);
    return `100644 blob ${id}\t${name}\n`;
  });
  const tree = git(dir, ["mktree"], entries.join("")).trim();
  const commit = git(dir, ["commit-tree", tree, "-p", parent, "-m", "dangling"]).trim();
  return [commit, tree, ...ids];
}

/**
 * A packed history, and unreachable objects of every age: loose ones young (2 days) and old
 * (30 days), an old one a young commit reaches, a young pack and an old pack of unreachable
 * objects. No reflog or ORIG_HEAD names them.
 */
function scenario(): { dir: string; young: string[]; old: string[]; reached: string } {
  const dir = join(tmp(), "repo");
  git(join(dir, ".."), ["init", "-q", "--initial-branch=main", "repo"]);
  for (let c = 0; c < 3; c++) {
    writeFileSync(join(dir, "file.txt"), `${"reachable ".repeat(50)}${c}\n`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", `c${c}`]);
  }
  git(dir, ["repack", "-adq"]);
  const head = git(dir, ["rev-parse", "HEAD"]).trim();
  // an old blob, which a young dangling tree reaches: kept with the expiration as its time
  const reached = blob(dir, "old, but reached from a young object\n");
  age(looseOf(dir, reached), 30);
  const youngTree = git(dir, ["mktree"], `100644 blob ${reached}\tkept.txt\n`).trim();
  const young = [youngTree, ...danglingCommit(dir, head, { "young.txt": "young\n" })];
  for (const id of young) age(looseOf(dir, id), 2);
  const old = danglingCommit(dir, head, { "old.txt": "old\n" });
  for (const id of old) age(looseOf(dir, id), 30);
  // unreachable packed objects: in a young pack, and in an old one
  const inYoungPack = blob(dir, "in a young pack\n");
  const inOldPack = blob(dir, "in an old pack\n");
  for (const [id, days] of [
    [inYoungPack, 3],
    [inOldPack, 40],
  ] as const) {
    const name = git(dir, ["pack-objects", "-q", ".git/objects/pack/pack"], `${id}\n`).trim();
    for (const ext of ["pack", "idx", "rev"]) {
      const path = join(dir, ".git/objects/pack", `pack-${name}.${ext}`);
      try {
        age(path, days);
      } catch {
        // no .rev (pack.writeReverseIndex off)
      }
    }
    rmSync(looseOf(dir, id));
  }
  young.push(inYoungPack);
  old.push(inOldPack);
  rmSync(join(dir, ".git/logs"), { recursive: true, force: true });
  rmSync(join(dir, ".git/ORIG_HEAD"), { force: true });
  // both gcs expire at the same instant
  git(dir, ["config", "gc.pruneExpire", String(now - 14 * DAY)]);
  return { dir, young, old, reached };
}

/** A copy keeping every file's mtime. */
function copy(dir: string): string {
  const target = join(tmp(), "copy");
  execFileSync("cp", ["-a", dir, target]);
  return target;
}

/** The objects of each pack kind (`cruft` with their `.mtimes`), and the loose ones. */
function layout(dir: string) {
  const packDir = join(dir, ".git/objects/pack");
  const cruft = new Map<string, number>();
  const regular: string[] = [];
  let cruftPacks = 0;
  let regularPacks = 0;
  for (const name of readdirSync(packDir).filter((f) => f.endsWith(".idx"))) {
    const base = join(packDir, name.slice(0, -4));
    const ids = git(dir, ["show-index"], readFileSync(`${base}.idx`))
      .trim()
      .split("\n")
      .map((l) => l.split(" ")[1] as string)
      .sort();
    let mtimes: Uint32Array | undefined;
    try {
      mtimes = parsePackMtimes(new Uint8Array(readFileSync(`${base}.mtimes`)), ids.length, base);
    } catch {
      mtimes = undefined;
    }
    if (mtimes) {
      cruftPacks++;
      ids.forEach((id, i) => {
        cruft.set(id, mtimes[i] as number);
      });
    } else {
      regularPacks++;
      regular.push(...ids);
    }
  }
  const loose = git(dir, ["count-objects", "-v"]).match(/^count: (\d+)$/m)?.[1];
  return {
    regular: regular.sort(),
    cruft: Object.fromEntries([...cruft.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    cruftPacks,
    regularPacks,
    loose: Number(loose),
  };
}

async function ourGc(dir: string, options: { maxCruftSize?: number } = {}) {
  const files = createNodeFilesApi({ rootDir: dir });
  const b = await createGitFilesBackend({ files });
  return gc({ history: b.history, files, ...options });
}

describe("gc writes cruft packs (t5329, t6500)", () => {
  it("unreachable objects go into a cruft pack with the times git gives them; expired ones are pruned", async () => {
    const { dir, young, old, reached } = scenario();
    const native = copy(dir);
    const ours = copy(dir);
    git(native, ["gc", "-q"]);
    const r = await ourGc(ours);
    expect(r.repack?.cruftPacks?.length).toBe(1);

    const theirs = layout(native);
    const mine = layout(ours);
    expect(mine).toEqual(theirs);
    // what the scenario means: young and reached objects kept, old ones gone
    for (const id of [...young, reached]) expect(theirs.cruft[id]).toBeDefined();
    for (const id of old) expect(theirs.cruft[id]).toBeUndefined();
    expect(theirs.cruft[reached]).toBe(now - 14 * DAY);
    expect(theirs.regularPacks).toBe(1);
    expect(theirs.loose).toBe(0);
    git(ours, ["fsck", "--no-progress"]);
    // fsck accepts our .mtimes, and native gc goes on from our cruft pack
    git(ours, ["gc", "-q"]);
    expect(layout(ours)).toEqual(theirs);
  });

  it("a second gc keeps an existing cruft pack's times (t5329 'cruft packs tolerate ...')", async () => {
    const { dir } = scenario();
    git(dir, ["gc", "-q"]);
    // a new unreachable object beside the cruft pack, then both gc again
    const extra = blob(dir, "unreachable after the first gc\n");
    age(looseOf(dir, extra), 1);
    const native = copy(dir);
    const ours = copy(dir);
    git(native, ["gc", "-q"]);
    await ourGc(ours);
    const theirs = layout(native);
    expect(theirs.cruft[extra]).toBeDefined();
    expect(layout(ours)).toEqual(theirs);
  });

  it("our cruft pack read by our next gc: times kept, expired ones dropped", async () => {
    const { dir } = scenario();
    const ours = copy(dir);
    const native = copy(dir);
    await ourGc(ours);
    git(native, ["gc", "-q"]);
    // the expiry moves past the young objects' times: both drop them from the cruft pack
    for (const d of [ours, native]) git(d, ["config", "gc.pruneExpire", String(now - DAY)]);
    await ourGc(ours);
    git(native, ["gc", "-q"]);
    expect(layout(ours)).toEqual(layout(native));
  });

  it("--prune=now writes no cruft pack: everything unreachable is pruned", async () => {
    const { dir } = scenario();
    git(dir, ["config", "gc.pruneExpire", "now"]);
    const native = copy(dir);
    const ours = copy(dir);
    git(native, ["gc", "-q"]);
    const r = await ourGc(ours);
    expect(r.repack?.cruftPacks).toBeUndefined();
    const theirs = layout(native);
    expect(theirs.cruftPacks).toBe(0);
    expect(layout(ours)).toEqual(theirs);
  });

  it("gc.cruftPacks=false keeps the unreachable objects loose, as git gc does", async () => {
    const { dir } = scenario();
    git(dir, ["config", "gc.cruftPacks", "false"]);
    const native = copy(dir);
    const ours = copy(dir);
    git(native, ["gc", "-q"]);
    await ourGc(ours);
    const theirs = layout(native);
    const mine = layout(ours);
    expect(mine.cruftPacks).toBe(0);
    expect(theirs.cruftPacks).toBe(0);
    expect(mine.regular).toEqual(theirs.regular);
    const objects = (d: string) =>
      git(d, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]).trim().split("\n");
    expect(objects(ours)).toEqual(objects(native));
  });

  it("gc.maxCruftSize splits the cruft objects into packs no larger (t5329 '--max-cruft-size')", async () => {
    const { dir } = scenario();
    // incompressible unreachable blobs, about 3 MiB in all
    for (let i = 0; i < 6; i++) age(looseOf(dir, blob(dir, randomBytes(512 * 1024))), 1);
    git(dir, ["config", "gc.maxCruftSize", "1m"]);
    const native = copy(dir);
    const ours = copy(dir);
    git(native, ["gc", "-q"]);
    const r = await ourGc(ours);
    const theirs = layout(native);
    const mine = layout(ours);
    expect(mine.cruft).toEqual(theirs.cruft);
    expect(mine.regular).toEqual(theirs.regular);
    expect(r.repack?.cruftPacks?.length).toBeGreaterThan(1);
    for (const name of r.repack?.cruftPacks ?? [])
      expect(statSync(join(ours, ".git/objects/pack", `${name}.pack`)).size).toBeLessThanOrEqual(
        1024 * 1024,
      );
    git(ours, ["fsck", "--no-progress"]);
  });
});
