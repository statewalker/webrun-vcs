/**
 * Pack reachability bitmaps against native git (whichever version is on PATH: 2.43 and 2.5x
 * order the entries differently):
 *
 *  - for a pack native git wrote, our `.bitmap` is byte-identical to git's (linear and merge
 *    histories, hash cache and lookup table on and off);
 *  - git's bitmap read by ours: the same objects and counts as `git rev-list
 *    --use-bitmap-index --count --objects`, and the same served pack contents with and
 *    without it;
 *  - ours read by git (`rev-list --test-bitmap`, counts), after `repack -a -d -b` and a bare
 *    repository's gc;
 *  - `repack -b`'s messages, and a corrupt bitmap falling back with git's error line.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bitmapWalk,
  DefaultSerializationApi,
  type PackFile,
  writePackBitmap,
} from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import {
  BitmapWriteError,
  createGitFilesBackend,
  gc,
  IncrementalBitmapError,
  isPreferredBitmapTip,
  listReachableObjects,
  NO_CLOSURE_BITMAP_WARNING,
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
};
const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", args, {
    cwd,
    env: { ...GIT_ENV, ...env },
    maxBuffer: 1 << 28,
    stdio: ["pipe", "pipe", "pipe"],
  }).toString();
const gitResult = (cwd: string, args: string[]) => {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

const version = execFileSync("git", ["--version"], { encoding: "utf8" });
const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
/** 2.5x sorts the entries oldest first; 2.43 keeps them newest first. */
const compatibility: "2.43" | "2.56" = major > 2 || minor >= 50 ? "2.56" : "2.43";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Commits with distinct dates (git sorts commits of one date in an order of its own). */
let clock = 1_700_000_000;
function commitAll(dir: string, message: string) {
  clock += 100;
  const date = `${clock} +0000`;
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
}

/** A history: `linear` commits on main, with `merge` a side branch merged back and a tag. */
function makeRepo(kind: "linear" | "merge", commits = 12, bare = false): string {
  const dir = tmp(`bitmap-${kind}-`);
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  for (let i = 0; i < commits; i++) {
    mkdirSync(join(dir, `d${i % 3}`), { recursive: true });
    writeFileSync(join(dir, `d${i % 3}`, `f${i}.txt`), `file ${i}\n`);
    writeFileSync(join(dir, "top.txt"), `top ${i}\n${"x".repeat(i * 10)}\n`);
    commitAll(dir, `c${i}`);
  }
  if (kind === "merge") {
    git(dir, ["checkout", "-q", "-b", "side", "HEAD~4"]);
    writeFileSync(join(dir, "side.txt"), "side\n");
    commitAll(dir, "side");
    writeFileSync(join(dir, "side.txt"), "side 2\n");
    commitAll(dir, "side 2");
    git(dir, ["checkout", "-q", "main"]);
    clock += 100;
    git(dir, ["merge", "-q", "--no-edit", "side"], {
      GIT_AUTHOR_DATE: `${clock} +0000`,
      GIT_COMMITTER_DATE: `${clock} +0000`,
    });
  }
  git(dir, ["tag", "-a", "-m", "release", "v1", "HEAD~2"], {
    GIT_COMMITTER_DATE: `${clock} +0000`,
  });
  if (!bare) return dir;
  const bareDir = tmp(`bitmap-${kind}-bare-`);
  git(bareDir, ["clone", "-q", "--bare", "--no-local", dir, "."]);
  return bareDir;
}

const gitDirOf = (dir: string) => (readdirSync(dir).includes(".git") ? ".git" : ".");
const packDir = (dir: string) => join(dir, gitDirOf(dir), "objects", "pack");
const filesIn = (dir: string, ext: string) =>
  readdirSync(packDir(dir)).filter((f) => f.endsWith(ext));

async function open(dir: string) {
  const files = createNodeFilesApi({ rootDir: dir });
  const gitDir = gitDirOf(dir);
  const backend = await createGitFilesBackend({ files, gitDir });
  return { files, gitDir, backend };
}

async function onlyPack(dir: string): Promise<{
  pack: PackFile;
  backend: Awaited<ReturnType<typeof open>>["backend"];
  files: ReturnType<typeof createNodeFilesApi>;
  gitDir: string;
}> {
  const o = await open(dir);
  await o.backend.packs.refresh();
  const packs = await o.backend.packs.packs();
  expect(packs.length).toBe(1);
  return { ...o, pack: packs[0] as PackFile };
}

