/**
 * `git.repack()` against native `git repack`: each scenario builds a repository with native git,
 * copies it (`cp -a`), runs native `git repack <args>` in one copy and our `RepackCommand` with
 * the same options in the other, and compares the packs by their objects (with their `.rev`,
 * `.bitmap`, `.keep` files), the loose objects, the multi-pack-index's packs, `info/refs` and
 * `objects/info/packs` (`gcSnapshot`), and git's stdout. Native `git fsck --strict` and
 * `git verify-pack` must accept ours. Pack bytes are never compared (delta choices may
 * differ), except where a scenario checks which object is a delta of which (delta islands,
 * the `delta` attribute): there both sides must choose alike. Scenarios come from git's
 * t7700-repack, t7701-repack-unpack-unreachable, t7703-repack-geometric, t5320-delta-islands
 * and t5300-pack-object, each named by its source.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepackCommand, RepackCommandResult } from "../src/commands/repack-command.js";
import {
  bareEnv,
  copyTwin,
  fsck,
  type GcSnapshot,
  gcEnv,
  gcSnapshot,
  initRepo,
  type NativeRepo,
  newCase,
  openOursGc,
  verifyAuxiliaries,
} from "./gc-native-twins-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;

/** The ids of a pack index (`git show-index`), sorted. */
function idxIds(idx: string): string[] {
  const r = spawnSync("git", ["show-index"], { input: readFileSync(idx) });
  return r.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ")[1] as string)
    .sort();
}

/** The packs a multi-pack-index names (its PNAM chunk), each as its sorted object ids. */
function midxPacks(gitDir: string): string[][] | null {
  const packDir = join(gitDir, "objects", "pack");
  const path = join(packDir, "multi-pack-index");
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  const chunks = bytes[6] as number;
  for (let i = 0; i < chunks; i++) {
    const at = 12 + i * 12;
    if (bytes.toString("latin1", at, at + 4) !== "PNAM") continue;
    const start = Number(bytes.readBigUInt64BE(at + 4));
    const end = Number(bytes.readBigUInt64BE(at + 16));
    const names = bytes
      .toString("latin1", start, end)
      .split("\0")
      .filter((n) => n.length > 0);
    return names
      .map((n) => idxIds(join(packDir, n)))
      .sort((a, b) => `${a[0]}`.localeCompare(`${b[0]}`));
  }
  return [];
}

interface RepackTwinResult {
  native: GcSnapshot;
  ours: GcSnapshot;
  result: RepackCommandResult;
  twins: { native: string; ours: string };
}

/**
 * Runs native `git repack <args>` and ours in twins of `<caseDir>/src` and compares them (see
 * the module comment). `env` goes to both sides.
 */
