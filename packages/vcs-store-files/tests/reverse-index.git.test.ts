/**
 * Pack reverse indexes (`pack-<id>.rev`) against native git, after git's t5325-reverse-index
 * and t5327-multi-pack-bitmaps-rev: what index-pack, repack and gc write is byte-identical to
 * what native git writes for the same pack, `git fsck` and `git verify-pack` accept it,
 * `pack.writeReverseIndex=false` writes none, and a corrupt one is read as git does (refused,
 * the order computed) while fsck reports it with git's lines.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, maxBuffer: 1 << 30 }).toString();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "rev-index-"));
  dirs.push(d);
  return d;
};

/** A repository with `n` commits editing a few files (deltas), a tag and a branch. */
function repo(n: number): string {
  const dir = tmp();
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  for (let c = 0; c < n; c++) {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: lorem ipsum`);
    for (let f = 0; f < 3; f++) {
      for (let k = 0; k <= c; k++) lines[(k * 37 + f * 11) % lines.length] = `edit ${c}/${k} ${f}`;
      writeFileSync(join(dir, `file${f}.txt`), `${lines.join("\n")}\n`);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", `commit ${c}`]);
  }
  git(dir, ["tag", "-a", "-m", "release", "v1"]);
  return dir;
}

const packDir = (dir: string) => join(dir, ".git/objects/pack");
const packFiles = (dir: string, ext: string) =>
  readdirSync(packDir(dir))
    .filter((f) => f.endsWith(ext))
    .sort();
const backend = (dir: string) =>
  createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });

/** The `.rev` native index-pack writes for a copy of `pack` (`--rev-index`). */
function nativeRevOf(pack: string): Buffer {
  const d = tmp();
  const copy = join(d, "pack-x.pack");
  copyFileSync(pack, copy);
  git(d, ["index-pack", "--rev-index", copy]);
  return readFileSync(join(d, "pack-x.rev"));
}

describe("pack reverse indexes (t5325)", () => {
  it("index-pack with pack.writeReverseIndex: byte-identical to native git's for the same pack", async () => {
    const source = repo(4);
    git(source, ["-c", "pack.writeReverseIndex=true", "repack", "-adq"]);
    const [pack] = packFiles(source, ".pack");
    const name = (pack as string).replace(/\.pack$/, "");
    const nativeRev = readFileSync(join(packDir(source), `${name}.rev`));

    const target = tmp();
    git(target, ["init", "-q", "--bare", "."]);
    const b = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: target }),
      gitDir: ".",
    });
    const installed = await b.packs.install(
      (async function* () {
        yield new Uint8Array(readFileSync(join(packDir(source), pack as string)));
      })(),
    );
    expect(`pack-${installed.packId}`).toBe(name);
    const ours = readFileSync(join(target, "objects/pack", `${name}.rev`));
    expect(Buffer.compare(ours, nativeRev)).toBe(0);
    git(target, ["fsck", "--no-progress"]);
  });

  it("index-pack with pack.writeReverseIndex=false writes none", async () => {
    const source = repo(2);
    git(source, ["repack", "-adq"]);
    const [pack] = packFiles(source, ".pack");
    const target = tmp();
    git(target, ["init", "-q", "--bare", "."]);
    git(target, ["config", "pack.writeReverseIndex", "false"]);
    const b = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: target }),
      gitDir: ".",
    });
    await b.packs.install(
      (async function* () {
        yield new Uint8Array(readFileSync(join(packDir(source), pack as string)));
      })(),
    );
    expect(readdirSync(join(target, "objects/pack")).filter((f) => f.endsWith(".rev"))).toEqual([]);
    // native git agrees: its own index-pack writes none either
    git(target, ["index-pack", join(target, "objects/pack", pack as string)]);
    expect(readdirSync(join(target, "objects/pack")).filter((f) => f.endsWith(".rev"))).toEqual([]);
  });

  it("repack and gc write a .rev git would write, which fsck and verify-pack accept", async () => {
    const dir = repo(5);
    const b = await backend(dir);
    const r = await repack(b);
    const name = r?.packName as string;
    const rev = readFileSync(join(packDir(dir), `${name}.rev`));
    expect(Buffer.compare(rev, nativeRevOf(join(packDir(dir), `${name}.pack`)))).toBe(0);
    git(dir, ["fsck", "--full", "--strict", "--no-progress"]);
    git(dir, ["verify-pack", join(packDir(dir), `${name}.idx`)]);

    git(dir, ["commit", "-q", "--allow-empty", "-m", "more"]);
    const g = await gc({ history: b.history, files: b.files, pruneExpireMs: 0 });
    const gcName = g.repack?.packName as string;
    expect(packFiles(dir, ".rev")).toEqual([`${gcName}.rev`]);
    const gcRev = readFileSync(join(packDir(dir), `${gcName}.rev`));
    expect(Buffer.compare(gcRev, nativeRevOf(join(packDir(dir), `${gcName}.pack`)))).toBe(0);
    git(dir, ["fsck", "--full", "--strict", "--no-progress"]);
  });

  it("repack with pack.writeReverseIndex=false writes no .rev, and removes the replaced packs' ones", async () => {
    const dir = repo(3);
    git(dir, ["-c", "pack.writeReverseIndex=true", "repack", "-adq"]);
    expect(packFiles(dir, ".rev").length).toBe(1);
    git(dir, ["config", "pack.writeReverseIndex", "false"]);
    git(dir, ["commit", "-q", "--allow-empty", "-m", "more"]);
    const r = await repack(await backend(dir));
    expect(r?.packsRemoved.length).toBe(1);
    expect(packFiles(dir, ".rev")).toEqual([]);
    git(dir, ["fsck", "--no-progress"]);
  });

  it("the on-disk reverse index gives the in-memory one's order (revindex in-memory vs on-disk)", async () => {
    const dir = repo(4);
    git(dir, ["-c", "pack.writeReverseIndex=true", "repack", "-adq"]);
    const b = await backend(dir);
    const [pack] = await b.packs.packs();
    const p = pack as unknown as {
      loadReverseIndex(): Promise<string>;
      packOrder(): Uint32Array;
      offsetAt(i: number): number;
    };
    expect(await p.loadReverseIndex()).toBe("loaded");
    const order = p.packOrder();
    const offsets = Array.from(order, (i) => p.offsetAt(i));
    expect(offsets).toEqual([...offsets].sort((x, y) => x - y));
    // native show-index, sorted by offset, gives the same idx positions
    const idx = join(packDir(dir), `pack-${pack?.packId}.idx`);
    const shown = execFileSync("git", ["show-index"], { input: readFileSync(idx), env: GIT_ENV })
      .toString()
      .trim()
      .split("\n")
      .map((line, i) => ({ offset: Number(line.split(" ")[0]), i }))
      .sort((x, y) => x.offset - y.offset)
      .map((e) => e.i);
    expect(Array.from(order)).toEqual(shown);
  });

  it("a corrupt .rev is refused on read and the order computed; fsck reports it as git does", async () => {
    const dir = repo(3);
    git(dir, ["-c", "pack.writeReverseIndex=true", "repack", "-adq"]);
    const [rev] = packFiles(dir, ".rev");
    const revPath = join(packDir(dir), rev as string);
    chmodSync(revPath, 0o644);
    const bytes = readFileSync(revPath);
    // swap the first two positions (t5325 "fsck catches invalid row position")
    const swapped = Buffer.from(bytes);
    bytes.copy(swapped, 12, 16, 20);
    bytes.copy(swapped, 16, 12, 16);
    writeFileSync(revPath, swapped);

    const b = await backend(dir);
    const [pack] = await b.packs.packs();
    const p = pack as unknown as {
      loadReverseIndex(): Promise<string>;
      packOrder(): Uint32Array;
      offsetAt(i: number): number;
      verifyReverseIndex(): Promise<string[] | undefined>;
    };
    expect(await p.loadReverseIndex()).toMatch(/does not follow the pack's offsets$/);
    const offsets = Array.from(p.packOrder(), (i) => p.offsetAt(i));
    expect(offsets).toEqual([...offsets].sort((x, y) => x - y));

    const native = spawnSync("git", ["fsck", "--no-progress"], { cwd: dir, env: GIT_ENV });
    const nativeLines = native.stderr
      .toString()
      .split("\n")
      .filter((l) => l.includes("rev-index") || l === "error: invalid checksum");
    // the pack set names packs from the FilesApi's root
    const ours = (await p.verifyReverseIndex())?.map((l) => l.replace("'/.git", "'.git"));
    expect(ours).toEqual(nativeLines);

    // a truncated file: git cannot load it ("is corrupt")
    writeFileSync(revPath, bytes.subarray(0, bytes.length - 4));
    const again = spawnSync("git", ["fsck", "--no-progress"], { cwd: dir, env: GIT_ENV });
    const againLines = again.stderr
      .toString()
      .split("\n")
      .filter((l) => l.includes("rev-index"));
    const b2 = await backend(dir);
    const [pack2] = await b2.packs.packs();
    const p2 = pack2 as unknown as typeof p;
    expect(await p2.loadReverseIndex()).toMatch(/is corrupt$/);
    const ours2 = (await p2.verifyReverseIndex())
      ?.filter((l) => l.includes("rev-index"))
      .map((l) => l.replaceAll("'/.git", "'.git").replaceAll(" /.git", " .git"));
    expect(ours2).toEqual(againLines);
  });

  it("pack.readReverseIndex=false ignores the file", async () => {
    const dir = repo(2);
    git(dir, ["-c", "pack.writeReverseIndex=true", "repack", "-adq"]);
    git(dir, ["config", "pack.readReverseIndex", "false"]);
    const b = await backend(dir);
    const [pack] = await b.packs.packs();
    expect(
      await (pack as unknown as { loadReverseIndex(): Promise<string> }).loadReverseIndex(),
    ).toBe("absent");
  });
});

describe("multi-pack bitmaps with .rev files (t5327)", () => {
  it("a bitmap written by our repack over a pack with a .rev reads back", async () => {
    const dir = repo(4);
    git(dir, ["config", "repack.writeBitmaps", "true"]);
    const b = await backend(dir);
    const r = await repack(b);
    expect(r?.bitmapWritten).toBe(true);
    expect(packFiles(dir, ".rev")).toEqual([`${r?.packName}.rev`]);
    git(dir, ["fsck", "--no-progress"]);
    // native git reads our bitmap through our .rev
    const counted = git(dir, ["rev-list", "--count", "--objects", "--use-bitmap-index", "--all"]);
    const plain = git(dir, ["rev-list", "--count", "--objects", "--all"]);
    expect(counted).toBe(plain);
    const fresh = await backend(dir);
    expect(await fresh.packs.bitmap?.()).toBeDefined();
  });
});