const objectsOf = (dir: string, extra: string[] = []) =>
  git(dir, ["rev-list", "--objects", "--all", ...extra])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(0, 40));

describe("pack bitmaps as native git writes them", () => {
  for (const kind of ["linear", "merge"] as const) {
    for (const lookupTable of [false, true]) {
      for (const hashCache of [true, false]) {
        it(`${kind}: our .bitmap of git's pack is git's (lookup table ${lookupTable}, hash cache ${hashCache})`, async () => {
          const dir = makeRepo(kind);
          git(dir, [
            "-c",
            `pack.writeBitmapLookupTable=${lookupTable}`,
            "-c",
            `pack.writeBitmapHashCache=${hashCache}`,
            "repack",
            "-a",
            "-d",
            "-b",
            "-q",
          ]);
          const [bitmapName] = filesIn(dir, ".bitmap");
          const native = readFileSync(join(packDir(dir), bitmapName as string));
          const { pack, backend, files, gitDir } = await onlyPack(dir);
          const listed = await listReachableObjects({
            files,
            gitDir,
            refs: backend.history.refs,
            objects: backend.objects,
          });
          const ours = await writePackBitmap({
            pack,
            objects: backend.objects,
            listed,
            lookupTable,
            hashCache,
            compatibility,
          });
          expect(Buffer.from(ours).toString("hex")).toBe(native.toString("hex"));
        });
      }
    }
  }
});

/** A long history through fast-import: `n` commits, a merge every 10, distinct dates. */
function makeLongRepo(n: number): string {
  const dir = tmp("bitmap-long-");
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  const lines: string[] = [];
  let mark = 0;
  const marks: number[] = [];
  for (let i = 0; i < n; i++) {
    clock += 100;
    const m = ++mark;
    marks.push(m);
    const branch = i % 10 === 5 ? "refs/heads/side" : "refs/heads/main";
    lines.push(`commit ${branch}`, `mark :${m}`);
    lines.push(`author A <a@b> ${clock} +0000`, `committer A <a@b> ${clock} +0000`);
    const msg = `c${i}`;
    lines.push(`data ${msg.length}`, msg);
    if (i > 0) {
      const from = i % 10 === 5 ? marks[i - 3] : marks[i - 1];
      lines.push(`from :${from}`);
      if (i % 10 === 6) lines.push(`merge :${marks[i - 1]}`);
    }
    const content = `content ${i}\n`;
    lines.push(`M 100644 inline d${i % 7}/f${i % 13}.txt`, `data ${content.length}`, content);
  }
  lines.push("");
  execFileSync("git", ["fast-import", "--quiet"], {
    cwd: dir,
    env: GIT_ENV,
    input: lines.join("\n"),
  });
  return dir;
}

describe("pack bitmaps of long histories", () => {
  it("selects the commits git selects (over 100 commits, merges)", async () => {
    const dir = makeLongRepo(260);
    git(dir, ["repack", "-a", "-d", "-b", "-q"]);
    const [bitmapName] = filesIn(dir, ".bitmap");
    const native = readFileSync(join(packDir(dir), bitmapName as string));
    const { pack, backend, files, gitDir } = await onlyPack(dir);
    const listed = await listReachableObjects({
      files,
      gitDir,
      refs: backend.history.refs,
      objects: backend.objects,
    });
    const ours = await writePackBitmap({ pack, objects: backend.objects, listed, compatibility });
    expect(Buffer.from(ours).toString("hex")).toBe(native.toString("hex"));
  });
});