async function repackTwins(
  caseDir: string,
  args: string[],
  ours: (c: RepackCommand) => RepackCommand,
  env: Record<string, string> = {},
  normalize: (s: GcSnapshot) => GcSnapshot = (s) => s,
): Promise<RepackTwinResult> {
  const native = copyTwin(caseDir, "native");
  const oursDir = copyTwin(caseDir, "ours");
  const repo = "repo";
  const gitDirOf = (twin: string) =>
    existsSync(join(twin, repo, ".git")) ? join(twin, repo, ".git") : join(twin, repo);
  const theirs = spawnSync("git", ["repack", ...args], {
    cwd: join(native, repo),
    env: gcEnv(root, { ...bareEnv(join(native, repo)), ...env }),
  });
  expect(theirs.status, `native repack: ${theirs.stderr}`).toBe(0);
  const git = await openOursGc(root, oursDir, repo, env);
  const result = await ours(git.repack()).call();
  // packs in a stable order (two packs may start with the same id)
  const sorted = (s: GcSnapshot): GcSnapshot => ({
    ...s,
    packs: [...s.packs].sort((x, y) =>
      `${x.kind} ${x.ids.join(",")}`.localeCompare(`${y.kind} ${y.ids.join(",")}`),
    ),
  });
  const a = {
    ...sorted(normalize(gcSnapshot(gitDirOf(native), native))),
    midx: midxPacks(gitDirOf(native)),
  };
  const b = {
    ...sorted(normalize(gcSnapshot(gitDirOf(oursDir), oursDir))),
    midx: midxPacks(gitDirOf(oursDir)),
  };
  expect(b).toEqual(a);
  expect(result.output).toEqual(theirs.stdout.toString().split("\n").filter(Boolean));
  // native fsck --strict and verify-pack accept ours
  const ok = fsck(root, join(oursDir, repo));
  expect(ok.status, ok.out).toBe(0);
  const packDir = join(gitDirOf(oursDir), "objects", "pack");
  for (const name of existsSync(packDir) ? readdirSync(packDir) : []) {
    if (!name.endsWith(".idx")) continue;
    const v = spawnSync("git", ["verify-pack", join(packDir, name)], {
      cwd: join(oursDir, repo),
      env: gcEnv(root),
    });
    expect(v.status, `verify-pack ${name}: ${v.stderr}`).toBe(0);
  }
  if (a.midx) {
    const v = spawnSync("git", ["multi-pack-index", "verify", "--no-progress"], {
      cwd: join(oursDir, repo),
      env: gcEnv(root),
    });
    expect(v.status, `multi-pack-index verify: ${v.stderr}`).toBe(0);
  }
  expect(verifyAuxiliaries(root, join(oursDir, repo), gitDirOf(oursDir))).toEqual(
    verifyAuxiliaries(root, join(native, repo), gitDirOf(native)),
  );
  return { native: a, ours: b, result, twins: { native, ours: oursDir } };
}

/**
 * Leaves `objects/info/packs` out: after a repack that writes a multi-pack-index and removes
 * packs, native update-server-info still lists the removed packs (its pack list was loaded
 * before they went), ours lists the packs there are.
 */
const withoutInfoPacks = (s: GcSnapshot): GcSnapshot => ({
  ...s,
  infoFiles: s.infoFiles.filter((l) => !l.startsWith("objects/info/packs")),
});

/** git's `test_commit_bulk --start=<start> <n>`: n commits of `<n>.t` written by fast-import. */
function commitBulk(r: NativeRepo, start: number, n: number) {
  const has = spawnSync("git", ["rev-parse", "--quiet", "--verify", "refs/heads/main"], {
    cwd: r.dir,
    env: gcEnv(root),
  });
  let from = has.status === 0;
  let stream = "";
  for (let i = start; i < start + n; i++) {
    stream += "commit refs/heads/main\n";
    stream += `author A U Thor <author@example.com> ${1700000000 + i} +0000\n`;
    stream += `committer C O Mitter <committer@example.com> ${1700000000 + i} +0000\n`;
    stream += `data <<EOF\ncommit ${i}\nEOF\n`;
    if (from) {
      stream += "from refs/heads/main^0\n";
      from = false;
    }
    stream += `M 644 inline ${i}.t\ndata <<EOF\ncontent ${i}\nEOF\n\n`;
  }
  r.git(["-c", "fastimport.unpacklimit=0", "fast-import", "--quiet"], { input: stream });
  r.git(["read-tree", "refs/heads/main"]);
}

/** A history on main with a tag and a branch: three commits, loose objects. */
function history(name: string) {
  const caseDir = newCase(root, name);
  const r = initRepo(root, caseDir);
  r.commit("one", { "a.txt": "a\n", "dir/b.txt": "b\n" });
  r.commit("two", { "a.txt": "a2\n" });
  r.git(["tag", "-a", "-m", "v1", "v1"]);
  r.git(["branch", "topic"]);
  r.commit("three", { "c.txt": "c\n" });
  return { caseDir, r };
}

