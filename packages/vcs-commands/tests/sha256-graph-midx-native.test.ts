/**
 * SHA-256 commit-graphs, multi-pack-indexes and bitmaps against native git
 * (statewalker-root#226, T3c), mirroring the SHA-1 twins of vcs-store-files
 * (`commit-graph.git.test.ts`, `multi-pack-index.git.test.ts`, `pack-bitmap.git.test.ts`) in
 * `--object-format=sha256` repositories: hash version 2, 32-byte ids, SHA-256 trailers.
 *
 * - commit-graphs (git's t5318-commit-graph.sh, t5324-split-commit-graph.sh): native graphs
 *   (one file with octopus edges, split chains, Bloom filters, generation data v1 and v2,
 *   GDO2 overflow) read back commit by commit; ours byte-identical to `git commit-graph write`
 *   (`--reachable`, `--changed-paths`, `--split[=no-merge|replace]`, `--append`) and to the
 *   graph `git gc` writes; `git commit-graph verify`, `git fsck` and our fsck agree.
 * - multi-pack-indexes (t5319-multi-pack-index.sh): ours byte-identical to `git
 *   multi-pack-index write` (with `--bitmap`: `RIDX`, and `BTMP` in 2.44+), native midxes read
 *   by our pack set, `verify`, `expire`, `repack --batch-size` and `repack --write-midx` as
 *   native's, incremental chains (`multi-pack-index.d/`, git 2.47+) both ways.
 * - bitmaps (t5310-pack-bitmaps.sh): our `.bitmap` of git's pack is git's; ours pass `git
 *   rev-list --test-bitmap` and `--use-bitmap-index` agrees with the plain walk; git's read by
 *   our walk; midx bitmaps both ways; a bare repository's gc writes the bitmap git gc writes.
 *
 * Runs against the `git` on PATH: 2.43 (the sandbox's) skips what 2.43 lacks (midx chains,
 * `BTMP`), as the SHA-1 twins do; CI runs 2.56.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
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
import { bitmapWalk, type PackFile, writePackBitmap } from "@statewalker/vcs-core";
import {
  createGitFilesBackend,
  gc,
  listReachableObjects,
  multiPackIndexExpire,
  multiPackIndexRepack,
  multiPackIndexVerify,
  multiPackIndexWrite,
  openGitLinkedWorktrees,
  repack,
  writeCommitGraph,
} from "@statewalker/vcs-store-files";
import { SHA256_OBJECT_FORMAT } from "@statewalker/vcs-utils";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Git } from "../src/index.js";
import { put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

describeGit("SHA-256 commit-graphs, multi-pack-indexes and bitmaps against native git", () => {
  let root: string;
  let n = 0;
  /** git's version as major * 100 + minor */
  let version = 0;
  /** 2.5x's behaviour where versions differ (bitmap entry order, BTMP, fsck's checks) */
  let compatibility: "2.43" | "2.56" = "2.43";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sha256-graph-midx-"));
    const m = /(\d+)\.(\d+)/.exec(native(root, ["--version"]).stdout);
    version = m ? Number(m[1]) * 100 + Number(m[2]) : 0;
    compatibility = version >= 250 ? "2.56" : "2.43";
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function native(cwd: string, args: string[], input?: string | Uint8Array, env = {}) {
    const r = spawnSync("git", args, {
      cwd,
      env: { ...nativeGitEnv(root), ...env },
      input,
      maxBuffer: 256 * 2 ** 20,
    });
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  }
  const g = (dir: string, ...args: string[]) => {
    const r = native(dir, args);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const fresh = () => join(root, `r${n++}`);
  const fsckArgs = () => [
    "fsck",
    "--strict",
    "--no-progress",
    "--no-dangling",
    ...(version >= 245 ? ["--no-references"] : []),
  ];
  const expectNativeFsckClean = (dir: string) => {
    const r = native(dir, fsckArgs());
    expect([r.status, r.stderr, r.stdout]).toEqual([0, "", ""]);
  };
  const filesOf = (dir: string) => createNodeFilesApi({ rootDir: dir });
  const environment = () => createNodeGitHostEnvironment({ env: nativeGitEnv(root) });
  const open = (dir: string) =>
    createGitFilesBackend({ files: filesOf(dir), gitDir: ".git", environment: environment() });
  async function openOurs(dir: string): Promise<Git> {
    const files = filesOf(dir);
    const env = environment();
    const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment: env });
    const worktrees = await openGitLinkedWorktrees({
      files,
      gitDir: ".git",
      history,
      environment: env,
    });
    return Git.fromWorkingCopy(await worktrees.openCurrent());
  }
  const copyOf = (dir: string) => {
    const to = fresh();
    cpSync(dir, to, { recursive: true });
    return to;
  };

  /**
   * A SHA-256 history through fast-import: `n` commits on main, a branch merged every 7th
   * commit, an octopus of three branches every 23rd, files in nested directories (one with a
   * high-bit name), dates a minute apart.
   */
  function fastImportRepo(count: number, options: { start?: number; dir?: string } = {}): string {
    const dir = options.dir ?? fresh();
    if (!options.dir) g(root, "init", "-q", "--object-format=sha256", "-b", "main", dir);
    const lines: string[] = [];
    let mark = 0;
    const t0 = 1_600_000_000 + (options.start ?? 0) * 60;
    let main = options.start ? "refs/heads/main^0" : "";
    const commit = (ref: string, parents: string[], time: number, files: [string, string][]) => {
      mark++;
      lines.push(`commit ${ref}`, `mark :${mark}`);
      lines.push(
        `author A <a@example.com> ${time} +0000`,
        `committer C <c@example.com> ${time} +0000`,
      );
      const msg = `commit ${mark}\n`;
      lines.push(`data ${Buffer.byteLength(msg)}`, msg);
      if (parents[0]) lines.push(`from ${parents[0]}`);
      for (const p of parents.slice(1)) lines.push(`merge ${p}`);
      for (const [path, content] of files) {
        lines.push(`M 100644 inline ${path}`, `data ${Buffer.byteLength(content)}`, content);
      }
      return `:${mark}`;
    };
    for (let i = 0; i < count; i++) {
      const t = t0 + i * 60;
      const k = (options.start ?? 0) + i;
      const files: [string, string][] = [[`d${k % 5}/s${k % 3}/f${k % 11}.txt`, `${k}\n`]];
      if (k % 13 === 0) files.push([`dé/f${k}.txt`, `${k}\n`]);
      if (k % 7 === 6 && main) {
        const b = commit("refs/heads/side", [main], t - 30, [[`side/f${k}`, `${k}\n`]]);
        main = commit("refs/heads/main", [main, b], t, files);
      } else if (k % 23 === 22 && main) {
        const bs = [1, 2, 3].map((j) =>
          commit(`refs/heads/o${j}`, [main], t - 10 * j, [[`o${j}/f${k}`, `${k}\n`]]),
        );
        main = commit("refs/heads/main", [main, ...bs], t, files);
      } else {
        main = commit("refs/heads/main", main ? [main] : [], t, files);
      }
    }
    const r = native(dir, ["fast-import", "--quiet"], `${lines.join("\n")}\n`);
    if (r.status !== 0) throw new Error(r.stderr);
    return dir;
  }

  /** A small repository with octopus merges, merges and an annotated tag. */
  function smallRepo(): string {
    const dir = fastImportRepo(30);
    g(dir, "tag", "-a", "-m", "release", "v1", "main~3");
    g(dir, "branch", "topic", "main~5");
    return dir;
  }

  // ---------------------------------------------------------------- commit-graphs

  const graphFile = (dir: string) => join(dir, ".git/objects/info/commit-graph");
  const graphsDir = (dir: string) => join(dir, ".git/objects/info/commit-graphs");

  /** Every graph file of the repository, by name, as hex. */
  function graphFiles(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (existsSync(graphFile(dir)))
      out["commit-graph"] = readFileSync(graphFile(dir)).toString("hex");
    if (existsSync(graphsDir(dir))) {
      for (const name of readdirSync(graphsDir(dir)).sort()) {
        out[`commit-graphs/${name}`] = readFileSync(join(graphsDir(dir), name)).toString("hex");
      }
    }
    return out;
  }

  type WriteOptions = Partial<Parameters<typeof writeCommitGraph>[0]>;

  /** Our `git commit-graph write --reachable [options]`. */
  async function ourGraphWrite(dir: string, options: WriteOptions = {}) {
    const { history, objects, files } = await open(dir);
    return writeCommitGraph({
      files,
      objects,
      refs: history.refs,
      commitGraph: history.commitGraph,
      environment: environment(),
      ...options,
    });
  }

  /** Native and ours from copies of the same state: the graph files are identical. */
  async function expectGraphSameAsNative(dir: string, args: string[], options: WriteOptions = {}) {
    const theirs = copyOf(dir);
    const ours = copyOf(dir);
    g(theirs, "commit-graph", "write", "--reachable", ...args);
    const result = await ourGraphWrite(ours, options);
    expect(result.written).toBe(true);
    expect(graphFiles(ours)).toEqual(graphFiles(theirs));
    expect(native(ours, ["commit-graph", "verify"])).toMatchObject({ status: 0, stderr: "" });
    return ours;
  }

  /** Every commit read from our graph matches the commit native git parses. */
  async function expectGraphMatchesCommits(dir: string, layers?: number) {
    const { history } = await open(dir);
    const graph = await history.commitGraph?.get();
    if (!graph) throw new Error("no graph loaded");
    expect(graph.hashSize).toBe(32);
    if (layers !== undefined) expect(graph.layers).toHaveLength(layers);
    const ids = g(dir, "rev-list", "--all", "--topo-order").split("\n");
    expect(graph.size).toBe(ids.length);
    const rows = g(dir, "log", "--all", "--format=%H %T %ct %P").split("\n");
    const gen = new Map<string, number>();
    const topo = new Map<string, number>();
    const byId = new Map(rows.map((r) => [r.split(" ")[0] as string, r.split(" ")]));
    for (const id of [...ids].reverse()) {
      const [, tree, ct, ...parents] = byId.get(id) as string[];
      let gMax = 0;
      let tMax = 0;
      for (const p of parents) {
        gMax = Math.max(gMax, gen.get(p) as number);
        tMax = Math.max(tMax, topo.get(p) as number);
      }
      const date = Number(ct);
      gen.set(id, date && date > gMax ? date : gMax + 1);
      topo.set(id, tMax + 1);
      const c = graph.lookup(id);
      expect(c?.tree).toBe(tree);
      expect(c?.parents).toEqual(parents);
      expect(c?.commitTime).toBe(date);
    }
    for (const id of ids) {
      const c = graph.lookup(id);
      expect(c?.topoLevel).toBe(topo.get(id));
      expect(c?.generation).toBe(graph.correctedDates ? gen.get(id) : topo.get(id));
    }
    return graph;
  }

  describe("commit-graphs native git writes, read by ours (t5318, t5324)", () => {
    it("one file with octopus merges (EDGE) and generation data (GDA2)", async () => {
      const dir = smallRepo();
      g(dir, "commit-graph", "write", "--reachable");
      expect(readFileSync(graphFile(dir))[5]).toBe(2);
      const graph = await expectGraphMatchesCommits(dir, 1);
      expect(graph.correctedDates).toBe(true);
      expect(graph.top.extraEdges).toBeDefined();
    });

    it("a split chain of three layers, Bloom filters on the top one", async () => {
      const dir = fastImportRepo(20);
      g(dir, "commit-graph", "write", "--reachable", "--split=no-merge");
      fastImportRepo(15, { start: 20, dir });
      g(dir, "commit-graph", "write", "--reachable", "--split=no-merge");
      fastImportRepo(10, { start: 35, dir });
      g(dir, "commit-graph", "write", "--reachable", "--split=no-merge", "--changed-paths");
      const chain = readFileSync(join(graphsDir(dir), "commit-graph-chain"), "utf8").split("\n");
      expect(chain.filter(Boolean).map((l) => l.length)).toEqual([64, 64, 64]);
      const graph = await expectGraphMatchesCommits(dir, 3);
      expect(graph.layers.map((l) => l.bloomSettings !== undefined)).toEqual([false, false, true]);
      // walks use the filters: log -- <path> lists what native lists
      const git = await openOurs(dir);
      const ours: string[] = [];
      for await (const c of await git.log().addPath("d1/s1").call()) ours.push(c.id);
      expect(ours).toEqual(g(dir, "log", "--format=%H", "--", "d1/s1").split("\n"));
    });

    it("generation data v1 only (commitGraph.generationVersion=1)", async () => {
      const dir = smallRepo();
      g(dir, "-c", "commitGraph.generationVersion=1", "commit-graph", "write", "--reachable");
      const graph = await expectGraphMatchesCommits(dir, 1);
      expect(graph.correctedDates).toBe(false);
    });

    it("refuses a SHA-1 graph in a SHA-256 repository with git's message", async () => {
      const dir = smallRepo();
      const sha1 = fresh();
      g(root, "init", "-q", "-b", "main", sha1);
      put(sha1, "a.txt", "a\n");
      g(sha1, "add", "a.txt");
      g(sha1, "commit", "-q", "-m", "a");
      g(sha1, "commit-graph", "write", "--reachable");
      writeFileSync(graphFile(dir), readFileSync(graphFile(sha1)));
      const theirs = native(dir, ["commit-graph", "verify"]);
      expect(theirs.stderr).toContain("commit-graph hash version 1 does not match version 2");
      const { history } = await open(dir);
      expect(await history.commitGraph?.get()).toBeUndefined();
    });
  });

  describe("commit-graphs ours writes, as native git writes them (t5318, t5324)", () => {
    it("--reachable: identical files; verify and fsck accept them", async () => {
      for (const dir of [smallRepo(), fastImportRepo(300)]) {
        const ours = await expectGraphSameAsNative(dir, []);
        expectNativeFsckClean(ours);
      }
    });

    it("--changed-paths: identical Bloom filters (high-bit names, more than 512 paths)", async () => {
      const dir = smallRepo();
      const lines: string[] = [
        "commit refs/heads/main",
        "committer C <c@example.com> 1700000000 +0000",
        "data 4",
        "big",
        "from refs/heads/main^0",
      ];
      for (let i = 0; i < 600; i++)
        lines.push(`M 100644 inline many/f${i}`, "data 2", `${i % 10}\n`);
      expect(native(dir, ["fast-import", "--quiet"], `${lines.join("\n")}\n`).status).toBe(0);
      await expectGraphSameAsNative(dir, ["--changed-paths"], { changedPaths: true });
      // an existing graph's filters are kept
      g(dir, "commit-graph", "write", "--reachable", "--changed-paths");
      await expectGraphSameAsNative(dir, []);
    });

    it("--split: a first layer, a base from info/commit-graph, merge, no-merge, replace", async () => {
      const dir = fastImportRepo(40);
      await expectGraphSameAsNative(dir, ["--split"], { split: true });
      g(dir, "commit-graph", "write", "--reachable");
      fastImportRepo(5, { start: 40, dir });
      await expectGraphSameAsNative(dir, ["--split"], { split: true });
      rmSync(graphFile(dir));
      g(dir, "commit-graph", "write", "--reachable", "--split");
      fastImportRepo(10, { start: 45, dir });
      g(dir, "commit-graph", "write", "--reachable", "--split=no-merge", "--changed-paths");
      fastImportRepo(4, { start: 55, dir });
      g(dir, "commit-graph", "write", "--reachable", "--split=no-merge");
      fastImportRepo(6, { start: 59, dir });
      const merged = await expectGraphSameAsNative(dir, ["--split"], { split: true });
      const chain = readFileSync(join(graphsDir(merged), "commit-graph-chain"), "utf8");
      expect(chain.trim().split("\n")).toHaveLength(2);
      expect(chain.trim().split("\n")[0]).toMatch(/^[0-9a-f]{64}$/);
      await expectGraphSameAsNative(dir, ["--split=no-merge"], { split: "no-merge" });
      await expectGraphSameAsNative(dir, ["--split", "--max-commits=5"], {
        split: true,
        maxCommits: 5,
      });
      await expectGraphSameAsNative(dir, ["--split=replace"], { split: "replace" });
      const single = await expectGraphSameAsNative(dir, []);
      expect(existsSync(graphsDir(single)) ? readdirSync(graphsDir(single)) : []).toEqual([]);
    });

    it("--append keeps the commits of the existing graph", async () => {
      const dir = fastImportRepo(20);
      g(dir, "commit-graph", "write", "--reachable");
      g(dir, "branch", "-D", "side");
      await expectGraphSameAsNative(dir, ["--append"], { append: true });
    });

    // t5318's "generation data overflow": corrected dates far ahead of their commits (GDO2)
    it("writes the overflow chunk (GDO2) for a commit dated long before its parent", async () => {
      const dir = fresh();
      g(root, "init", "-q", "--object-format=sha256", "-b", "main", dir);
      const lines: string[] = [];
      const dates = [4_000_000_000, 1, 2, 3_000_000_000, 5];
      dates.forEach((t, i) => {
        lines.push("commit refs/heads/main", `mark :${i + 1}`);
        lines.push(`committer C <c@example.com> ${t} +0000`, "data 2", `${i}\n`);
        if (i > 0) lines.push(`from :${i}`);
        lines.push(`M 100644 inline f${i}`, "data 2", `${i}\n`);
      });
      expect(native(dir, ["fast-import", "--quiet"], `${lines.join("\n")}\n`).status).toBe(0);
      const ours = await expectGraphSameAsNative(dir, []);
      const bytes = readFileSync(graphFile(ours));
      expect(bytes.includes(Buffer.from("GDO2"))).toBe(true);
      await expectGraphMatchesCommits(ours, 1);
    });

    it("gc writes the graph git gc writes, replacing a chain", async () => {
      const dir = smallRepo();
      g(dir, "commit-graph", "write", "--reachable", "--split");
      const theirs = copyOf(dir);
      g(theirs, "gc", "-q");
      const { history, files } = await open(dir);
      const result = await gc({ history, files, environment: environment() });
      expect(result.commitGraphWritten).toBe(true);
      expect(graphFiles(dir)).toEqual(graphFiles(theirs));
      expectNativeFsckClean(dir);
    });

    // the review of #236 (H1): a graph naming a commit gc prunes is rewritten, as git gc does
    it("gc that prunes rewrites the graph without the pruned commits", async () => {
      const dir = smallRepo();
      g(dir, "checkout", "-q", "-b", "tmp", "main");
      put(dir, "x.txt", "x\n");
      g(dir, "add", "x.txt");
      g(dir, "commit", "-q", "-m", "doomed");
      const doomed = g(dir, "rev-parse", "HEAD");
      g(dir, "checkout", "-q", "main");
      g(dir, "commit-graph", "write", "--reachable");
      g(dir, "branch", "-D", "tmp");
      g(dir, "reflog", "expire", "--expire=all", "--all");
      const theirs = copyOf(dir);
      g(theirs, "gc", "-q", "--prune=now");
      const git = await openOurs(dir);
      await git.gc().setPrune("now").call();
      expect(native(dir, ["cat-file", "-e", doomed]).status).not.toBe(0);
      expect(graphFiles(dir)).toEqual(graphFiles(theirs));
      expectNativeFsckClean(dir);
      expect(native(dir, ["commit-graph", "verify"]).status).toBe(0);
    });

    it("our fsck verifies graphs as native fsck does, sound and corrupt", async () => {
      const dir = smallRepo();
      g(dir, "commit-graph", "write", "--reachable", "--split");
      fastImportRepo(5, { start: 30, dir });
      g(dir, "commit-graph", "write", "--reachable", "--split=no-merge");
      const fsck = async (at: string) =>
        (await openOurs(at))
          .fsck()
          .setRepositoryFiles({ files: filesOf(at) })
          .setCompatibility(compatibility)
          .call();
      const sound = await fsck(dir);
      const theirsSound = native(dir, ["fsck", ...(version >= 245 ? ["--no-references"] : [])]);
      expect([sound.output, sound.errorOutput, sound.exitCode]).toEqual([
        theirsSound.stdout,
        theirsSound.stderr,
        theirsSound.status,
      ]);
      // a commit's root tree changed in the top layer (and so its checksum)
      const chain = readFileSync(join(graphsDir(dir), "commit-graph-chain"), "utf8").trim();
      const top = join(graphsDir(dir), `graph-${chain.split("\n").at(-1)}.graph`);
      const bytes = readFileSync(top);
      const cdat = bytes.indexOf(Buffer.from("CDAT"));
      const offset = Number(bytes.readBigUInt64BE(cdat + 4));
      bytes[offset + 3] = (bytes[offset + 3] as number) ^ 0xff;
      rmSync(top);
      writeFileSync(top, bytes);
      const corrupt = await fsck(dir);
      const theirs = native(dir, ["fsck", ...(version >= 245 ? ["--no-references"] : [])]);
      expect(theirs.stderr).toContain("root tree OID for commit");
      expect([corrupt.output, corrupt.errorOutput, corrupt.exitCode]).toEqual([
        theirs.stdout,
        theirs.stderr,
        theirs.status,
      ]);
    });
  });

  // ---------------------------------------------------------------- multi-pack-indexes

  const packDir = (dir: string) => join(dir, ".git/objects/pack");
  const listPack = (dir: string) => readdirSync(packDir(dir)).sort();
  const midxFiles = (dir: string) => listPack(dir).filter((f) => f.startsWith("multi-pack-index"));
  const midxPath = (dir: string) => join(packDir(dir), "multi-pack-index");
  const packNames = (dir: string, ext: string) => listPack(dir).filter((f) => f.endsWith(ext));
  const clearMidx = (dir: string) => {
    for (const f of midxFiles(dir)) rmSync(join(packDir(dir), f), { recursive: true, force: true });
  };

  /** `count` commits, each packed into a pack of its own (`repack -d`), a second apart. */
  function packedRepo(count: number, start = 0): string {
    const dir = fresh();
    g(root, "init", "-q", "--object-format=sha256", "-b", "main", dir);
    for (let c = start; c < start + count; c++) addCommit(dir, c);
    return dir;
  }
  function addCommit(dir: string, c: number, repackIt = true) {
    const date = `${1700000000 + c} +0000`;
    put(dir, `f${c % 3}.txt`, `content ${c}\n${"x".repeat(c * 7)}\n`);
    g(dir, "add", "-A");
    const r = native(dir, ["commit", "-q", "-m", `c${c}`], undefined, {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    if (r.status !== 0) throw new Error(r.stderr);
    if (repackIt) g(dir, "repack", "-dq");
  }
  const allObjects = (dir: string) =>
    g(dir, "rev-list", "--objects", "--all")
      .split("\n")
      .map((l) => l.slice(0, 64))
      .sort();
  /** native git reads every object and fsck (which runs `multi-pack-index verify`) passes */
  function expectNativeReadsAll(dir: string, objects: string[]) {
    expectNativeFsckClean(dir);
    expect(native(dir, ["multi-pack-index", "verify"])).toMatchObject({ status: 0, stderr: "" });
    expect(allObjects(dir)).toEqual(objects);
    const batch = native(dir, ["cat-file", "--batch-check"], `${objects.join("\n")}\n`);
    expect(batch.stdout).not.toMatch(/missing/);
  }
  /** native's midx bytes for `args` (the midx files removed after) */
  function nativeMidx(dir: string, args: string[], input?: string): Buffer {
    const r = native(dir, ["multi-pack-index", "write", ...args], input);
    if (r.status !== 0) throw new Error(r.stderr);
    const bytes = readFileSync(midxPath(dir));
    clearMidx(dir);
    return bytes;
  }

  describe("multi-pack-indexes ours writes, as native git writes them (t5319)", () => {
    it("several packs, with and without --bitmap (RIDX, and BTMP in 2.44+)", async () => {
      const dir = packedRepo(4);
      for (const args of [[], ["--bitmap"]]) {
        const theirs = nativeMidx(dir, args);
        expect(theirs[5]).toBe(2);
        const r = await multiPackIndexWrite({
          files: filesOf(dir),
          compatibility,
          bitmap: args.length > 0,
        });
        expect(r.stderr).toEqual([]);
        expect(r.exitCode).toBe(0);
        expect(r.written).toMatch(/^[0-9a-f]{64}$/);
        expect(readFileSync(midxPath(dir)).equals(theirs)).toBe(true);
        expect(native(dir, ["multi-pack-index", "verify"]).status).toBe(0);
        expectNativeReadsAll(dir, allObjects(dir));
        clearMidx(dir);
      }
    });

    it("a preferred pack, duplicates across packs, equal mtimes, reuse and --stdin-packs", async () => {
      const dir = packedRepo(3);
      g(dir, "repack", "-aq");
      const packs = packNames(dir, ".pack");
      for (const preferred of [packs[0] as string, packs[2] as string]) {
        const theirs = nativeMidx(dir, [`--preferred-pack=${preferred}`]);
        await multiPackIndexWrite({ files: filesOf(dir), compatibility, preferredPack: preferred });
        expect(readFileSync(midxPath(dir)).equals(theirs)).toBe(true);
        clearMidx(dir);
      }
      const when = new Date(1700000000 * 1000);
      for (const p of packs) utimesSync(join(packDir(dir), p), when, when);
      const theirs = nativeMidx(dir, []);
      await multiPackIndexWrite({ files: filesOf(dir), compatibility });
      expect(readFileSync(midxPath(dir)).equals(theirs)).toBe(true);
      // an existing midx reused, then a new pack
      const old = readFileSync(midxPath(dir));
      addCommit(dir, 9);
      g(dir, "multi-pack-index", "write");
      const reused = readFileSync(midxPath(dir));
      writeFileSync(midxPath(dir), old);
      await multiPackIndexWrite({ files: filesOf(dir), compatibility });
      expect(readFileSync(midxPath(dir)).equals(reused)).toBe(true);
      const some = packNames(dir, ".idx").slice(1, 3);
      const theirsSome = nativeMidx(dir, ["--stdin-packs"], `${some.join("\n")}\n`);
      await multiPackIndexWrite({ files: filesOf(dir), compatibility, stdinPacks: some });
      expect(readFileSync(midxPath(dir)).equals(theirsSome)).toBe(true);
    });

    it("repack --write-midx writes the midx native writes for those packs", async () => {
      const dir = packedRepo(3);
      const objects = allObjects(dir);
      const r = await repack({ ...(await open(dir)), writeMidx: true, compatibility });
      expect(r?.midx).toMatch(/^[0-9a-f]{64}$/);
      const ours = readFileSync(midxPath(dir));
      clearMidx(dir);
      expect(ours.equals(nativeMidx(dir, []))).toBe(true);
      g(dir, "multi-pack-index", "write");
      expectNativeReadsAll(dir, objects);
    });
  });

  describe("multi-pack-indexes native git writes, read by ours (t5319)", () => {
    it("our pack set looks objects up through native's midx", async () => {
      const dir = packedRepo(4);
      g(dir, "repack", "-aq");
      addCommit(dir, 7);
      g(dir, "multi-pack-index", "write");
      const { packs, objects } = await open(dir);
      const midx = await packs.multiPackIndex?.();
      expect(midx?.objectFormat).toBe(SHA256_OBJECT_FORMAT);
      expect(midx?.checksum).toHaveLength(64);
      expect(packs.midxErrors).toEqual([]);
      for (const id of allObjects(dir)) {
        expect(midx?.find(id)).toBeGreaterThanOrEqual(0);
        expect(await objects.has(id)).toBe(true);
        const o = await objects.get(id, { verify: true });
        for await (const _ of o?.content ?? []) {
          // read to the end: the hash is checked
        }
      }
      const git = await openOurs(dir);
      const log: string[] = [];
      for await (const c of await git.log().call()) log.push(c.id);
      expect(log).toEqual(g(dir, "log", "--format=%H").split("\n"));
    });

    it("verify: a sound and a damaged midx give native's messages and exit codes", async () => {
      const dir = packedRepo(3);
      g(dir, "multi-pack-index", "write");
      const sound = await multiPackIndexVerify({ files: filesOf(dir), compatibility });
      expect([sound.exitCode, sound.stderr]).toEqual([0, []]);
      // an offset changed: the checksum and that object's offset are wrong
      const bytes = readFileSync(midxPath(dir));
      const ooff = bytes.indexOf(Buffer.from("OOFF"));
      const at = Number(bytes.readBigUInt64BE(ooff + 4)) + 4;
      bytes.writeUInt32BE(bytes.readUInt32BE(at) + 1, at);
      rmSync(midxPath(dir));
      writeFileSync(midxPath(dir), bytes);
      const theirs = native(dir, ["multi-pack-index", "verify"]);
      const ours = await multiPackIndexVerify({ files: filesOf(dir), compatibility });
      expect(theirs.stderr).toContain("incorrect checksum");
      expect(ours.exitCode).toBe(theirs.status);
      expect(ours.stderr).toEqual(
        theirs.stderr
          .split("\n")
          .filter((l) => l && !/^(Verifying|Looking|Sorting)/.test(l) && !l.includes("\r")),
      );
    });

    it("expire and repack --batch-size act on the packs native acts on", async () => {
      const dir = packedRepo(4);
      g(dir, "multi-pack-index", "write");
      g(dir, "repack", "-aq"); // duplicates every object in a newer pack
      g(dir, "multi-pack-index", "write");
      const theirs = copyOf(dir);
      g(theirs, "multi-pack-index", "expire");
      const expired = await multiPackIndexExpire({ files: filesOf(dir), compatibility });
      expect(expired.exitCode).toBe(0);
      expect(listPack(dir)).toEqual(listPack(theirs));
      expect(readFileSync(midxPath(dir)).equals(readFileSync(midxPath(theirs)))).toBe(true);

      const batch = packedRepo(4, 20);
      g(batch, "multi-pack-index", "write");
      const theirsBatch = copyOf(batch);
      g(theirsBatch, "multi-pack-index", "repack", "--batch-size=0");
      const r = await multiPackIndexRepack({ files: filesOf(batch), compatibility, batchSize: 0 });
      expect(r.exitCode).toBe(0);
      expect(packNames(batch, ".pack")).toHaveLength(packNames(theirsBatch, ".pack").length);
      expect(native(batch, ["multi-pack-index", "verify"]).status).toBe(0);
      await multiPackIndexExpire({ files: filesOf(batch), compatibility });
      g(theirsBatch, "multi-pack-index", "expire");
      // the repacked pack is ours (pack-objects' bytes differ), the packs left alike
      expect(packNames(batch, ".pack")).toHaveLength(packNames(theirsBatch, ".pack").length);
      expectNativeReadsAll(batch, allObjects(theirsBatch));
    });

    it("our fsck runs multi-pack-index verify as native fsck does", async () => {
      const dir = packedRepo(3);
      g(dir, "multi-pack-index", "write", "--bitmap");
      const ours = await (await openOurs(dir))
        .fsck()
        .setRepositoryFiles({ files: filesOf(dir) })
        .setCompatibility(compatibility)
        .call();
      const theirs = native(dir, ["fsck", ...(version >= 245 ? ["--no-references"] : [])]);
      expect([ours.output, ours.errorOutput, ours.exitCode]).toEqual([
        theirs.stdout,
        theirs.stderr,
        theirs.status,
      ]);
    });
  });

  describe("incremental multi-pack-index chains (git 2.47+)", () => {
    it("native's chain read by ours, ours read by native, layers byte-identical", async () => {
      if (version < 247) return;
      const dir = packedRepo(2);
      g(dir, "multi-pack-index", "write", "--incremental");
      addCommit(dir, 5);
      g(dir, "multi-pack-index", "write", "--incremental");
      const chainFile = join(packDir(dir), "multi-pack-index.d", "multi-pack-index-chain");
      const chain = readFileSync(chainFile, "utf8").trim().split("\n");
      expect(chain.map((l) => l.length)).toEqual([64, 64]);
      const { packs, objects } = await open(dir);
      const midx = await packs.multiPackIndex?.();
      expect(midx?.base).toBeDefined();
      for (const id of allObjects(dir)) {
        expect(midx?.find(id)).toBeGreaterThanOrEqual(0);
        expect(await objects.has(id)).toBe(true);
      }
      expect((await multiPackIndexVerify({ files: filesOf(dir), compatibility })).exitCode).toBe(0);
      // ours adds the next layer as native does
      addCommit(dir, 6);
      const theirs = copyOf(dir);
      g(theirs, "multi-pack-index", "write", "--incremental");
      const r = await multiPackIndexWrite({
        files: filesOf(dir),
        compatibility,
        incremental: true,
      });
      expect(r.exitCode).toBe(0);
      expect(readFileSync(chainFile, "utf8")).toBe(
        readFileSync(join(packDir(theirs), "multi-pack-index.d", "multi-pack-index-chain"), "utf8"),
      );
      const layer = (d: string) =>
        readFileSync(
          join(
            packDir(d),
            "multi-pack-index.d",
            `multi-pack-index-${readFileSync(chainFile, "utf8").trim().split("\n").at(-1)}.midx`,
          ),
        );
      expect(layer(dir).equals(layer(theirs))).toBe(true);
      expectNativeReadsAll(dir, allObjects(dir));
    });
  });

  // ---------------------------------------------------------------- bitmaps

  /** Commits with distinct dates (git sorts commits of one date in an order of its own). */
  let clock = 1_700_000_000;
  function commitAll(dir: string, message: string) {
    clock += 100;
    const date = `${clock} +0000`;
    g(dir, "add", "-A");
    const r = native(dir, ["commit", "-q", "-m", message], undefined, {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    if (r.status !== 0) throw new Error(r.stderr);
  }

  /** A history: commits on main, a side branch merged back, a tag. */
  function bitmapRepo(commits = 12): string {
    const dir = fresh();
    g(root, "init", "-q", "--object-format=sha256", "-b", "main", dir);
    for (let i = 0; i < commits; i++) {
      put(dir, `d${i % 3}/f${i}.txt`, `file ${i}\n`);
      put(dir, "top.txt", `top ${i}\n${"x".repeat(i * 10)}\n`);
      commitAll(dir, `c${i}`);
    }
    g(dir, "checkout", "-q", "-b", "side", "HEAD~4");
    put(dir, "side.txt", "side\n");
    commitAll(dir, "side");
    g(dir, "checkout", "-q", "main");
    clock += 100;
    native(dir, ["merge", "-q", "--no-edit", "side"], undefined, {
      GIT_AUTHOR_DATE: `${clock} +0000`,
      GIT_COMMITTER_DATE: `${clock} +0000`,
    });
    native(dir, ["tag", "-a", "-m", "release", "v1", "HEAD~2"], undefined, {
      GIT_COMMITTER_DATE: `${clock} +0000`,
    });
    return dir;
  }

  /** `rev-list --test-bitmap` passes, and `--use-bitmap-index` lists what the walk lists. */
  function expectNativeUsesBitmap(dir: string, gitDir?: string) {
    const env = gitDir ? { GIT_DIR: gitDir } : {};
    const test = native(dir, ["rev-list", "--test-bitmap", "HEAD"], undefined, env);
    expect(test.status).toBe(0);
    expect(test.stderr).toMatch(/OK!/);
    const list = (extra: string[]) =>
      native(dir, ["rev-list", "--objects", "--all", ...extra], undefined, env)
        .stdout.split("\n")
        .filter(Boolean)
        .map((l) => l.slice(0, 64))
        .sort();
    expect(list(["--use-bitmap-index"])).toEqual(list([]));
    const count = (extra: string[]) =>
      native(dir, ["rev-list", "--count", "--objects", "HEAD", "^HEAD~3", ...extra], undefined, env)
        .stdout;
    expect(count(["--use-bitmap-index"])).toBe(count([]));
  }

  describe("pack bitmaps (t5310)", () => {
    for (const lookupTable of [false, true]) {
      for (const hashCache of [true, false]) {
        it(`our .bitmap of git's pack is git's (lookup table ${lookupTable}, hash cache ${hashCache})`, async () => {
          const dir = bitmapRepo();
          g(
            dir,
            "-c",
            `pack.writeBitmapLookupTable=${lookupTable}`,
            "-c",
            `pack.writeBitmapHashCache=${hashCache}`,
            "repack",
            "-a",
            "-d",
            "-b",
            "-q",
          );
          const [bitmapName] = packNames(dir, ".bitmap");
          const theirs = readFileSync(join(packDir(dir), bitmapName as string));
          const backend = await open(dir);
          const [pack] = await backend.packs.packs();
          const listed = await listReachableObjects({
            files: backend.files,
            gitDir: ".git",
            refs: backend.history.refs,
            objects: backend.objects,
          });
          const ours = await writePackBitmap({
            pack: pack as PackFile,
            objects: backend.objects,
            listed,
            lookupTable,
            hashCache,
            compatibility,
          });
          expect(Buffer.from(ours).toString("hex")).toBe(theirs.toString("hex"));
        });
      }
    }

    it("repack -a -d -b writes a bitmap git tests, uses and counts with", async () => {
      const dir = bitmapRepo();
      const theirs = copyOf(dir);
      g(theirs, "repack", "-a", "-d", "-b", "-q");
      const r = await repack({
        ...(await open(dir)),
        all: true,
        writeBitmaps: true,
        compatibility,
      });
      expect(r?.bitmapWritten ?? packNames(dir, ".bitmap").length > 0).toBeTruthy();
      // our pack's bytes are ours: its bitmap is checked by native git (the bytes of a bitmap
      // of one pack are compared above)
      expect(packNames(dir, ".bitmap")).toHaveLength(1);
      expect(packNames(dir, ".bitmap")[0]).toMatch(/^pack-[0-9a-f]{64}\.bitmap$/);
      expectNativeUsesBitmap(dir);
      expectNativeFsckClean(dir);
    });

    it("git's bitmap read by ours: the walk lists what git lists", async () => {
      const dir = bitmapRepo();
      g(dir, "repack", "-a", "-d", "-b", "-q");
      const { packs, objects } = await open(dir);
      const index = await packs.bitmap?.();
      expect(index).toBeDefined();
      expect(packs.bitmapErrors).toEqual([]);
      expect(index?.pack.packId).toHaveLength(64);
      const head = g(dir, "rev-parse", "HEAD");
      const old = g(dir, "rev-parse", "HEAD~3");
      const walked = async (wants: string[], haves: string[]) => {
        const result = await bitmapWalk(index as NonNullable<typeof index>, objects, {
          wants,
          haves,
        });
        return [...result.objects()].map((o) => o.id).sort();
      };
      const listed = (args: string[]) =>
        g(dir, "rev-list", "--objects", ...args)
          .split("\n")
          .map((l) => l.slice(0, 64))
          .sort();
      expect(await walked([head], [])).toEqual(listed([head]));
      expect(await walked([head], [old])).toEqual(listed([head, `^${old}`, "--use-bitmap-index"]));
    });

    it("a bare repository's gc writes the bitmap and the graph git gc writes", async () => {
      const src = bitmapRepo();
      const dir = fresh();
      g(root, "clone", "-q", "--bare", "--no-local", src, dir);
      const theirs = fresh();
      cpSync(dir, theirs, { recursive: true });
      native(theirs, ["gc", "-q", "--prune=now"], undefined, { GIT_DIR: "." });
      const files = filesOf(dir);
      const env = environment();
      const { history } = await createGitFilesBackend({ files, gitDir: ".", environment: env });
      const worktrees = await openGitLinkedWorktrees({
        files,
        gitDir: ".",
        history,
        environment: env,
      });
      const git = Git.fromWorktreeAdmin(await worktrees.openAdmin());
      await git.gc().setPrune("now").call();
      const bitmaps = (d: string) =>
        readdirSync(join(d, "objects", "pack")).filter((f) => f.endsWith(".bitmap"));
      expect(bitmaps(theirs)).toHaveLength(1);
      expect(bitmaps(dir)).toHaveLength(1);
      expect(readFileSync(join(dir, "objects", "info", "commit-graph"))).toEqual(
        readFileSync(join(theirs, "objects", "info", "commit-graph")),
      );
      expectNativeUsesBitmap(dir, ".");
      const r = native(dir, fsckArgs(), undefined, { GIT_DIR: "." });
      expect([r.status, r.stderr]).toEqual([0, ""]);
    });

    it("a damaged bitmap falls back to walking, with git's error line", async () => {
      const dir = bitmapRepo();
      g(dir, "repack", "-a", "-d", "-b", "-q");
      const path = join(packDir(dir), packNames(dir, ".bitmap")[0] as string);
      const bytes = readFileSync(path);
      // a pack checksum of another pack: refused before the trailer is checked again
      bytes[12] = (bytes[12] as number) ^ 0xff;
      rmSync(path);
      writeFileSync(path, bytes);
      const { packs } = await open(dir);
      expect(await packs.bitmap?.()).toBeUndefined();
      expect(packs.bitmapErrors).toHaveLength(1);
      expect(packs.bitmapErrors?.[0]).toMatch(
        /^error: bitmap file '.*\.bitmap' has invalid checksum$/,
      );
    });
  });

  describe("multi-pack-index bitmaps (t5326-multi-pack-bitmaps.sh)", () => {
    /** packs of distinct dates, a merge, a tag, duplicates in a newer pack */
    function historyRepo(): string {
      const dir = packedRepo(4);
      g(dir, "checkout", "-q", "-b", "side", "HEAD~2");
      addCommit(dir, 10);
      g(dir, "checkout", "-q", "main");
      native(dir, ["merge", "-q", "--no-edit", "side"], undefined, {
        GIT_AUTHOR_DATE: "1700000100 +0000",
        GIT_COMMITTER_DATE: "1700000100 +0000",
      });
      g(dir, "repack", "-dq");
      native(dir, ["tag", "-a", "-m", "release", "v1", "HEAD~1"], undefined, {
        GIT_COMMITTER_DATE: "1700000200 +0000",
      });
      g(dir, "repack", "-dq");
      g(dir, "repack", "-aq");
      return dir;
    }
    const bitmapOf = (dir: string) => midxFiles(dir).find((f) => f.endsWith(".bitmap"));

    it("--bitmap writes native's midx bitmap bytes, and native tests and uses ours", async () => {
      const dir = historyRepo();
      for (const extra of [[], [`--preferred-pack=${packNames(dir, ".pack")[0]}`]]) {
        g(dir, "multi-pack-index", "write", "--bitmap", ...extra);
        const name = bitmapOf(dir) as string;
        expect(name).toMatch(/^multi-pack-index-[0-9a-f]{64}\.bitmap$/);
        const theirs = readFileSync(join(packDir(dir), name));
        const theirsMidx = readFileSync(midxPath(dir));
        clearMidx(dir);
        const preferredPack = extra[0]?.slice("--preferred-pack=".length);
        const r = await multiPackIndexWrite({
          files: filesOf(dir),
          compatibility,
          bitmap: true,
          ...(preferredPack ? { preferredPack } : {}),
        });
        expect(r.stderr).toEqual([]);
        expect(readFileSync(midxPath(dir)).equals(theirsMidx)).toBe(true);
        expect(bitmapOf(dir)).toBe(name);
        expect(readFileSync(join(packDir(dir), name)).equals(theirs)).toBe(true);
        expectNativeUsesBitmap(dir);
        clearMidx(dir);
      }
    });

    it("repack -b -m writes a midx bitmap native accepts; ours reads native's", async () => {
      const dir = historyRepo();
      const objects = allObjects(dir);
      const r = await repack({
        ...(await open(dir)),
        writeMidx: true,
        writeBitmaps: true,
        compatibility,
      });
      expect(r?.midx).toMatch(/^[0-9a-f]{64}$/);
      expect(bitmapOf(dir)).toBe(`multi-pack-index-${r?.midx}.bitmap`);
      expectNativeReadsAll(dir, objects);
      expectNativeUsesBitmap(dir);
      // native's midx bitmap, read by our pack set
      clearMidx(dir);
      g(dir, "multi-pack-index", "write", "--bitmap");
      const { packs } = await open(dir);
      const midx = await packs.multiPackIndex?.();
      const index = await packs.bitmap?.();
      expect(packs.bitmapErrors).toEqual([]);
      expect(index?.pack.packId).toBe(midx?.checksum);
    });
  });
});