describe("git's bitmap read by ours", () => {
  it("lists what git lists, counts and served packs alike", async () => {
    const dir = makeRepo("merge", 16);
    git(dir, ["repack", "-a", "-d", "-b", "-q"]);
    const { backend } = await onlyPack(dir);
    const index = await backend.packs.bitmap?.();
    expect(index).toBeDefined();
    if (!index) return;
    const tips = git(dir, ["for-each-ref", "--format=%(objectname)"]).split("\n").filter(Boolean);
    const all = await bitmapWalk(index, backend.objects, { wants: tips });
    const count = Number(
      git(dir, ["rev-list", "--use-bitmap-index", "--count", "--objects", "--all"]).trim(),
    );
    expect(all.count).toBe(count);
    expect(new Set([...all.objects()].map((o) => o.id))).toEqual(new Set(objectsOf(dir)));
    // a fetch: wants minus haves, as git's bitmap walk gives it
    const main = git(dir, ["rev-parse", "main"]).trim();
    const old = git(dir, ["rev-parse", "main~5"]).trim();
    const part = await bitmapWalk(index, backend.objects, { wants: [main], haves: [old] });
    const nativePart = Number(
      git(dir, ["rev-list", "--use-bitmap-index", "--count", "--objects", main, `^${old}`]).trim(),
    );
    expect(part.count).toBe(nativePart);

    // served packs: the same objects with and without the bitmap
    const serialization = new DefaultSerializationApi({
      history: backend.history,
      packs: backend.packs,
    });
    const served = async (useBitmaps: boolean, haves: string[]) => {
      const chunks: Uint8Array[] = [];
      for await (const c of serialization.exportPack([main], haves, { useBitmaps })) chunks.push(c);
      const out = tmp("served-");
      writeFileSync(join(out, "p.pack"), Buffer.concat(chunks));
      git(out, ["init", "-q", "--bare", "repo"]);
      git(join(out, "repo"), ["index-pack", "-o", join(out, "p.idx"), join(out, "p.pack")]);
      return execFileSync("git", ["show-index"], { input: readFileSync(join(out, "p.idx")) })
        .toString()
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(" ")[1] as string)
        .sort();
    };
    expect(await served(true, [])).toEqual(await served(false, []));
    const withBitmap = await served(true, [old]);
    expect(withBitmap.length).toBe(nativePart);
    // the walk lists the same or a few more (only boundary trees are uninteresting to it)
    const walked = await served(false, [old]);
    for (const id of withBitmap) expect(walked).toContain(id);
  });
});

describe("our bitmaps read by git", () => {
  it("repack -a -d -b writes a bitmap git verifies and counts with", async () => {
    const dir = makeRepo("merge", 14);
    const { backend } = await open(dir);
    const result = await repack({ ...backend, writeBitmaps: true });
    expect(result?.bitmapWritten).toBe(true);
    expect(result?.warnings).toBeUndefined();
    expect(filesIn(dir, ".bitmap").length).toBe(1);
    const test = gitResult(dir, ["rev-list", "--test-bitmap", "HEAD"]);
    expect(test.status).toBe(0);
    expect(test.stderr).toContain("OK!");
    expect(
      Number(git(dir, ["rev-list", "--use-bitmap-index", "--count", "--objects", "--all"]).trim()),
    ).toBe(objectsOf(dir).length);
    git(dir, ["fsck", "--no-progress"]);
    // and ours reads it back
    const again = await open(dir);
    const index = await again.backend.packs.bitmap?.();
    expect(index?.entries.length).toBeGreaterThan(0);
    // a repack without -b drops the stale bitmap with the pack it replaces
    writeFileSync(join(dir, "new.txt"), "new\n");
    commitAll(dir, "new");
    const second = await repack({ ...again.backend, writeBitmaps: false });
    expect(second?.bitmapWritten).toBe(false);
    expect(filesIn(dir, ".bitmap")).toEqual([]);
  });

  it("refuses -b without -a and warns when alternates keep objects out, as git", async () => {
    const dir = makeRepo("linear", 4);
    const { backend } = await open(dir);
    await expect(repack({ ...backend, all: false, writeBitmaps: true })).rejects.toBeInstanceOf(
      IncrementalBitmapError,
    );
    const nativeIncremental = gitResult(dir, ["repack", "-d", "-b", "-q"]);
    expect(nativeIncremental.status).not.toBe(0);
    expect(nativeIncremental.stderr.trim()).toBe(`fatal: ${new IncrementalBitmapError().message}`);

    // a clone borrowing from `dir` through objects/info/alternates
    const root = tmp("bitmap-alt-");
    git(root, ["clone", "-q", "--shared", dir, "clone"]);
    const clone = join(root, "clone");
    writeFileSync(join(clone, "own.txt"), "own\n");
    commitAll(clone, "own");
    const native = tmp("bitmap-alt-native-");
    cpSync(clone, join(native, "clone"), { recursive: true });
    const nativeRun = gitResult(join(native, "clone"), ["repack", "-a", "-d", "-l", "-b", "-q"]);
    expect(nativeRun.stderr.trim()).toBe(NO_CLOSURE_BITMAP_WARNING);
    const files = createNodeFilesApi({ rootDir: "/" });
    const b = await createGitFilesBackend({ files, gitDir: join(clone, ".git").slice(1) });
    const ours = await repack({ ...b, local: true, writeBitmaps: true });
    expect(ours?.warnings).toEqual([NO_CLOSURE_BITMAP_WARNING]);
    expect(ours?.bitmapWritten).toBe(false);
  });

  it("a bare repository's gc writes a bitmap, as git gc does", async () => {
    const dir = makeRepo("merge", 10, true);
    const nativeDir = tmp("bitmap-gc-native-");
    cpSync(dir, nativeDir, { recursive: true });
    git(nativeDir, ["gc", "-q"]);
    expect(filesIn(nativeDir, ".bitmap").length).toBe(1);
    const { backend, files, gitDir } = await open(dir);
    const result = await gc({
      history: backend.history,
      files,
      gitDir,
      objects: backend.objects,
      packs: backend.packs,
    });
    expect(result.repack?.bitmapWritten).toBe(true);
    expect(filesIn(dir, ".bitmap").length).toBe(1);
    expect(gitResult(dir, ["rev-list", "--test-bitmap", "HEAD"]).stderr).toContain("OK!");
    expect(
      Number(git(dir, ["rev-list", "--use-bitmap-index", "--count", "--objects", "--all"]).trim()),
    ).toBe(
      Number(
        git(nativeDir, ["rev-list", "--use-bitmap-index", "--count", "--objects", "--all"]).trim(),
      ),
    );
  });
});

