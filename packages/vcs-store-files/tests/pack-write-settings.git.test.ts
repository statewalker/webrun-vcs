/**
 * The `pack.*` keys repack and gc read (pack-objects' `git_pack_config`): `pack.window`,
 * `pack.depth`, `pack.windowMemory`, `pack.deltaCacheSize`, `pack.compression` /
 * `core.compression`, `pack.packSizeLimit`. The values reach the delta search and the
 * deflate level; native git's `verify-pack -v` reads what ours wrote under the same keys.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import {
  createGitFilesBackend,
  gc,
  PackConfigError,
  packDeltaSearch,
  readPackWriteSettings,
  repack,
} from "../src/index.js";

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

/** `n` commits each editing one line of three large files: long delta chains to find. */
function repo(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-settings-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i}: lorem ipsum dolor sit amet`);
  for (let c = 0; c < n; c++) {
    for (let f = 0; f < 3; f++) {
      lines[(c * 7 + f) % lines.length] = `edited ${c} ${f}`;
      writeFileSync(join(dir, `file${f}.txt`), `${lines.join("\n")}\n`);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", `commit ${c}`]);
  }
  return dir;
}

const packDir = (dir: string) => join(dir, ".git/objects/pack");
const onlyPack = (dir: string, ext: string) => {
  const found = readdirSync(packDir(dir)).filter((f) => f.endsWith(ext));
  expect(found.length).toBe(1);
  return join(packDir(dir), found[0] as string);
};
const backend = (dir: string) =>
  createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });

/** The longest delta chain and the number of deltas native `verify-pack -v` reports. */
function chains(dir: string): { deltas: number; longest: number } {
  const out = git(dir, ["verify-pack", "-v", onlyPack(dir, ".idx")]);
  let deltas = 0;
  let longest = 0;
  for (const m of out.matchAll(/^chain length = (\d+): (\d+) objects?$/gm)) {
    deltas += Number(m[2]);
    longest = Math.max(longest, Number(m[1]));
  }
  return { deltas, longest };
}

describe("pack.* settings of repack and gc", () => {
  it("reads every key, with git's defaults left to the writer when unset", async () => {
    const dir = repo(1);
    const files = createNodeFilesApi({ rootDir: dir });
    expect(await readPackWriteSettings(files)).toEqual({ writeReverseIndex: true });
    git(dir, ["config", "pack.window", "3"]);
    git(dir, ["config", "pack.depth", "5000"]);
    git(dir, ["config", "pack.windowMemory", "1m"]);
    git(dir, ["config", "pack.deltaCacheSize", "0"]);
    git(dir, ["config", "pack.packSizeLimit", "2g"]);
    git(dir, ["config", "core.compression", "3"]);
    const settings = await readPackWriteSettings(files);
    expect(settings).toEqual({
      writeReverseIndex: true,
      window: 3,
      // git: "delta chain depth 5000 is too deep, forcing 4095"
      depth: 4095,
      windowMemory: 1024 * 1024,
      deltaCacheSize: 0,
      packSizeLimit: 2 * 1024 ** 3,
      compression: 3,
    });
    expect(packDeltaSearch(settings, undefined)).toEqual({
      window: 3,
      depth: 4095,
      windowMemory: 1024 * 1024,
      deltaCacheSize: Number.POSITIVE_INFINITY,
    });
    // an explicit option wins over the config; false stays off
    expect(packDeltaSearch(settings, { depth: 7 })).toMatchObject({ window: 3, depth: 7 });
    expect(packDeltaSearch(settings, false)).toBe(false);
    // pack.compression wins over core.compression, whatever their order
    git(dir, ["config", "pack.compression", "9"]);
    expect((await readPackWriteSettings(files)).compression).toBe(9);
    git(dir, ["config", "pack.compression", "12"]);
    await expect(readPackWriteSettings(files)).rejects.toThrow(PackConfigError);
    git(dir, ["config", "pack.compression", "1"]);
    git(dir, ["config", "pack.window", "ten"]);
    await expect(readPackWriteSettings(files)).rejects.toThrow(
      "bad numeric config value 'ten' for 'pack.window'",
    );
  });

  it("pack.depth bounds the chains of repack -f as native git's (t5316 style)", async () => {
    const dir = repo(12);
    git(dir, ["config", "pack.depth", "2"]);
    const native = mkdtempSync(join(tmpdir(), "pack-settings-native-"));
    dirs.push(native);
    git(native, ["clone", "-q", "--no-local", dir, "."]);
    git(native, ["config", "pack.depth", "2"]);
    git(native, ["repack", "-adfq"]);
    const theirs = chains(native);
    expect(theirs.longest).toBeLessThanOrEqual(2);

    await repack({ ...(await backend(dir)), reuseDeltas: false });
    const ours = chains(dir);
    expect(ours.deltas).toBeGreaterThan(0);
    expect(ours.longest).toBeLessThanOrEqual(2);
    git(dir, ["fsck", "--full", "--no-progress"]);

    // without the key the chains grow longer (default 50)
    git(dir, ["config", "--unset", "pack.depth"]);
    await repack({ ...(await backend(dir)), reuseDeltas: false });
    expect(chains(dir).longest).toBeGreaterThan(2);
  });

  it("pack.window=0 searches no deltas; gc reads it too", async () => {
    const dir = repo(6);
    git(dir, ["config", "pack.window", "0"]);
    const b = await backend(dir);
    await repack({ ...b, reuseDeltas: false });
    expect(chains(dir).deltas).toBe(0);
    git(dir, ["commit", "-q", "--allow-empty", "-m", "more"]);
    await gc({ history: b.history, files: b.files, pruneExpireMs: 0, expireReflogs: false });
    // gc's repack reuses nothing it can recompute here: still no delta (the stored entries
    // are whole objects)
    expect(chains(dir).deltas).toBe(0);
  });

  it("pack.compression sets the zlib level of the entries written", async () => {
    const dir = repo(4);
    const sizeAt = async (level: string) => {
      git(dir, ["config", "pack.compression", level]);
      await repack({ ...(await backend(dir)), reuseObjects: false, reuseDeltas: false });
      git(dir, ["fsck", "--full", "--no-progress"]);
      return statSync(onlyPack(dir, ".pack")).size;
    };
    const stored = await sizeAt("0");
    const best = await sizeAt("9");
    expect(stored).toBeGreaterThan(best * 2);
    // core.compression alone applies to packs too
    git(dir, ["config", "--unset", "pack.compression"]);
    git(dir, ["config", "core.compression", "0"]);
    await repack({ ...(await backend(dir)), reuseObjects: false, reuseDeltas: false });
    expect(statSync(onlyPack(dir, ".pack")).size).toBe(stored);
  });
});
