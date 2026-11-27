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
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEOMETRIC_PROMISOR_REMOTE_2_43 } from "@statewalker/vcs-store-files";
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
  NativeRepo,
  newCase,
  openOursGc,
  verifyAuxiliaries,
} from "./gc-native-twins-support.js";
import { nativeIs25x } from "./hooks-native-support.js";
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
  /** native git's stderr */
  stderr: string;
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
  return {
    native: a,
    ours: b,
    result,
    twins: { native, ours: oursDir },
    stderr: theirs.stderr.toString(),
  };
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

  describe("options", () => {
    it("t7701-repack-unpack-unreachable '-A with -d option leaves unreachable objects unpacked' (as -a -d --unpack-unreachable=<date>)", async () => {
      const { caseDir, r } = history("unpack-date");
      r.git(["repack", "-q", "-a", "-d"]);
      r.git(["branch", "-D", "topic"]);
      r.git(["tag", "-d", "v1"]);
      r.git(["reset", "-q", "--hard", "HEAD~1"]);
      r.git(["reflog", "expire", "--expire=all", "--all"]);
      const { ours } = await repackTwins(
        caseDir,
        ["-a", "-d", "--unpack-unreachable=1.week.ago"],
        (c) => c.setAll(true).setDeleteRedundant(true).setUnpackUnreachable("1.week.ago"),
      );
      expect(ours.loose.length).toBeGreaterThan(0);
    });

    it("t7701-repack-unpack-unreachable 'do not bother loosening old objects'", async () => {
      // as git's test: no commit, nothing reachable; git writes no pack but still removes the
      // old ones (statewalker/webrun-vcs#389)
      const caseDir = newCase(root, "unpack-old-pack");
      const r = initRepo(root, caseDir);
      const obj1 = r.blob("one\n");
      const obj2 = r.blob("two\n");
      const pack1 = r.git(["pack-objects", join(r.gitDir, "objects/pack/pack")], {
        input: `${obj1}\n`,
      });
      const pack2 = r.git(["pack-objects", join(r.gitDir, "objects/pack/pack")], {
        input: `${obj2}\n`,
      });
      r.git(["prune-packed"]);
      expect(pack1).not.toEqual(pack2);
      // test-tool chmtime =-86400
      const day = Date.now() / 1000 - 86400;
      utimesSync(join(r.gitDir, `objects/pack/pack-${pack2.trim()}.pack`), day, day);
      const { ours } = await repackTwins(
        caseDir,
        ["-A", "-d", "--unpack-unreachable=1.hour.ago"],
        (c) =>
          c.setLoosenUnreachable(true).setDeleteRedundant(true).setUnpackUnreachable("1.hour.ago"),
      );
      expect(ours.loose).toContain(obj1);
      expect(ours.loose).not.toContain(obj2);
    });

    /** statewalker/webrun-vcs#389: a repository without commits whose packs hold only unreachable blobs */
    function unreachablePacks(name: string) {
      const caseDir = newCase(root, name);
      const r = initRepo(root, caseDir);
      const obj1 = r.blob("one\n");
      const obj2 = r.blob("two\n");
      r.git(["pack-objects", join(r.gitDir, "objects/pack/pack")], { input: `${obj1}\n` });
      r.git(["pack-objects", join(r.gitDir, "objects/pack/pack")], { input: `${obj2}\n` });
      r.git(["prune-packed"]);
      return { caseDir, r, obj1, obj2 };
    }

    it("repack -a -d with nothing reachable removes every pack and drops their objects (statewalker/webrun-vcs#389)", async () => {
      const { caseDir } = unreachablePacks("nothing-reachable-ad");
      const { native, ours, result } = await repackTwins(caseDir, ["-a", "-d"], (c) =>
        c.setAll(true).setDeleteRedundant(true),
      );
      expect(native.packs).toEqual([]);
      expect(ours.loose).toEqual([]);
      expect(result.output).toEqual(["Nothing new to pack."]);
    });

    it("repack -a -d --write-midx with nothing reachable removes every pack and writes no midx (statewalker/webrun-vcs#389)", async () => {
      const { caseDir, r } = unreachablePacks("nothing-reachable-midx");
      r.git(["multi-pack-index", "write"]);
      const { native, twins } = await repackTwins(caseDir, ["-a", "-d", "--write-midx"], (c) =>
        c.setAll(true).setDeleteRedundant(true).setWriteMidx(true),
      );
      expect(native.packs).toEqual([]);
      // repackTwins compares both midxes; git's is gone
      expect(midxPacks(join(twins.native, "repo", ".git"))).toBeNull();
    });

    it("repack --cruft -d with nothing reachable moves the old packs into a cruft pack (statewalker/webrun-vcs#389)", async () => {
      const { caseDir } = unreachablePacks("nothing-reachable-cruft");
      const { ours } = await repackTwins(caseDir, ["--cruft", "-d"], (c) =>
        c.setCruft(true).setDeleteRedundant(true),
      );
      expect(ours.packs.map((p) => p.kind)).toEqual(["cruft"]);
    });

    it("repack -d with nothing new still prunes loose objects already packed (statewalker/webrun-vcs#389)", async () => {
      const { caseDir, r } = unreachablePacks("nothing-new-prune-packed");
      // a third blob packed but left loose too (no prune-packed after its pack)
      const obj3 = r.blob("three\n");
      r.git(["pack-objects", join(r.gitDir, "objects/pack/pack")], { input: `${obj3}\n` });
      const { native, ours } = await repackTwins(caseDir, ["-d"], (c) =>
        c.setAll(false).setDeleteRedundant(true),
      );
      expect(native.loose).toEqual([]);
      expect(ours.packs.length).toBe(3);
    });

    it("t7701-repack-unpack-unreachable: a pack exactly as old as the cutoff is not loosened (git keeps mtime > expiration)", async () => {
      const caseDir = newCase(root, "unpack-at-cutoff");
      const r = initRepo(root, caseDir);
      r.commit("base", { "a.txt": "a\n" });
      const obj = r.blob("at the cutoff\n");
      const pack = r.git(["pack-objects", join(r.gitDir, "objects/pack/pack")], {
        input: `${obj}\n`,
      });
      r.git(["prune-packed"]);
      const cutoff = Math.floor(Date.now() / 1000) - 3 * 86400;
      // half a second past the cutoff: still the cutoff's second, which git compares
      const at = cutoff + 0.5;
      utimesSync(join(r.gitDir, `objects/pack/pack-${pack.trim()}.pack`), at, at);
      const { ours } = await repackTwins(
        caseDir,
        ["-A", "-d", `--unpack-unreachable=@${cutoff}`],
        (c) =>
          c.setLoosenUnreachable(true).setDeleteRedundant(true).setUnpackUnreachable(`@${cutoff}`),
      );
      expect(ours.loose).not.toContain(obj);
    });

    /**
     * statewalker/webrun-vcs#348: an old pack's unreachable tree that a recent unreachable
     * commit names is loosened (pack-objects' recent_objects), loose or packed young.
     */
    for (const where of ["loose", "young pack"] as const) {
      it(`t7701-repack-unpack-unreachable: an expired pack keeps what a recent unreachable commit (${where}) reaches`, async () => {
        const { caseDir, r } = history(`unpack-recent-${where.replace(" ", "-")}`);
        r.git(["repack", "-q", "-a", "-d"]);
        // tree T (and its blob) only in a three-week-old pack
        const blob = r.blob("only under T\n");
        const tree = r.git(["mktree"], { input: `100644 blob ${blob}\tt.txt\n` }).trim();
        const old = r
          .git(["pack-objects", join(r.gitDir, "objects/pack/pack")], {
            input: `${tree}\n${blob}\n`,
          })
          .trim();
        r.git(["prune-packed"]);
        const weeks3 = Date.now() / 1000 - 21 * 86400;
        utimesSync(join(r.gitDir, `objects/pack/pack-${old}.pack`), weeks3, weeks3);
        // commit C, unreachable, two days old, names T
        const commit = r.git(["commit-tree", tree, "-p", "HEAD", "-m", "recent"]).trim();
        const days2 = Date.now() / 1000 - 2 * 86400;
        if (where === "loose") {
          utimesSync(join(r.gitDir, "objects", commit.slice(0, 2), commit.slice(2)), days2, days2);
        } else {
          const young = r
            .git(["pack-objects", join(r.gitDir, "objects/pack/pack")], { input: `${commit}\n` })
            .trim();
          r.git(["prune-packed"]);
          utimesSync(join(r.gitDir, `objects/pack/pack-${young}.pack`), days2, days2);
        }
        const { ours } = await repackTwins(
          caseDir,
          ["-a", "-d", "--unpack-unreachable=2.weeks.ago"],
          (c) => c.setAll(true).setDeleteRedundant(true).setUnpackUnreachable("2.weeks.ago"),
        );
        expect(ours.loose).toContain(tree);
        expect(ours.loose).toContain(blob);
        expect(ours.loose).toContain(commit);
      });
    }

    it("t7700-repack 'repacking with a filter works' (without -a: an incremental pack, then write_filtered_pack of every existing pack)", async () => {
      const { caseDir, r } = history("filter-incremental");
      // two packs: the filtered pack (both of them) is none of the old ones (git would rewrite
      // an old pack in place, by its bytes)
      r.git(["repack", "-q", "-a", "-d"]);
      r.commit("four", { "d.txt": "d\n" });
      r.git(["repack", "-q", "-d"]);
      r.commit("five", { "e.txt": "e\n", "a.txt": "a5\n" });
      const { ours } = await repackTwins(caseDir, ["-d", "--filter=blob:none"], (c) =>
        c.setDeleteRedundant(true).setFilter("blob:none"),
      );
      expect(ours.packs).toHaveLength(4);
    });

    it("t7703-repack-geometric: --geometric=0 is no geometric repack", async () => {
      const { caseDir, r } = history("geo-zero");
      r.blob("unreachable\n");
      await repackTwins(caseDir, ["--geometric=0", "-d"], (c) =>
        c.setGeometric(0).setDeleteRedundant(true),
      );
    });

    it("t7701-repack-unpack-unreachable: -k and --unpack-unreachable cannot be used together", async () => {
      const { caseDir } = history("k-unpack");
      const git = await openOursGc(root, join(caseDir, "src"));
      const native = spawnSync("git", ["repack", "-a", "-d", "-k", "--unpack-unreachable=now"], {
        cwd: join(caseDir, "src/repo"),
        env: gcEnv(root),
      });
      expect(native.status).toBe(128);
      await expect(
        git
          .repack()
          .setAll(true)
          .setDeleteRedundant(true)
          .setKeepUnreachable(true)
          .setUnpackUnreachable("now")
          .call(),
      ).rejects.toThrow(native.stderr.toString().trim());
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

    it("t7703-repack-geometric '--geometric ignores --keep-pack packs' (with --pack-kept-objects, git still passes --keep-pack=)", async () => {
      const caseDir = newCase(root, "geo-keep-pack-kept-objects");
      const r = initRepo(root, caseDir);
      commitBulk(r, 1, 1);
      const pack = readdirSync(join(r.gitDir, "objects/pack")).find((n) =>
        n.endsWith(".pack"),
      ) as string;
      commitBulk(r, 2, 1);
      await repackTwins(
        caseDir,
        ["--geometric", "2", "-d", "--pack-kept-objects", `--keep-pack=${pack}`],
        (c) =>
          c.setGeometric(2).setDeleteRedundant(true).setPackKeptObjects(true).addKeepPack(pack),
      );
    });

    for (const bitmap of [true, false]) {
      it(`t7703-repack-geometric '--geometric -l disables writing bitmaps with non-local packfiles'${bitmap ? "" : " (without -b: git's write_bitmaps is -1, true, with --write-midx)"}`, async () => {
        const caseDir = newCase(root, `geo-local-bitmap-${bitmap}`);
        const shared = initRepo(root, caseDir, false, "shared");
        commitBulk(shared, 1, 1);
        shared.git(["clone", "-q", "--shared", "shared", "repo"], { cwd: join(caseDir, "src") });
        const r = new NativeRepo(root, join(caseDir, "src", "repo"));
        commitBulk(r, 2, 1);
        const args = [
          "-l",
          "--geometric=2",
          "--write-midx",
          ...(bitmap ? ["--write-bitmap-index"] : []),
        ];
        const { result, stderr, twins } = await repackTwins(
          caseDir,
          args,
          (c) => {
            const set = c.setLocal(true).setGeometric(2).setWriteMidx(true);
            return bitmap ? set.setWriteBitmaps(true) : set;
          },
          {},
          withoutInfoPacks,
        );
        const warning = "warning: disabling bitmap writing, as some objects are not being packed";
        expect(stderr.split("\n").filter(Boolean)).toEqual([warning]);
        expect(result.warnings).toEqual([warning]);
        const pack = join(twins.ours, "repo/.git/objects/pack");
        expect(readdirSync(pack).some((n) => n.endsWith(".bitmap"))).toBe(false);
      });
    }

    /** t7703's write_packfile: `n` blobs `<prefix> <i>` (fast-import), packed and dated `at`. */
    function writePackfile(r: NativeRepo, n: number, prefix: string, at: number, promisor = false) {
      let stream = "";
      for (let i = 1; i <= n; i++) stream += `blob\ndata <<EOB\n${prefix} ${i}\nEOB\n`;
      r.git(["fast-import", "--quiet"], { input: stream });
      const id = r.git(
        ["pack-objects", "-q", "--pack-loose-unreachable", join(r.gitDir, "objects/pack/pack")],
        {
          input: "",
        },
      );
      r.git(["prune-packed"]);
      const base = join(r.gitDir, "objects/pack", `pack-${id}`);
      if (promisor) writeFileSync(`${base}.promisor`, "");
      for (const ext of ["pack", "idx", "rev", "promisor"])
        if (existsSync(`${base}.${ext}`)) utimesSync(`${base}.${ext}`, at, at);
      return id;
    }

    /** t7703's packs: three normal ones (2, 2, 14 blobs), five promisor ones (1, 3, 3, 20, 40). */
    function promisorPacks(name: string, remote: boolean) {
      const caseDir = newCase(root, name);
      const r = initRepo(root, caseDir);
      if (remote) {
        r.git(["remote", "add", "promisor", "garbage"]);
        r.git(["config", "remote.promisor.promisor", "true"]);
      }
      let at = 1700000000;
      for (const [n, p] of [
        [2, "normal-a"],
        [2, "normal-b"],
        [14, "normal-c"],
      ] as const) {
        at += 10;
        writePackfile(r, n, p, at);
      }
      for (const [n, p] of [
        [1, "promisor-a"],
        [3, "promisor-b"],
        [3, "promisor-c"],
        [20, "promisor-d"],
        [40, "promisor-e"],
      ] as const) {
        at += 10;
        writePackfile(r, n, p, at, true);
      }
      return { caseDir, r };
    }

    it("t7703-repack-geometric 'geometric repack works with promisor packs'", async () => {
      const { caseDir } = promisorPacks("geo-promisor", true);
      if (!nativeIs25x) {
        // 2.43's pack-objects refuses --exclude-promisor-objects with --stdin-packs
        const native = copyTwin(caseDir, "native");
        const theirs = spawnSync("git", ["repack", "--geometric=2", "-d"], {
          cwd: join(native, "repo"),
          env: gcEnv(root),
        });
        expect(theirs.status).toBe(128);
        expect(theirs.stderr.toString()).toContain(GEOMETRIC_PROMISOR_REMOTE_2_43);
        const oursDir = copyTwin(caseDir, "ours");
        const git = await openOursGc(root, oursDir);
        await expect(git.repack().setGeometric(2).setDeleteRedundant(true).call()).rejects.toThrow(
          GEOMETRIC_PROMISOR_REMOTE_2_43,
        );
        expect(gcSnapshot(join(oursDir, "repo/.git"), oursDir).packs).toEqual(
          gcSnapshot(join(native, "repo/.git"), native).packs,
        );
        return;
      }
      const { ours } = await repackTwins(caseDir, ["--geometric=2", "-d"], (c) =>
        c.setGeometric(2).setDeleteRedundant(true),
      );
      expect(ours.packs).toHaveLength(5);
      expect(ours.packs.filter((p) => p.kind === "promisor")).toHaveLength(3);
    });

    it("t7703-repack-geometric 'geometric repack works with promisor packs' (no promisor remote: 2.43 rolls them up with the rest)", async () => {
      const { caseDir } = promisorPacks("geo-promisor-no-remote", false);
      const { ours } = await repackTwins(caseDir, ["--geometric=2", "-d"], (c) =>
        c.setGeometric(2).setDeleteRedundant(true),
      );
      expect(ours.packs).toHaveLength(nativeIs25x ? 5 : 1);
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

    it("t7704-repack-cruft 'cruft packs are not included in geometric repack' (its git repack --cruft, without -d)", async () => {
      const { caseDir, r } = cruftRepo("cruft-no-d", true);
      // new objects, reachable and not, so that neither new pack is one of the old ones (git
      // would then rewrite an old pack in place, by its bytes)
      r.commit("more", { "more.t": "more\n" });
      r.blob("dangling\n");
      const { ours } = await repackTwins(caseDir, ["--cruft"], (c) => c.setCruft(true));
      expect(ours.packs.map((p) => p.kind).sort()).toEqual(["cruft", "pack", "pack", "pack"]);
    });

    it("t7704-repack-cruft 'repack --geometric collects once-cruft objects' (its git repack --cruft, without -d: the loose copies stay)", async () => {
      const caseDir = newCase(root, "cruft-no-d-loose");
      const r = initRepo(root, caseDir);
      r.commit("reachable", { "reachable.t": "reachable\n" });
      r.git(["repack", "-q", "-A", "-d"]);
      r.git(["checkout", "-q", "--orphan", "other"]);
      r.git(["rm", "-q", "-rf", "."]);
      r.commit("cruft", { "cruft.t": "cruft\n" });
      r.git(["checkout", "-q", "main"]);
      r.git(["branch", "-D", "other"]);
      r.git(["reflog", "expire", "--all", "--expire=all"]);
      const { ours } = await repackTwins(caseDir, ["--cruft"], (c) => c.setCruft(true));
      expect(ours.loose.length).toBeGreaterThan(0);
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

  describe("repack.midxMustContainCruft (--stdin-packs=follow)", () => {
    const bitmapMidx = ["-d", "--geometric=2", "--write-midx", "--write-bitmap-index"];
    const ourBitmapMidx = (c: RepackCommand) =>
      c.setDeleteRedundant(true).setGeometric(2).setWriteMidx(true).setWriteBitmaps(true);
    /** The kinds of the packs a twin's midx names (`cruft` or `pack`), sorted. */
    function midxKinds(twin: string): string[] {
      const packDir = join(twin, "repo/.git/objects/pack");
      const bytes = readFileSync(join(packDir, "multi-pack-index"));
      const chunks = bytes[6] as number;
      for (let i = 0; i < chunks; i++) {
        const at = 12 + i * 12;
        if (bytes.toString("latin1", at, at + 4) !== "PNAM") continue;
        const start = Number(bytes.readBigUInt64BE(at + 4));
        const end = Number(bytes.readBigUInt64BE(at + 16));
        return bytes
          .toString("latin1", start, end)
          .split("\0")
          .filter(Boolean)
          .map((n) => (existsSync(join(packDir, n.replace(/idx$/, "mtimes"))) ? "cruft" : "pack"))
          .sort();
      }
      return [];
    }

    /** t7704's setup_cruft_exclude_tests: `two` is cruft, then reachable again under `four`. */
    function cruftExcludeRepo(name: string, mustContainCruft = false) {
      const caseDir = newCase(root, name);
      const r = initRepo(root, caseDir);
      r.git(["config", "repack.midxMustContainCruft", String(mustContainCruft)]);
      r.commit("one", { "one.t": "one\n" });
      r.git(["tag", "one"]);
      const two = r.commit("two", { "two.t": "two\n" });
      r.commit("three", { "three.t": "three\n" });
      r.git(["reset", "-q", "--hard", "one"]);
      r.git(["reflog", "expire", "--all", "--expire=all"]);
      r.git(["repack", "-q", "--cruft", "-d"]);
      r.git(["merge", "-q", two]);
      r.commit("four", { "four.t": "four\n" });
      return { caseDir, r };
    }

    it("t7704-repack-cruft 'repack --write-midx excludes cruft where possible'", async () => {
      const { caseDir } = cruftExcludeRepo("follow-exclude");
      const { twins } = await repackTwins(caseDir, bitmapMidx, ourBitmapMidx, {}, withoutInfoPacks);
      // 2.43 has no repack.midxMustContainCruft: the cruft pack stays in its midx
      expect(midxKinds(twins.ours)).toEqual(
        nativeIs25x ? ["pack", "pack"] : ["cruft", "pack", "pack"],
      );
    });

    it("t7704-repack-cruft 'repack --write-midx includes cruft when instructed'", async () => {
      const { caseDir } = cruftExcludeRepo("follow-instructed", true);
      const { twins } = await repackTwins(caseDir, bitmapMidx, ourBitmapMidx, {}, withoutInfoPacks);
      expect(midxKinds(twins.ours)).toEqual(["cruft", "pack", "pack"]);
    });

    it("t7704-repack-cruft 'repack --write-midx includes cruft when necessary'", async () => {
      const { caseDir, r } = cruftExcludeRepo("follow-necessary");
      const packDir = join(r.gitDir, "objects/pack");
      const all = readdirSync(packDir).filter((n) => /^pack-.*\.idx$/.test(n));
      r.git(["multi-pack-index", "write", "--stdin-packs", "--bitmap"], {
        input: `${all.sort().join("\n")}\n`,
      });
      r.commit("five", { "five.t": "five\n" });
      const { twins } = await repackTwins(caseDir, bitmapMidx, ourBitmapMidx, {}, withoutInfoPacks);
      // the old midx named the cruft pack: an unknown pack keeps it in the new one
      expect(midxKinds(twins.ours)).toEqual(["cruft", "pack", "pack"]);
    });

    it("t7704-repack-cruft 'repack --write-midx includes cruft when necessary' (an old midx without the cruft pack: git's midx_has_unknown_packs matches no name, so the cruft pack comes in)", async () => {
      const { caseDir, r } = cruftExcludeRepo("follow-old-midx");
      const packDir = join(r.gitDir, "objects/pack");
      const plain = readdirSync(packDir).filter(
        (n) => /^pack-.*\.idx$/.test(n) && !existsSync(join(packDir, n.replace(/idx$/, "mtimes"))),
      );
      r.git(["multi-pack-index", "write", "--stdin-packs"], { input: `${plain.join("\n")}\n` });
      r.commit("five", { "five.t": "five\n" });
      const { twins } = await repackTwins(caseDir, bitmapMidx, ourBitmapMidx, {}, withoutInfoPacks);
      expect(midxKinds(twins.ours)).toEqual(["cruft", "pack", "pack"]);
    });

    /**
     * t7704's "repack --write-midx includes cruft when already geometric", every commit at
     * `date`: the commits' ids decide whether the pack the follow walk writes holds C's objects
     * in the cruft pack's order, so it is the cruft pack byte for byte and takes its name (git's
     * install_generated_packs then unlinks the stale `.mtimes`); a clock date made it flaky
     */
    async function alreadyGeometric(name: string, date: number) {
      const caseDir = newCase(root, name);
      const r = initRepo(root, caseDir);
      r.git(["config", "repack.midxMustContainCruft", "false"]);
      r.commit("A", { "A.t": "A\n" }, date);
      r.commit("B", { "B.t": "B\n" }, date);
      r.git(["checkout", "-q", "-B", "side"]);
      const c = r.commit("C", { "C.t": "C\n" }, date);
      r.git(["checkout", "-q", "main"]);
      r.git(["branch", "-D", "side"]);
      r.git(["reflog", "expire", "--all", "--expire=all"]);
      r.git(["repack", "-q", "--cruft", "-d"]);
      r.git(["merge", "-q", "--no-ff", "-m", "merge", c], {
        env: { GIT_AUTHOR_DATE: `${date} +0000`, GIT_COMMITTER_DATE: `${date} +0000` },
      });
      r.git(["repack", "-q", "-d"]);
      const { result, twins } = await repackTwins(
        caseDir,
        ["--geometric=2", "--write-midx", "--write-bitmap-index"],
        (c) => c.setGeometric(2).setWriteMidx(true).setWriteBitmaps(true),
        {},
        withoutInfoPacks,
      );
      const packDir = (twin: string) => join(twin, "repo/.git/objects/pack");
      const packCount = (twin: string) =>
        readdirSync(packDir(twin)).filter((n) => n.endsWith(".pack")).length;
      const cruftCount = (twin: string) =>
        readdirSync(packDir(twin)).filter((n) => n.endsWith(".mtimes")).length;
      return { result, twins, packCount, cruftCount };
    }

    it("t7704-repack-cruft 'repack --write-midx includes cruft when already geometric'", async () => {
      const { result, twins, packCount, cruftCount } = await alreadyGeometric(
        "follow-noop",
        1700000000,
      );
      // 2.5x's follow walk rescues C's objects from the cruft pack through the merge (a `!`
      // pack: no midx names it), so a pack is written and the midx can leave the cruft pack
      // out; 2.43 writes nothing and keeps it
      expect(result.output).toEqual(nativeIs25x ? [] : ["Nothing new to pack."]);
      expect(midxKinds(twins.ours)).toEqual(
        nativeIs25x ? ["pack", "pack", "pack"] : ["cruft", "pack", "pack"],
      );
      expect([packCount(twins.ours), cruftCount(twins.ours)]).toEqual(
        nativeIs25x ? [4, 1] : [3, 1],
      );
    });

    it("t7704-repack-cruft 'repack --write-midx includes cruft when already geometric' (the rescued pack is the cruft pack byte for byte: generated_pack_install unlinks its stale .mtimes)", async () => {
      const { result, twins, packCount, cruftCount } = await alreadyGeometric(
        "follow-noop-same-name",
        1700000001,
      );
      expect(result.output).toEqual(nativeIs25x ? [] : ["Nothing new to pack."]);
      expect(midxKinds(twins.ours)).toEqual(
        nativeIs25x ? ["pack", "pack", "pack"] : ["cruft", "pack", "pack"],
      );
      expect([packCount(twins.ours), cruftCount(twins.ours)]).toEqual(
        nativeIs25x ? [3, 0] : [3, 1],
      );
    });

    it("t7704-repack-cruft 'repack rescues once-cruft objects above geometric split'", async () => {
      const caseDir = newCase(root, "follow-rescue");
      const r = initRepo(root, caseDir);
      r.git(["config", "repack.midxMustContainCruft", "false"]);
      r.commit("reachable", { "reachable.t": "reachable\n" });
      const unreachable = r.commit("unreachable", { "unreachable.t": "unreachable\n" });
      r.git(["reset", "-q", "--hard", "HEAD^"]);
      r.git(["reflog", "expire", "--all", "--expire=all"]);
      r.git(["repack", "-q", "--cruft", "-d"]);
      r.git(["pack-objects", "-q", join(r.gitDir, "objects/pack/pack")], {
        input: `${unreachable}\n`,
      });
      r.commit("new", { "new.t": "new\n" });
      r.git(["update-ref", "refs/heads/other", unreachable]);
      const { twins } = await repackTwins(caseDir, bitmapMidx, ourBitmapMidx, {}, withoutInfoPacks);
      expect(midxKinds(twins.ours)).toEqual(
        nativeIs25x ? ["pack", "pack", "pack"] : ["cruft", "pack", "pack", "pack"],
      );
    });
  });

  describe("#347's divergences", () => {
    it("t7700-repack '--local disables writing bitmaps when connected to alternate ODB' (-d -l -m without -b: git's write_bitmaps is -1, true, with --write-midx)", async () => {
      const caseDir = newCase(root, "local-midx-alternate");
      const shared = initRepo(root, caseDir, false, "shared");
      shared.commit("one", { "one.t": "one\n" });
      shared.git(["repack", "-q", "-a", "-d"]);
      shared.git(["clone", "-q", "--shared", "shared", "repo"], { cwd: join(caseDir, "src") });
      const r = new NativeRepo(root, join(caseDir, "src", "repo"));
      r.commit("two", { "two.t": "two\n" });
      const { result, stderr } = await repackTwins(
        caseDir,
        ["-d", "-l", "-m"],
        (c) => c.setDeleteRedundant(true).setLocal(true).setWriteMidx(true),
        {},
        withoutInfoPacks,
      );
      const warning = "warning: disabling bitmap writing, as some objects are not being packed";
      expect(stderr.split("\n").filter(Boolean)).toEqual([warning]);
      expect(result.warnings).toEqual([warning]);
    });

    it("t7700-repack 'repacking with a filter works' (without -a and nothing new: \"Nothing new to pack.\", then write_filtered_pack still runs)", async () => {
      const { caseDir, r } = history("filter-nothing-new");
      r.git(["repack", "-q", "-a", "-d"]);
      r.commit("four", { "d.txt": "d\n" });
      r.git(["repack", "-q", "-d"]);
      const { ours, result } = await repackTwins(caseDir, ["-d", "--filter=blob:none"], (c) =>
        c.setDeleteRedundant(true).setFilter("blob:none"),
      );
      expect(result.output).toEqual(["Nothing new to pack."]);
      expect(ours.packs).toHaveLength(3);
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

    it("t5320-delta-islands 'deltas allowed against superset islands' (marks through a commit of a .keep pack)", async () => {
      // pack-objects' show_commit propagates the marks of every walked commit, those a .keep
      // pack holds included: `one` reaches the root through the kept commit
      const caseDir = newCase(root, "islands-kept-commit");
      const r = initRepo(root, caseDir);
      const root0 = islandCommit(r, "root", "shared", "root");
      const rootCommit = r.git(["rev-parse", "refs/heads/root"]);
      const rootTree = r.git(["rev-parse", "refs/heads/root^{tree}"]);
      const kept = r.git(["commit-tree", rootTree, "-p", rootCommit], { input: "kept\n" });
      const pack = r.git(["pack-objects", join(r.gitDir, "objects/pack/pack")], {
        input: `${kept}\n`,
      });
      writeFileSync(join(r.gitDir, "objects/pack", `pack-${pack}.keep`), "");
      const one = islandCommit(r, "one", "shared", "1", kept);
      const two = islandCommit(r, "two", "shared", "12-long", rootCommit);
      r.git(["update-ref", "-d", "refs/heads/root"]);
      r.git(["config", "pack.island", "refs/heads/(.*)"]);
      const { twins } = await repackTwins(caseDir, ["-adfi"], adfi);
      const ids = [root0, one, two];
      expect(deltaBases(twins.ours, ids)).toEqual(deltaBases(twins.native, ids));
    });

    it("t5320-delta-islands 'separate islands disallows delta' (--geometric: pack-objects --stdin-packs loads no islands)", async () => {
      const { caseDir, ids } = islands("islands-geometric", [["pack.island", "refs/heads/(.*)"]]);
      const { twins } = await repackTwins(caseDir, ["--geometric=2", "-d", "-f", "-i"], (c) =>
        c.setGeometric(2).setDeleteRedundant(true).setReuseDeltas(false).setDeltaIslands(true),
      );
      const ours = deltaBases(twins.ours, ids);
      expect(ours).toEqual(deltaBases(twins.native, ids));
      expect(ours.some((l) => !l.endsWith(" 0000000000000000000000000000000000000000"))).toBe(true);
    });

    /** Three commits of `a.bin` and `a.txt` (`big(n, kind)`), as files git deltas. */
    const big = (n: number, s: string) =>
      `${Array.from({ length: 400 }, (_, i) => `${s} line ${i} of a long file ${i % 7}`).join("\n")}\n${n}\n`;
    const zero = " 0000000000000000000000000000000000000000";

    for (const packFirst of [false, true])
      it(`t5300-pack-object: the delta attribute unset under --geometric (pack-objects' --stdin-packs hint walk, ${packFirst ? "packed" : "loose: 2.43 names no loose object"})`, async () => {
        const caseDir = newCase(root, `delta-attribute-geometric-${packFirst}`);
        const r = initRepo(root, caseDir);
        r.commit("one", {
          ".gitattributes": "*.bin -delta\n",
          "a.bin": big(1, "b"),
          "a.txt": big(1, "t"),
        });
        if (packFirst) {
          r.git(["repack", "-q", "-d"]);
          // date the first pack back: packs of one second tie on mtime, which orders them
          const dir = join(r.gitDir, "objects/pack");
          for (const n of readdirSync(dir)) utimesSync(join(dir, n), 1700000000, 1700000000);
        }
        r.commit("two", { "a.bin": big(2, "b"), "a.txt": big(2, "t") });
        if (packFirst) r.git(["repack", "-q", "-d"]);
        const ids = [1, 2].flatMap((n) => [r.blob(big(n, "b")), r.blob(big(n, "t"))]);
        const { twins } = await repackTwins(caseDir, ["--geometric=2", "-d", "-f"], (c) =>
          c.setGeometric(2).setDeleteRedundant(true).setReuseDeltas(false),
        );
        const ours = deltaBases(twins.ours, ids);
        const native = deltaBases(twins.native, ids);
        const binsWhole = (bases: string[]) =>
          !!bases[0]?.endsWith(zero) && !!bases[2]?.endsWith(zero);
        expect(binsWhole(ours)).toBe(packFirst || nativeIs25x);
        expect(binsWhole(native)).toBe(packFirst || nativeIs25x);
        // which of two blobs of one size is the base is a tie git breaks by its list position:
        // compare what the attribute decides, the blobs left whole
        const whole = (bases: string[]) => bases.map((l) => l.endsWith(zero));
        if (packFirst || nativeIs25x)
          expect(whole(ours).filter(Boolean).length).toBe(whole(native).filter(Boolean).length);
      });

    it("t5300-pack-object: the delta attribute unset under --geometric in a shallow clone (the hint walk stops at the shallow commits)", async () => {
      const caseDir = newCase(root, "delta-attribute-geometric-shallow");
      const up = initRepo(root, caseDir, false, "up");
      up.commit("one", {
        ".gitattributes": "*.bin -delta\n",
        "a.bin": big(1, "b"),
        "a.txt": big(1, "t"),
      });
      up.commit("two", { "a.bin": big(2, "b"), "a.txt": big(2, "t") });
      up.git(["clone", "-q", "--depth=1", `file://${up.dir}`, "repo"], {
        cwd: join(caseDir, "src"),
      });
      const r = new NativeRepo(root, join(caseDir, "src", "repo"));
      const dir = join(r.gitDir, "objects/pack");
      for (const n of readdirSync(dir)) utimesSync(join(dir, n), 1700000000, 1700000000);
      r.commit("three", { "a.bin": big(3, "b"), "a.txt": big(3, "t") });
      r.git(["repack", "-q", "-d"]);
      const ids = [2, 3].flatMap((n) => [r.blob(big(n, "b")), r.blob(big(n, "t"))]);
      const { twins } = await repackTwins(caseDir, ["--geometric=2", "-d", "-f"], (c) =>
        c.setGeometric(2).setDeleteRedundant(true).setReuseDeltas(false),
      );
      const ours = deltaBases(twins.ours, ids);
      const native = deltaBases(twins.native, ids);
      const binsWhole = (bases: string[]) =>
        !!bases[0]?.endsWith(zero) && !!bases[2]?.endsWith(zero);
      expect(binsWhole(native)).toBe(true);
      expect(binsWhole(ours)).toBe(true);
    });

    /** A bare repository whose two commits hold `a.bin` and `a.txt`, by fast-import. */
    function bareDeltaRepo(name: string, inTree: string) {
      const caseDir = newCase(root, name);
      const r = initRepo(root, caseDir, true);
      let stream = "";
      for (const n of [1, 2]) {
        stream += `commit refs/heads/main\ncommitter C O Mitter <c@example.com> ${1700000000 + n} +0000\n`;
        stream += `data <<EOF\ncommit ${n}\nEOF\n`;
        for (const [path, content] of [
          ["a.bin", big(n, "b")],
          ["a.txt", big(n, "t")],
          ...(inTree ? [[".gitattributes", inTree]] : []),
        ])
          stream += `M 644 inline ${path}\ndata ${Buffer.byteLength(content as string)}\n${content}\n`;
        stream += "\n";
      }
      r.git(["fast-import", "--quiet"], { input: stream });
      const ids = [1, 2].flatMap((n) => [r.blob(big(n, "b")), r.blob(big(n, "t"))]);
      return { caseDir, r, ids };
    }

    it("t5300-pack-object: the delta attribute in a bare repository's info/attributes", async () => {
      const { caseDir, r, ids } = bareDeltaRepo("delta-attribute-bare", "");
      writeFileSync(join(r.gitDir, "info", "attributes"), "*.bin -delta\n");
      const { twins } = await repackTwins(caseDir, ["-a", "-d", "-f"], (c) =>
        c.setAll(true).setDeleteRedundant(true).setReuseDeltas(false),
      );
      const ours = deltaBases(twins.ours, ids);
      expect(ours).toEqual(deltaBases(twins.native, ids));
      expect(ours[0]?.endsWith(zero) && ours[2]?.endsWith(zero)).toBe(true);
    });

    it("t5300-pack-object: a bare repository's HEAD .gitattributes (2.43's default attribute source, none in 2.5x)", async () => {
      const { caseDir, ids } = bareDeltaRepo("delta-attribute-bare-head", "*.bin -delta\n");
      const { twins } = await repackTwins(caseDir, ["-a", "-d", "-f"], (c) =>
        c.setAll(true).setDeleteRedundant(true).setReuseDeltas(false),
      );
      const ours = deltaBases(twins.ours, ids);
      const native = deltaBases(twins.native, ids);
      const binsWhole = (bases: string[]) =>
        !!bases[0]?.endsWith(zero) && !!bases[2]?.endsWith(zero);
      expect(binsWhole(ours)).toBe(!nativeIs25x);
      expect(binsWhole(native)).toBe(!nativeIs25x);
      // with the attribute applied (2.43) the delta choices are git's; without it, the .bin
      // blobs may be deltas, and ours may pair the other blobs differently
      if (!nativeIs25x) expect(ours).toEqual(native);
    });
  });
});