describe("corrupt bitmaps", () => {
  it("fall back to walking, with git's error line", async () => {
    const dir = makeRepo("linear", 6);
    git(dir, ["repack", "-a", "-d", "-b", "-q"]);
    const [name] = filesIn(dir, ".bitmap");
    const path = join(packDir(dir), name as string);
    chmodSync(path, 0o644);
    const bytes = readFileSync(path);
    bytes.write("XXXX", 0, "latin1");
    writeFileSync(path, bytes);
    const native = gitResult(dir, [
      "rev-list",
      "--use-bitmap-index",
      "--count",
      "--objects",
      "--all",
    ]);
    const firstLine = native.stderr.split("\n")[0];
    expect(firstLine).toBe("error: corrupted bitmap index file (wrong header)");
    const { backend } = await onlyPack(dir);
    expect(await backend.packs.bitmap?.()).toBeUndefined();
    expect(backend.packs.bitmapErrors).toEqual([firstLine]);
    // the served pack is still complete (through the walk)
    const serialization = new DefaultSerializationApi({
      history: backend.history,
      packs: backend.packs,
    });
    let size = 0;
    for await (const c of serialization.exportPack([git(dir, ["rev-parse", "HEAD"]).trim()], []))
      size += c.length;
    expect(size).toBeGreaterThan(32);
    expect(Number(native.stdout.trim())).toBe(objectsOf(dir).length);
  });
});

/** Our bitmap of the only pack, from our listing, against the one native git wrote with it. */
async function oursOfNativePack(
  dir: string,
  options: { preferredTips?: string[] } = {},
): Promise<{ ours: string; native: string }> {
  const [bitmapName] = filesIn(dir, ".bitmap");
  const native = readFileSync(join(packDir(dir), bitmapName as string)).toString("hex");
  const { pack, backend, files, gitDir } = await onlyPack(dir);
  const listed = await listReachableObjects({
    files,
    gitDir,
    refs: backend.history.refs,
    objects: backend.objects,
  });
  const ours = await writePackBitmap({
    pack,
    objects: backend.objects,
    listed,
    compatibility,
    ...(options.preferredTips ? { preferredTips: options.preferredTips } : {}),
  });
  return { ours: Buffer.from(ours).toString("hex"), native };
}