describeGit("repack twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "repack-twins-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  describe("modes", () => {
    it("t7700-repack: incremental repack (git repack -d) packs the reachable loose objects", async () => {
      const { caseDir } = history("incremental");
      await repackTwins(caseDir, ["-d"], (c) => c.setDeleteRedundant(true));
    });

    it("t7700-repack: git repack -a without -d keeps the old packs and loose objects", async () => {
      const { caseDir, r } = history("all-no-delete");
      r.git(["repack", "-q"]);
      r.commit("four", { "d.txt": "d\n" });
      await repackTwins(caseDir, ["-a"], (c) => c.setAll(true));
    });

    it("t7700-repack 'objects in packs marked .keep are not repacked'", async () => {
      const { caseDir, r } = history("keep");
      r.git(["repack", "-q", "-d"]);
      const pack = readdirSync(join(r.gitDir, "objects/pack")).find((n) => n.endsWith(".pack"));
      writeFileSync(join(r.gitDir, "objects/pack", (pack as string).replace(/pack$/, "keep")), "");
      r.commit("four", { "d.txt": "d\n" });
      await repackTwins(caseDir, ["-a", "-d"], (c) => c.setAll(true).setDeleteRedundant(true));
    });

    it("t7700-repack 'repack --keep-pack'", async () => {
      const { caseDir, r } = history("keep-pack");
      r.git(["repack", "-q", "-d"]);
      const pack = readdirSync(join(r.gitDir, "objects/pack")).find((n) =>
        n.endsWith(".pack"),
      ) as string;
      r.commit("four", { "d.txt": "d\n" });
      r.git(["repack", "-q", "-d"]);
      await repackTwins(caseDir, ["-a", "-d", `--keep-pack=${pack}`], (c) =>
        c.setAll(true).setDeleteRedundant(true).addKeepPack(pack),
      );
    });

    it("t7700-repack '-n skips updating server info'", async () => {
      const { caseDir } = history("no-server-info");
      await repackTwins(caseDir, ["-a", "-d", "-n"], (c) =>
        c.setAll(true).setDeleteRedundant(true).setUpdateServerInfo(false),
      );
    });

    it("t7700-repack 'repack.updateServerInfo=false skips updating server info'", async () => {
      const { caseDir, r } = history("no-server-info-config");
      r.git(["config", "repack.updateServerInfo", "false"]);
      await repackTwins(caseDir, ["-a", "-d"], (c) => c.setAll(true).setDeleteRedundant(true));
    });

    it("t7700-repack '--write-midx with -d'", async () => {
      const { caseDir, r } = history("midx-d");
      r.git(["repack", "-q", "-d"]);
      r.commit("four", { "d.txt": "d\n" });
      await repackTwins(caseDir, ["-a", "-d", "--write-midx"], (c) =>
        c.setAll(true).setDeleteRedundant(true).setWriteMidx(true),
      );
    });

    it("t7700-repack: -A -d loosens the unreachable objects of the replaced packs", async () => {
      const { caseDir, r } = history("loosen");
      r.git(["repack", "-q", "-a", "-d"]);
      r.git(["branch", "-D", "topic"]);
      r.git(["tag", "-d", "v1"]);
      r.git(["reset", "-q", "--hard", "HEAD~1"]);
      r.git(["reflog", "expire", "--expire=all", "--all"]);
      await repackTwins(caseDir, ["-A", "-d"], (c) =>
        c.setLoosenUnreachable(true).setDeleteRedundant(true),
      );
    });
  });

  describe("-k", () => {
    it("t7701-repack-unpack-unreachable 'repack -k keeps unreachable packed objects'", async () => {
      const { caseDir, r } = history("k-packed");
      r.git(["repack", "-q", "-a", "-d"]);
      const id = r.blob("unreachable-packed\n");
      r.git(["pack-objects", "-q", join(r.gitDir, "objects/pack/pack")], { input: `${id}\n` });
      r.git(["prune-packed"]);
      const { ours } = await repackTwins(caseDir, ["-a", "-d", "-k"], (c) =>
        c.setAll(true).setDeleteRedundant(true).setKeepUnreachable(true),
      );
      expect(ours.packs.flatMap((p) => p.ids)).toContain(id);
    });

    it("t7701-repack-unpack-unreachable 'repack -k packs unreachable loose objects'", async () => {
      const { caseDir, r } = history("k-loose");
      r.git(["repack", "-q", "-a", "-d"]);
      const id = r.blob("would-be-deleted-loose\n");
      const { ours } = await repackTwins(caseDir, ["-adk"], (c) =>
        c.setAll(true).setDeleteRedundant(true).setKeepUnreachable(true),
      );
      expect(ours.loose).not.toContain(id);
      expect(ours.packs.flatMap((p) => p.ids)).toContain(id);
    });

    it("t7701-repack-unpack-unreachable 'repack -k packs unreachable loose objects without existing packfiles'", async () => {
      // 2.43 adds --pack-loose-unreachable only when a non-kept pack exists: the object stays
      // loose there (the twin follows the native version)
      const caseDir = newCase(root, "k-no-packs");
      const r = initRepo(root, caseDir);
      r.blob("would-be-deleted-loose\n");
      await repackTwins(caseDir, ["-ad", "--keep-unreachable"], (c) =>
        c.setAll(true).setDeleteRedundant(true).setKeepUnreachable(true),
      );
    });

    it("t7701-repack-unpack-unreachable: -k leaves out what a .keep pack holds", async () => {
      const { caseDir, r } = history("k-keep");
      r.git(["repack", "-q", "-a", "-d"]);
      const pack = readdirSync(join(r.gitDir, "objects/pack")).find((n) =>
        n.endsWith(".pack"),
      ) as string;
      writeFileSync(join(r.gitDir, "objects/pack", pack.replace(/pack$/, "keep")), "");
      const id = r.blob("unreachable-packed\n");
      r.git(["pack-objects", "-q", join(r.gitDir, "objects/pack/pack")], { input: `${id}\n` });
      r.git(["prune-packed"]);
      r.blob("loose-unreachable\n");
      await repackTwins(caseDir, ["-a", "-d", "-k"], (c) =>
        c.setAll(true).setDeleteRedundant(true).setKeepUnreachable(true),
      );
    });
  });

  describe("--geometric", () => {
    it("t7703-repack-geometric '--geometric with no packs'", async () => {
      const caseDir = newCase(root, "geo-none");
      initRepo(root, caseDir);
      const { result } = await repackTwins(caseDir, ["--write-midx", "--geometric", "2"], (c) =>
        c.setWriteMidx(true).setGeometric(2),
      );
      expect(result.output).toEqual(["Nothing new to pack."]);
    });

    it("t7703-repack-geometric '--geometric with one pack'", async () => {
      const caseDir = newCase(root, "geo-one");
      const r = initRepo(root, caseDir);
      r.commit("base", { "base.t": "base\n" });
      r.git(["repack", "-q", "-d"]);
      const { result } = await repackTwins(caseDir, ["--geometric", "2"], (c) => c.setGeometric(2));
      expect(result.output).toEqual(["Nothing new to pack."]);
    });

    it("t7703-repack-geometric '--geometric with an intact progression'", async () => {
      const caseDir = newCase(root, "geo-intact");
      const r = initRepo(root, caseDir);
      commitBulk(r, 1, 1);
      commitBulk(r, 2, 2);
      commitBulk(r, 4, 4);
      await repackTwins(caseDir, ["--geometric", "2", "-d"], (c) =>
        c.setGeometric(2).setDeleteRedundant(true),
      );
    });

    it("t7703-repack-geometric '--geometric with loose objects'", async () => {
      const caseDir = newCase(root, "geo-loose");
      const r = initRepo(root, caseDir);
      commitBulk(r, 1, 1);
      commitBulk(r, 2, 2);
      r.commit("loose", { "loose.t": "loose\n" });
      await repackTwins(caseDir, ["--geometric", "2", "-d"], (c) =>
        c.setGeometric(2).setDeleteRedundant(true),
      );
    });

    it("t7703-repack-geometric '--geometric with small-pack rollup'", async () => {
      const caseDir = newCase(root, "geo-small");
      const r = initRepo(root, caseDir);
      commitBulk(r, 1, 1);
      commitBulk(r, 2, 1);
      commitBulk(r, 3, 4);
      commitBulk(r, 7, 8);
      const { ours } = await repackTwins(caseDir, ["--geometric", "2", "-d"], (c) =>
        c.setGeometric(2).setDeleteRedundant(true),
      );
      expect(ours.packs).toHaveLength(3);
    });

    it("t7703-repack-geometric '--geometric with small- and large-pack rollup'", async () => {
      const caseDir = newCase(root, "geo-small-large");
      const r = initRepo(root, caseDir);
      commitBulk(r, 1, 1);
      commitBulk(r, 2, 1);
      commitBulk(r, 2, 3);
      commitBulk(r, 6, 9);
      const { ours } = await repackTwins(caseDir, ["--geometric", "2", "-d"], (c) =>
        c.setGeometric(2).setDeleteRedundant(true),
      );
      expect(ours.packs).toHaveLength(2);
    });

    it("t7703-repack-geometric '--geometric ignores kept packs'", async () => {
      const caseDir = newCase(root, "geo-kept");
      const r = initRepo(root, caseDir);
      commitBulk(r, 1, 1);
      commitBulk(r, 2, 1);
      const pack = readdirSync(join(r.gitDir, "objects/pack"))
        .filter((n) => n.endsWith(".pack"))
        .sort()[0] as string;
      writeFileSync(join(r.gitDir, "objects/pack", pack.replace(/pack$/, "keep")), "");
      commitBulk(r, 3, 1);
      await repackTwins(caseDir, ["--geometric", "2", "-d"], (c) =>
        c.setGeometric(2).setDeleteRedundant(true),
      );
    });

    it("t7703-repack-geometric '--geometric ignores --keep-pack packs'", async () => {
      const caseDir = newCase(root, "geo-keep-pack");
      const r = initRepo(root, caseDir);
      commitBulk(r, 1, 1);
      const pack = readdirSync(join(r.gitDir, "objects/pack")).find((n) =>
        n.endsWith(".pack"),
      ) as string;
      commitBulk(r, 2, 1);
      await repackTwins(caseDir, ["--geometric", "2", "-d", `--keep-pack=${pack}`], (c) =>
        c.setGeometric(2).setDeleteRedundant(true).addKeepPack(pack),
      );
    });

    it("t7703-repack-geometric '--geometric chooses largest MIDX preferred pack'", async () => {
      const caseDir = newCase(root, "geo-midx");
      const r = initRepo(root, caseDir);
      commitBulk(r, 1, 1);
      commitBulk(r, 2, 1);
      commitBulk(r, 3, 4);
      commitBulk(r, 7, 8);
      await repackTwins(
        caseDir,
        ["--geometric", "2", "-d", "--write-midx"],
        (c) => c.setGeometric(2).setDeleteRedundant(true).setWriteMidx(true),
        {},
        withoutInfoPacks,
      );
    });
  });

  describe("--cruft", () => {
    /** t7704's setup: a reachable commit on main, an unreachable one from a deleted orphan. */
    function cruftRepo(name: string, packFirst: boolean) {
      const caseDir = newCase(root, name);
      const r = initRepo(root, caseDir);
      r.commit("reachable", { "reachable.t": "reachable\n" });
      r.git(["tag", "reachable"]);
      if (packFirst) r.git(["repack", "-q", "-A", "-d"]);
      r.git(["checkout", "-q", "--orphan", "other"]);
      r.commit("cruft", { "cruft.t": "cruft\n" });
      r.git(["tag", "cruft"]);
      if (packFirst) r.git(["repack", "-q", "-d"]);
      r.git(["checkout", "-q", "main"]);
      r.git(["branch", "-D", "other"]);
      r.git(["tag", "-d", "cruft"]);
      r.git(["reflog", "expire", "--all", "--expire=all"]);
      return { caseDir, r };
    }

    it("t7704-repack-cruft 'repack --cruft generates a cruft pack'", async () => {
      const { caseDir } = cruftRepo("cruft", false);
      const { ours } = await repackTwins(caseDir, ["--cruft", "-d"], (c) =>
        c.setCruft(true).setDeleteRedundant(true),
      );
      expect(ours.packs.map((p) => p.kind).sort()).toEqual(["cruft", "pack"]);
    });

    it("t7704-repack-cruft 'cruft packs are not included in geometric repack'", async () => {
      const { caseDir, r } = cruftRepo("cruft-geometric", true);
      r.git(["repack", "-q", "--cruft"]);
      const { ours } = await repackTwins(caseDir, ["--geometric=2", "-d"], (c) =>
        c.setGeometric(2).setDeleteRedundant(true),
      );
      expect(ours.packs.some((p) => p.kind === "cruft")).toBe(true);
    });
  });

  describe("delta islands and the delta attribute", () => {
    /** 10 KiB of pseudo-random bytes of `seed`, then `suffix` (test-tool genrandom's role). */
    function random(seed: string, suffix: string): string {
      let x = 0;
      for (const c of seed) x = (x * 31 + c.charCodeAt(0)) >>> 0;
      let out = "";
      for (let i = 0; i < 10240; i++) {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0;
        out += String.fromCharCode(32 + ((x >>> 16) % 90));
      }
      return `${out}${suffix}\n`;
    }

    /** t5320's `commit`: branch `name` with one file of `seed` content plus `suffix`. */
    function islandCommit(
      r: NativeRepo,
      name: string,
      seed: string,
      suffix: string,
      parent?: string,
    ) {
      const blob = r.blob(random(seed, suffix));
      const tree = r.git(["mktree"], { input: `100644 blob ${blob}\tfile\n` });
      const commit = r.git(["commit-tree", tree, ...(parent ? ["-p", parent] : [])], {
        input: `${seed}-${suffix}\n`,
      });
      r.git(["update-ref", `refs/heads/${name}`, commit]);
      return blob;
    }

    /** The delta base of each id in a twin (`%(deltabase)`). */
    function deltaBases(twin: string, ids: string[]): string[] {
      const r = spawnSync("git", ["cat-file", "--batch-check=%(objectname) %(deltabase)"], {
        cwd: join(twin, "repo"),
        env: gcEnv(root),
        input: `${ids.join("\n")}\n`,
      });
      return r.stdout.toString().trim().split("\n");
    }

    function islands(name: string, config: string[][]) {
      const caseDir = newCase(root, name);
      const r = initRepo(root, caseDir);
      const one = islandCommit(r, "one", "seed", "1");
      const two = islandCommit(r, "two", "seed", "12");
      for (const [k, v] of config) r.git(["config", "--add", k as string, v as string]);
      return { caseDir, r, ids: [one, two] };
    }

    const adfi = (c: RepackCommand) =>
      c.setAll(true).setDeleteRedundant(true).setReuseDeltas(false).setDeltaIslands(true);

    it("t5320-delta-islands 'island repack with no island definition is vanilla'", async () => {
      const { caseDir, ids } = islands("islands-none", []);
      const { twins } = await repackTwins(caseDir, ["-adfi"], adfi);
      const ours = deltaBases(twins.ours, ids);
      expect(ours).toEqual(deltaBases(twins.native, ids));
      expect(ours[0]).toBe(`${ids[0]} ${ids[1]}`);
    });

    it("t5320-delta-islands 'separate islands disallows delta'", async () => {
      const { caseDir, ids } = islands("islands-separate", [["pack.island", "refs/heads/(.*)"]]);
      const { twins } = await repackTwins(caseDir, ["-adfi"], adfi);
      const ours = deltaBases(twins.ours, ids);
      expect(ours).toEqual(deltaBases(twins.native, ids));
      expect(ours.every((l) => l.endsWith(" 0000000000000000000000000000000000000000"))).toBe(true);
    });

    it("t5320-delta-islands 'same island allows delta'", async () => {
      const { caseDir, ids } = islands("islands-same", [["pack.island", "refs/heads"]]);
      const { twins } = await repackTwins(caseDir, ["-adfi"], adfi);
      expect(deltaBases(twins.ours, ids)).toEqual(deltaBases(twins.native, ids));
    });

    it("t5320-delta-islands 'coalesce same-named islands'", async () => {
      const { caseDir, ids } = islands("islands-coalesce", [
        ["pack.island", "refs/(.*)/one"],
        ["pack.island", "refs/(.*)/two"],
      ]);
      const { twins } = await repackTwins(caseDir, ["-adfi"], adfi);
      expect(deltaBases(twins.ours, ids)).toEqual(deltaBases(twins.native, ids));
    });

    it("t5320-delta-islands 'island regexes are left-anchored'", async () => {
      const { caseDir, ids } = islands("islands-anchored", [["pack.island", "heads/(.*)"]]);
      const { twins } = await repackTwins(caseDir, ["-adfi"], adfi);
      expect(deltaBases(twins.ours, ids)).toEqual(deltaBases(twins.native, ids));
    });

    it("t5320-delta-islands 'island regexes follow last-one-wins scheme'", async () => {
      const { caseDir, ids } = islands("islands-last-wins", [
        ["pack.island", "refs/heads/(.*)"],
        ["pack.island", "refs/heads/"],
      ]);
      const { twins } = await repackTwins(caseDir, ["-adfi"], adfi);
      expect(deltaBases(twins.ours, ids)).toEqual(deltaBases(twins.native, ids));
    });

    it("t5320-delta-islands 'island restrictions drop reused deltas'", async () => {
      const { caseDir, r, ids } = islands("islands-reused", []);
      r.git(["repack", "-adfi", "-q"]);
      r.git(["config", "pack.island", "refs/heads/(.*)"]);
      const { twins } = await repackTwins(caseDir, ["-adi"], (c) =>
        c.setAll(true).setDeleteRedundant(true).setDeltaIslands(true),
      );
      const ours = deltaBases(twins.ours, ids);
      expect(ours).toEqual(deltaBases(twins.native, ids));
      expect(ours.every((l) => l.endsWith(" 0000000000000000000000000000000000000000"))).toBe(true);
    });

    it("t5320-delta-islands 'deltas allowed against superset islands'", async () => {
      const caseDir = newCase(root, "islands-superset");
      const r = initRepo(root, caseDir);
      const root0 = islandCommit(r, "root", "shared", "root");
      const rootCommit = r.git(["rev-parse", "refs/heads/root"]);
      const one = islandCommit(r, "one", "shared", "1", rootCommit);
      const two = islandCommit(r, "two", "shared", "12-long", rootCommit);
      r.git(["config", "pack.island", "refs/heads/(.*)"]);
      const { twins } = await repackTwins(caseDir, ["-adfi"], adfi);
      const ids = [root0, one, two];
      expect(deltaBases(twins.ours, ids)).toEqual(deltaBases(twins.native, ids));
    });

    it("t5320-delta-islands 'island core places core objects first'", async () => {
      const caseDir = newCase(root, "islands-core");
      const r = initRepo(root, caseDir);
      const root0 = islandCommit(r, "root", "shared", "root");
      const rootCommit = r.git(["rev-parse", "refs/heads/root"]);
      islandCommit(r, "one", "shared", "1", rootCommit);
      const two = islandCommit(r, "two", "shared", "12-long", rootCommit);
      r.git(["config", "pack.island", "refs/heads/(.*)"]);
      r.git(["config", "pack.islandcore", "one"]);
      const { twins } = await repackTwins(caseDir, ["-adfi"], adfi);
      const order = (twin: string) => {
        const dir = join(twin, "repo/.git/objects/pack");
        const idx = readdirSync(dir).find((n) => n.endsWith(".idx")) as string;
        const v = spawnSync("git", ["verify-pack", "-v", join(dir, idx)], { env: gcEnv(root) });
        return v.stdout
          .toString()
          .split("\n")
          .map((l) => l.split(" ")[0])
          .filter((id) => id === root0 || id === two);
      };
      expect(order(twins.ours)).toEqual([root0, two]);
      expect(order(twins.ours)).toEqual(order(twins.native));
    });

    it("t5320-delta-islands 'unmatched island core is not fatal'", async () => {
      const { caseDir } = islands("islands-core-unmatched", [["pack.islandcore", "one"]]);
      await repackTwins(caseDir, ["-adfi"], adfi);
    });

    it("t5300-pack-object: the delta attribute unset keeps a path's blobs whole", async () => {
      const caseDir = newCase(root, "delta-attribute");
      const r = initRepo(root, caseDir);
      const big = (n: number) =>
        `${Array.from({ length: 400 }, (_, i) => `line ${i} of a long file ${i % 7}`).join("\n")}\n${n}\n`;
      r.commit("one", { ".gitattributes": "*.bin -delta\n", "a.bin": big(1), "a.txt": big(1) });
      r.commit("two", { "a.bin": big(2), "a.txt": big(2) });
      r.commit("three", { "a.bin": big(3), "a.txt": big(3) });
      const ids = [1, 2, 3].map((n) => r.blob(big(n)));
      const { twins } = await repackTwins(caseDir, ["-a", "-d", "-f"], (c) =>
        c.setAll(true).setDeleteRedundant(true).setReuseDeltas(false),
      );
      // a.txt and a.bin share their blobs: the first path met (a.bin) decides
      expect(deltaBases(twins.ours, ids)).toEqual(deltaBases(twins.native, ids));
    });

    it("t5300-pack-object: a path whose delta attribute is unset is not a delta, others are", async () => {
      const caseDir = newCase(root, "delta-attribute-txt");
      const r = initRepo(root, caseDir);
      const big = (n: number, s: string) =>
        `${Array.from({ length: 400 }, (_, i) => `${s} line ${i} of a long file ${i % 7}`).join("\n")}\n${n}\n`;
      r.commit("one", {
        ".gitattributes": "*.bin -delta\n",
        "a.bin": big(1, "b"),
        "a.txt": big(1, "t"),
      });
      r.commit("two", { "a.bin": big(2, "b"), "a.txt": big(2, "t") });
      const ids = [1, 2].flatMap((n) => [r.blob(big(n, "b")), r.blob(big(n, "t"))]);
      const { twins } = await repackTwins(caseDir, ["-a", "-d", "-f"], (c) =>
        c.setAll(true).setDeleteRedundant(true).setReuseDeltas(false),
      );
      const ours = deltaBases(twins.ours, ids);
      expect(ours).toEqual(deltaBases(twins.native, ids));
      // the .bin blobs are whole, one .txt blob is a delta of the other
      const zero = " 0000000000000000000000000000000000000000";
      expect(ours[0]?.endsWith(zero) && ours[2]?.endsWith(zero)).toBe(true);
      expect([ours[1], ours[3]].some((l) => !l?.endsWith(zero))).toBe(true);
    });
  });
});