describe("name hashes and tip objects as git lists them", () => {
  it("hashes a path's bytes, skipping only git's isspace bytes (non-ASCII, VT, non-UTF-8)", async () => {
    const dir = makeRepo("linear", 3);
    mkdirSync(join(dir, "日本"), { recursive: true });
    mkdirSync(join(dir, "a b"), { recursive: true });
    writeFileSync(join(dir, "é.txt"), "e acute\n");
    writeFileSync(join(dir, "日本", "ü.txt"), "u umlaut\n");
    // U+0120: its low byte is a space, which the hash must not skip
    writeFileSync(join(dir, "Ġx.txt"), "g dot\n");
    writeFileSync(join(dir, "a b", "c\v.txt"), "vertical tab\n");
    // a name that is not UTF-8
    writeFileSync(Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0xff, 0x2e, 0x74])]), "ff\n");
    commitAll(dir, "names");
    git(dir, ["repack", "-a", "-d", "-b", "-q"]);
    const { ours, native } = await oursOfNativePack(dir);
    expect(ours).toBe(native);
  });

  it('names a blob or tree behind a ref "", as git\'s pending objects, before commit trees', async () => {
    const dir = makeRepo("linear", 4);
    const blob = git(dir, ["rev-parse", "HEAD:top.txt"]).trim();
    const other = git(dir, ["rev-parse", "HEAD~1:top.txt"]).trim();
    const tree = git(dir, ["rev-parse", "HEAD~2:d0"]).trim();
    git(dir, ["update-ref", "refs/tags/light-blob", blob]);
    git(dir, ["update-ref", "refs/tags/light-tree", tree]);
    git(dir, ["tag", "-a", "-m", "blob tag", "blob-tag", other], {
      GIT_COMMITTER_DATE: `${clock} +0000`,
    });
    git(dir, ["repack", "-a", "-d", "-b", "-q"]);
    const { ours, native } = await oursOfNativePack(dir);
    expect(ours).toBe(native);
  });

  it("matches pack.preferBitmapTips as each version does", async () => {
    const dir = makeLongRepo(260);
    const log = git(dir, ["log", "--all", "--format=%H %s"]).split("\n").filter(Boolean);
    const commitOf = (subject: string) =>
      (log.find((l) => l.endsWith(` ${subject}`)) as string).slice(0, 40);
    // in two selection windows, neither commit chosen without the preference
    git(dir, ["update-ref", "refs/tags/pick/one", commitOf("c119")]);
    git(dir, ["update-ref", "refs/tags/picky", commitOf("c79")]);
    git(dir, ["-c", "pack.preferBitmapTips=refs/tags/pick", "repack", "-a", "-d", "-b", "-q"]);
    const refs = git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"])
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ") as [string, string]);
    const tipsAs = (c: "2.43" | "2.56") =>
      refs
        .filter(([name]) => isPreferredBitmapTip(name, ["refs/tags/pick"], c))
        .map(([, id]) => id);
    expect(tipsAs("2.56")).toEqual([commitOf("c119")]);
    expect(tipsAs("2.43").sort()).toEqual([commitOf("c119"), commitOf("c79")].sort());
    const { ours, native } = await oursOfNativePack(dir, { preferredTips: tipsAs(compatibility) });
    expect(ours).toBe(native);
    // the other version's matching selects other commits
    const other = await oursOfNativePack(dir, {
      preferredTips: tipsAs(compatibility === "2.43" ? "2.56" : "2.43"),
    });
    expect(other.ours).not.toBe(native);
  });
});

describe("repack.packKeptObjects", () => {
  /** A repository whose history is in a .keep pack, with newer loose objects. */
  function withKeptPack(): string {
    const dir = makeRepo("linear", 4);
    git(dir, ["repack", "-a", "-d", "-q"]);
    const [pack] = filesIn(dir, ".pack");
    writeFileSync(join(packDir(dir), (pack as string).replace(/\.pack$/, ".keep")), "");
    writeFileSync(join(dir, "later.txt"), "later\n");
    commitAll(dir, "later");
    return dir;
  }
  const newPackCount = (dir: string, kept: string[]) => {
    const pack = filesIn(dir, ".idx").find((f) => !kept.includes(f)) as string;
    return execFileSync("git", ["show-index"], { input: readFileSync(join(packDir(dir), pack)) })
      .toString()
      .split("\n")
      .filter(Boolean).length;
  };

  it("false keeps .keep objects out of a -b repack, and the bitmap is not written", async () => {
    const dir = withKeptPack();
    const nativeDir = tmp("bitmap-keep-native-");
    cpSync(dir, nativeDir, { recursive: true });
    const native = gitResult(nativeDir, [
      "-c",
      "repack.packKeptObjects=false",
      "repack",
      "-a",
      "-d",
      "-b",
      "-q",
    ]);
    expect(native.stderr.trim()).toBe(NO_CLOSURE_BITMAP_WARNING);
    expect(filesIn(nativeDir, ".bitmap")).toEqual([]);
    git(dir, ["config", "repack.packKeptObjects", "false"]);
    const { backend } = await open(dir);
    const kept = filesIn(dir, ".idx");
    const ours = await repack({ ...backend, writeBitmaps: true });
    expect(ours?.warnings).toEqual([NO_CLOSURE_BITMAP_WARNING]);
    expect(ours?.bitmapWritten).toBe(false);
    expect(newPackCount(dir, kept)).toBe(newPackCount(nativeDir, kept));
  });

  it("true packs .keep objects without -b too", async () => {
    const dir = withKeptPack();
    const nativeDir = tmp("bitmap-keep-native-");
    cpSync(dir, nativeDir, { recursive: true });
    const kept = filesIn(dir, ".idx");
    git(nativeDir, ["-c", "repack.packKeptObjects=true", "repack", "-a", "-d", "-q"]);
    git(dir, ["config", "repack.packKeptObjects", "true"]);
    const { backend } = await open(dir);
    await repack({ ...backend, writeBitmaps: false });
    const count = newPackCount(dir, kept);
    expect(count).toBe(newPackCount(nativeDir, kept));
    expect(count).toBe(objectsOf(dir).length);
  });
});

describe("a bitmap that cannot be built", () => {
  it("fails the repack with git's lines, replacing nothing", async () => {
    const dir = makeRepo("linear", 5);
    git(dir, ["repack", "-a", "-d", "-q"]);
    writeFileSync(join(dir, "loose.txt"), "loose\n");
    commitAll(dir, "loose");
    const before = readdirSync(packDir(dir)).sort();
    const { backend } = await open(dir);
    const hidden = git(dir, ["rev-parse", "HEAD:loose.txt"]).trim();
    // the new pack, as the writer sees it, lacks one blob: the closure check fails
    const packs = new Proxy(backend.packs, {
      get(target, prop, receiver) {
        if (prop !== "packs") return Reflect.get(target, prop, receiver);
        return async () =>
          (await target.packs()).map(
            (p) =>
              new Proxy(p, {
                get(t, k, r) {
                  if (k !== "indexOf") return Reflect.get(t, k, r);
                  return (id: string) => (id === hidden ? -1 : (t as PackFile).indexOf(id));
                },
              }),
          );
      },
    });
    const error = await repack({ ...backend, packs, writeBitmaps: true }).catch((e) => e);
    expect(error).toBeInstanceOf(BitmapWriteError);
    expect((error as BitmapWriteError).warnings).toEqual([
      `warning: Failed to write bitmap index. Packfile doesn't have full closure (object ${hidden} is missing)`,
    ]);
    expect((error as Error).message).toBe("failed to write bitmap index");
    // the old pack and the loose objects stay; the new pack is gone
    expect(readdirSync(packDir(dir)).sort()).toEqual(before);
    git(dir, ["fsck", "--no-progress"]);
  });
});

describe("the bitmap walk falls back as git's", () => {
  it("walks when no have is in the bitmapped pack (a tag of a tree, a loose commit had)", async () => {
    const dir = makeRepo("merge", 12);
    git(dir, ["repack", "-a", "-d", "-b", "-q"]);
    const tree = git(dir, ["rev-parse", "HEAD~3^{tree}"]).trim();
    git(dir, ["tag", "-a", "-m", "a tree", "tree-tag", tree], {
      GIT_COMMITTER_DATE: `${clock} +0000`,
    });
    writeFileSync(join(dir, "loose.txt"), "loose\n");
    commitAll(dir, "loose");
    const tag = git(dir, ["rev-parse", "tree-tag"]).trim();
    const have = git(dir, ["rev-parse", "HEAD"]).trim();
    const countOf = (pack: Buffer | Uint8Array) => Buffer.from(pack).readUInt32BE(8);
    const nativeCount = (args: string[], input: string) =>
      countOf(
        execFileSync("git", ["pack-objects", "--revs", "--stdout", "-q", ...args], {
          cwd: dir,
          env: GIT_ENV,
          input,
          maxBuffer: 1 << 26,
        }),
      );
    const { backend } = await onlyPack(dir);
    const serialization = new DefaultSerializationApi({
      history: backend.history,
      packs: backend.packs,
    });
    const ours = async (wants: string[], haves: string[]) => {
      const chunks: Uint8Array[] = [];
      for await (const c of serialization.exportPack(wants, haves, { useBitmaps: true }))
        chunks.push(c);
      return countOf(Buffer.concat(chunks));
    };
    const native = nativeCount(["--use-bitmap-index"], `${tag}\n^${have}\n`);
    expect(native).toBeGreaterThan(1);
    expect(await ours([tag], [have])).toBe(native);
    // a have in the pack: the bitmap is used, by both
    const packed = git(dir, ["rev-parse", "HEAD~1"]).trim();
    expect(await ours([tag], [packed])).toBe(
      nativeCount(["--use-bitmap-index"], `${tag}\n^${packed}\n`),
    );
  });
});
