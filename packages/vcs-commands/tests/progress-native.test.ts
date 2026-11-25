/**
 * Progress callbacks (`GitCommand.setProgress`, JGit's `ProgressMonitor`) against the lines
 * native git prints with `--progress` (or on a terminal, for `repack` and `gc`, which have no
 * such option): each scenario runs native git in one twin and ours in the other and compares
 * the phases, in order, with their last count and total. Native git's lines are read through
 * `GIT_PROGRESS_DELAY=0` (delayed phases show at once).
 *
 * Phases ours does not report are left out of native's list before the comparison, each
 * named here: the commit-graph's phases of gc (they change with every version), `refs
 * verify`'s "Checking ref database" of 2.5x fsck (ours is fsck `--no-references`), and the
 * delta search's "Compressing objects", whose count is the delta search's candidates (ours
 * and git's pack writers pick them differently: ours only has to finish it).
 *
 * Every phase also cancels: a monitor that throws mid-phase makes the command fail, leaving
 * the repository as git leaves the command interrupted there (no temporary pack, no index
 * lock, HEAD and the refs unchanged).
 *
 * Scenarios: t5301-sliding-window.sh (repack, fsck), t7700-repack.sh (repack with a kept
 * pack), t5302-pack-index.sh (index-pack), t7201-co.sh (checkout), t5601-clone.sh (clone's
 * checkout).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPack } from "@statewalker/vcs-core";
import type { ProgressMonitor, ProgressUpdate } from "@statewalker/vcs-utils";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Git } from "../src/index.js";
import {
  copyTwin,
  gcEnv,
  initRepo,
  type NativeRepo,
  nativeIs25x,
  newCase,
  openOursGc,
} from "./gc-native-twins-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const hasScript = spawnSync("script", ["--version"]).status === 0;
const describeGit =
  nativeGitAvailable() && process.platform === "linux" && hasScript ? describe : describe.skip;

let root: string;

/** One phase as shown last: its title, count and total (none for a counter). */
interface Phase {
  phase: string;
  done: number;
  total?: number;
}

/** Phases ours does not report (see the module comment). */
const NOT_REPORTED = [
  /^Checking ref database$/,
  /commit graph/,
  /^Collecting referenced commits$/,
  /^Compressing objects$/,
];

/**
 * The phases of git's progress lines, in order: each `<title>: NN% (done/total)` or
 * `<title>: done` line, consecutive lines of one title folded into the last one shown.
 * `remote:` lines and lines that are not progress are skipped.
 */
function parseNative(text: string): Phase[] {
  const out: Phase[] = [];
  // the terminal's line clearing (`ESC [ K`)
  const clean = text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g"), "");
  for (const raw of clean.split(/[\r\n]/)) {
    const line = raw.trim();
    if (!line || line.startsWith("remote:")) continue;
    const pct = /^(.+?):\s+\d+% \((\d+)\/(\d+)\)/.exec(line);
    const count = pct ? undefined : /^(.+?): (\d+)(?:, done\.)?$/.exec(line);
    const m = pct ?? count;
    if (!m) continue;
    const phase: Phase = {
      phase: m[1] as string,
      done: Number(m[2]),
      ...(pct ? { total: Number(pct[3]) } : {}),
    };
    const last = out[out.length - 1];
    if (last && last.phase === phase.phase) out[out.length - 1] = phase;
    else out.push(phase);
  }
  return out.filter((p) => !NOT_REPORTED.some((r) => r.test(p.phase)));
}

/** A monitor recording every report, and the phases it finished. */
function recorder() {
  const updates: ProgressUpdate[] = [];
  const monitor: ProgressMonitor = (u) => {
    updates.push(u);
  };
  const phases = (): Phase[] =>
    updates
      .filter((u) => u.finished)
      .filter((u) => !NOT_REPORTED.some((r) => r.test(u.phase)))
      .map((u) => ({
        phase: u.phase,
        done: u.done,
        ...(u.total !== undefined ? { total: u.total } : {}),
      }));
  return { monitor, updates, phases };
}

/** Each phase counts up to its total and never past it, and ends once. */
function expectWellFormed(updates: ProgressUpdate[]) {
  let current: string | undefined;
  let last = 0;
  for (const u of updates) {
    if (u.phase !== current) {
      current = u.phase;
      last = 0;
    }
    expect(u.done, `${u.phase} counts up`).toBeGreaterThanOrEqual(last);
    if (u.total !== undefined)
      expect(u.done, `${u.phase} within its total`).toBeLessThanOrEqual(u.total);
    last = u.done;
  }
}

/** A monitor throwing at the `at`-th report of `phase`. */
function cancelAt(phase: string, at = 1): ProgressMonitor {
  let n = 0;
  return (u) => {
    if (u.phase === phase && ++n === at) throw new Error(`cancelled in ${phase}`);
  };
}

/** Native git's stderr (or a terminal's output with `tty`), run in `cwd`. */
function native(cwd: string, args: string[], options: { tty?: boolean } = {}): string {
  const env = gcEnv(root, { GIT_PROGRESS_DELAY: "0" });
  if (options.tty) {
    const quoted = ["git", ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    const r = spawnSync("script", ["-qec", quoted, "/dev/null"], { cwd, env });
    expect(r.status, `${args.join(" ")}: ${r.stdout}`).toBe(0);
    return r.stdout.toString();
  }
  const r = spawnSync("git", args, { cwd, env });
  expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
  return r.stderr.toString();
}

/** `n` bytes of pseudo-random text seeded by `seed` (t5301's `test-tool genrandom`). */
function random(seed: string, n: number): string {
  let x = 0;
  for (const c of seed) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  let out = "";
  while (out.length < n) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += String.fromCharCode(97 + ((x >>> 16) % 26));
    if (out.length % 64 === 63) out += "\n";
  }
  return out;
}

/** t5301-sliding-window.sh's history: four files, `d` a copy of `c` (a delta), two commits. */
function slidingWindowRepo(caseDir: string): NativeRepo {
  const repo = initRepo(root, caseDir);
  const files: Record<string, string> = {};
  for (const i of ["a", "b", "c"]) files[i] = `${i}\n${random(i, 32 * 1024)}`;
  files.d = `d\n${files.c}`;
  repo.commit("one", files);
  repo.commit("two", { e: `e\n${random("e", 1024)}` });
  return repo;
}

/** A path's `.git`, or the path itself for a bare repository. */
function gitDirOf(dir: string): string {
  return existsSync(join(dir, ".git")) ? join(dir, ".git") : dir;
}

/** The files of the pack directory (the temporaries a cancelled write must not leave). */
function packFiles(dir: string): string[] {
  const pack = join(gitDirOf(dir), "objects", "pack");
  return existsSync(pack) ? readdirSync(pack).sort() : [];
}

describeGit("progress callbacks against native git's --progress", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "progress-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t5301-sliding-window.sh: "repack -a -d, packedGit{WindowSize,Limit} == 1 page"', async () => {
    const caseDir = newCase(root, "repack");
    const repo = slidingWindowRepo(caseDir);
    repo.git(["repack", "-a", "-d", "-q"]);
    repo.commit("three", { f: `f\n${random("f", 2048)}` });
    const nativeTwin = copyTwin(caseDir, "native");
    const oursTwin = copyTwin(caseDir, "ours");
    const theirs = parseNative(
      native(join(nativeTwin, "repo"), ["repack", "-a", "-d"], { tty: true }),
    );
    const ours = recorder();
    const git = await openOursGc(root, oursTwin);
    await git.repack().setAll(true).setDeleteRedundant(true).setProgress(ours.monitor).call();
    expectWellFormed(ours.updates);
    expect(ours.phases()).toEqual(theirs);
    expect(theirs.map((p) => p.phase)).toEqual([
      "Enumerating objects",
      "Counting objects",
      "Writing objects",
      "Removing duplicate objects",
    ]);
    // the delta search ran to its end
    const compressing = ours.updates.filter((u) => u.phase === "Compressing objects" && u.finished);
    for (const c of compressing) expect(c.done).toBe(c.total);
  });

  it('t7700-repack.sh: "objects in packs marked .keep are not repacked"', async () => {
    const caseDir = newCase(root, "keep");
    const repo = slidingWindowRepo(caseDir);
    repo.git(["repack", "-a", "-d", "-q"]);
    const pack = readdirSync(join(repo.gitDir, "objects", "pack")).find((n) => n.endsWith(".pack"));
    writeFileSync(join(repo.gitDir, "objects", "pack", `${pack?.replace(/\.pack$/, "")}.keep`), "");
    repo.commit("three", { f: `f\n${random("f", 2048)}`, g: "g\n" });
    const nativeTwin = copyTwin(caseDir, "native");
    const oursTwin = copyTwin(caseDir, "ours");
    const theirs = parseNative(
      native(join(nativeTwin, "repo"), ["repack", "-a", "-d"], { tty: true }),
    );
    const ours = recorder();
    const git = await openOursGc(root, oursTwin);
    await git.repack().setAll(true).setDeleteRedundant(true).setProgress(ours.monitor).call();
    expectWellFormed(ours.updates);
    expect(ours.phases()).toEqual(theirs);
  });

  it('t7700-repack.sh: "--quiet disables progress"', async () => {
    const caseDir = newCase(root, "quiet");
    slidingWindowRepo(caseDir);
    const oursTwin = copyTwin(caseDir, "ours");
    const ours = recorder();
    const git = await openOursGc(root, oursTwin);
    await git
      .repack()
      .setAll(true)
      .setDeleteRedundant(true)
      .setQuiet(true)
      .setProgress(ours.monitor)
      .call();
    expect(ours.updates).toEqual([]);
  });

  it("t5301-sliding-window.sh: \"setup\": gc's repack phases as native gc's", async () => {
    const caseDir = newCase(root, "gc");
    slidingWindowRepo(caseDir);
    const nativeTwin = copyTwin(caseDir, "native");
    const oursTwin = copyTwin(caseDir, "ours");
    const theirs = parseNative(native(join(nativeTwin, "repo"), ["gc"], { tty: true }));
    const ours = recorder();
    const git = await openOursGc(root, oursTwin);
    await git.gc().setProgress(ours.monitor).call();
    expectWellFormed(ours.updates);
    expect(ours.phases()).toEqual(theirs);
  });

  it('t5301-sliding-window.sh: "setup": a monitor that throws while the pack is written', async () => {
    const caseDir = newCase(root, "repack-cancel");
    const repo = slidingWindowRepo(caseDir);
    repo.git(["repack", "-a", "-d", "-q"]);
    repo.commit("three", { f: "f\n" });
    const oursTwin = copyTwin(caseDir, "ours");
    const dir = join(oursTwin, "repo");
    const before = packFiles(dir);
    const looseBefore = readdirSync(join(dir, ".git", "objects")).sort();
    const git = await openOursGc(root, oursTwin);
    await expect(
      git
        .repack()
        .setAll(true)
        .setDeleteRedundant(true)
        .setProgress(cancelAt("Writing objects", 3))
        .call(),
    ).rejects.toThrow("cancelled in Writing objects");
    // pack-objects died: no new pack, no temporary, nothing replaced or pruned
    expect(packFiles(dir)).toEqual(before);
    expect(readdirSync(join(dir, ".git", "objects")).sort()).toEqual(looseBefore);
    const fsck = spawnSync("git", ["fsck", "--strict", "--no-progress"], {
      cwd: dir,
      env: gcEnv(root),
    });
    expect(fsck.status, fsck.stderr.toString()).toBe(0);
  });

  it('t5301-sliding-window.sh: "verify-pack -v, defaults": fsck --progress', async () => {
    const caseDir = newCase(root, "fsck");
    const repo = slidingWindowRepo(caseDir);
    repo.git(["repack", "-a", "-d", "-q"]);
    repo.commit("three", { f: "f\n" });
    const nativeTwin = copyTwin(caseDir, "native");
    const oursTwin = copyTwin(caseDir, "ours");
    const theirs = parseNative(native(join(nativeTwin, "repo"), ["fsck", "--progress"]));
    const ours = recorder();
    const git = await openOursGc(root, oursTwin);
    const result = await git
      .fsck()
      .setRepositoryFiles({ files: createNodeFilesApi({ rootDir: oursTwin }), gitDir: "repo/.git" })
      .setCompatibility(nativeIs25x ? "2.56" : "2.43")
      .setProgress(ours.monitor)
      .call();
    expect(result.exitCode).toBe(0);
    expectWellFormed(ours.updates);
    expect(ours.phases()).toEqual(theirs);
    expect(theirs.map((p) => p.phase)).toContain("Checking connectivity");
  });

  it('t5301-sliding-window.sh: "verify-pack -v, defaults": a monitor that throws stops fsck', async () => {
    const caseDir = newCase(root, "fsck-cancel");
    slidingWindowRepo(caseDir);
    const oursTwin = copyTwin(caseDir, "ours");
    const git = await openOursGc(root, oursTwin);
    await expect(
      git.fsck().setProgress(cancelAt("Checking connectivity", 2)).call(),
    ).rejects.toThrow("cancelled in Checking connectivity");
  });

  it('t5302-pack-index.sh: "index-pack -v --stdin produces progress for both phases"', async () => {
    const caseDir = newCase(root, "index-pack");
    const repo = slidingWindowRepo(caseDir);
    const id = repo.git(["pack-objects", "--all", join(caseDir, "pack")], { input: "" });
    const packPath = join(caseDir, `pack-${id}.pack`);
    const target = initRepo(root, caseDir, true, "target");
    const theirs = parseNative(
      spawnSync("git", ["index-pack", "-v", "--stdin"], {
        cwd: target.dir,
        env: gcEnv(root, { GIT_PROGRESS_DELAY: "0", GIT_DIR: target.dir }),
        input: readFileSync(packPath),
      }).stderr.toString(),
    );
    expect(theirs.map((p) => p.phase)).toEqual(["Receiving objects", "Resolving deltas"]);
    const ours = recorder();
    const dir = join(caseDir, "ours-pack");
    mkdirSync(dir);
    const files = createNodeFilesApi({ rootDir: dir });
    const source = async function* () {
      yield new Uint8Array(readFileSync(packPath));
    };
    await installPack(files, "pack", source(), { progress: ours.monitor });
    expectWellFormed(ours.updates);
    expect(ours.phases()).toEqual(theirs);
    // a pack file (not --stdin) is "Indexing objects"
    const indexing = recorder();
    await installPack(files, "pack2", source(), {
      progress: indexing.monitor,
      progressTitle: "Indexing objects",
    });
    const theirsFile = parseNative(
      spawnSync("git", ["index-pack", "-v", "-o", join(caseDir, "x.idx"), packPath], {
        cwd: caseDir,
        env: gcEnv(root, { GIT_PROGRESS_DELAY: "0" }),
      }).stderr.toString(),
    );
    expect(indexing.phases()).toEqual(theirsFile);
    // cancelled while resolving: nothing installed, no temporary left
    const cancelled = join(caseDir, "cancelled");
    mkdirSync(join(cancelled, "pack"), { recursive: true });
    await expect(
      installPack(createNodeFilesApi({ rootDir: cancelled }), "pack", source(), {
        progress: cancelAt("Resolving deltas"),
      }),
    ).rejects.toThrow("cancelled in Resolving deltas");
    expect(readdirSync(join(cancelled, "pack"))).toEqual([]);
  });

  /** t7201-co.sh's setup: main, renamer, side and simple. */
  function coRepo(caseDir: string): NativeRepo {
    const repo = initRepo(root, caseDir);
    const fill = (...lines: string[]) => lines.map((l) => `${l}\n`).join("");
    repo.commit("Initial A one, A two", {
      same: fill("x", "y", "z"),
      one: fill("1", "2", "3", "4", "5", "6", "7", "8"),
      two: fill("a", "b", "c", "d", "e"),
    });
    repo.git(["checkout", "-q", "-b", "renamer"]);
    rmSync(join(repo.dir, "one"));
    repo.commit("Renamer R one->uno, M two", {
      uno: fill("1", "3", "4", "5", "6", "7", "8"),
      two: fill("a", "b", "c", "d", "e", "f"),
    });
    repo.git(["checkout", "-q", "-b", "side", "main"]);
    rmSync(join(repo.dir, "two"));
    repo.commit("Side M one, D two, A three", {
      one: fill("1", "2", "3", "4", "5", "6", "7"),
      three: fill("A", "B", "C", "D", "E"),
    });
    repo.git(["checkout", "-q", "-b", "simple", "main"]);
    rmSync(join(repo.dir, "one"));
    repo.commit("Simple D one, M two", { two: fill("a", "c", "e") });
    repo.git(["checkout", "-q", "main"]);
    return repo;
  }

  it('t7201-co.sh: "setup": checkout --progress between its branches', async () => {
    const caseDir = newCase(root, "checkout");
    coRepo(caseDir);
    const nativeTwin = copyTwin(caseDir, "native");
    const oursTwin = copyTwin(caseDir, "ours");
    const git = await openOursGc(root, oursTwin);
    for (const branch of ["side", "simple", "renamer", "main", "renamer"]) {
      const theirs = parseNative(
        native(join(nativeTwin, "repo"), ["checkout", "--progress", branch]),
      );
      const ours = recorder();
      await git.checkout().setName(branch).setProgress(ours.monitor).call();
      expectWellFormed(ours.updates);
      expect(ours.phases(), `to ${branch}`).toEqual(theirs);
      expect(theirs[0]?.phase).toBe("Updating files");
    }
  });

  it('t7201-co.sh: "setup": a monitor that throws while files are updated', async () => {
    const caseDir = newCase(root, "checkout-cancel");
    coRepo(caseDir);
    const oursTwin = copyTwin(caseDir, "ours");
    const dir = join(oursTwin, "repo");
    const head = readFileSync(join(dir, ".git", "HEAD"), "utf8");
    const index = readFileSync(join(dir, ".git", "index"));
    const git = await openOursGc(root, oursTwin);
    await expect(
      git.checkout().setName("side").setProgress(cancelAt("Updating files", 2)).call(),
    ).rejects.toThrow("cancelled in Updating files");
    // as an interrupted git checkout: HEAD and the index untouched, no lock left
    expect(readFileSync(join(dir, ".git", "HEAD"), "utf8")).toBe(head);
    expect(readFileSync(join(dir, ".git", "index")).equals(index)).toBe(true);
    expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
  });

  it('t5601-clone.sh: "clone checks out files": clone --progress', async () => {
    const caseDir = newCase(root, "clone");
    coRepo(caseDir);
    const src = join(caseDir, "src", "repo");
    const theirs = parseNative(native(caseDir, ["clone", "--progress", src, "native"]));
    expect(theirs.map((p) => p.phase)).toEqual(["Updating files"]);
    mkdirSync(join(caseDir, "ours"));
    spawnSync("git", ["init", "-q", "-b", "main"], {
      cwd: join(caseDir, "ours"),
      env: gcEnv(root),
    });
    const git: Git = await openOurs(
      caseDir,
      createNodeGitHostEnvironment({ env: gcEnv(root) }),
      undefined,
      "ours",
    );
    const ours = recorder();
    await git.clone().setURI(src).setProgress(ours.monitor).call();
    expectWellFormed(ours.updates);
    expect(ours.phases()).toEqual(theirs);
  });

  it('t5601-clone.sh: "clone checks out files": clone --no-local --progress', async () => {
    const caseDir = newCase(root, "clone-fetch");
    const repo = slidingWindowRepo(caseDir);
    repo.git(["repack", "-a", "-d", "-q"]);
    const src = join(caseDir, "src", "repo");
    const theirs = parseNative(
      native(caseDir, ["clone", "--no-local", "--progress", src, "native"]),
    ).filter((p) => p.phase !== "Checking objects" && p.phase !== "Checking connectivity");
    mkdirSync(join(caseDir, "ours"));
    spawnSync("git", ["init", "-q", "-b", "main"], {
      cwd: join(caseDir, "ours"),
      env: gcEnv(root),
    });
    const git: Git = await openOurs(
      caseDir,
      createNodeGitHostEnvironment({ env: gcEnv(root) }),
      undefined,
      "ours",
    );
    const ours = recorder();
    await git.clone().setURI(src).setLocal(false).setProgress(ours.monitor).call();
    expectWellFormed(ours.updates);
    expect(ours.phases()).toEqual(theirs);
    expect(theirs.map((p) => p.phase)).toEqual([
      "Receiving objects",
      "Resolving deltas",
      "Updating files",
    ]);
  });

  it('t5301-sliding-window.sh: "setup": a monitor that throws in gc\'s repack', async () => {
    const caseDir = newCase(root, "gc-cancel");
    const repo = slidingWindowRepo(caseDir);
    repo.git(["repack", "-a", "-d", "-q"]);
    repo.commit("three", { f: "f\n" });
    const oursTwin = copyTwin(caseDir, "ours");
    const dir = join(oursTwin, "repo");
    const before = packFiles(dir);
    const refs = spawnSync("git", ["show-ref"], { cwd: dir, env: gcEnv(root) }).stdout.toString();
    const git = await openOursGc(root, oursTwin);
    await expect(git.gc().setProgress(cancelAt("Writing objects", 2)).call()).rejects.toThrow(
      "cancelled in Writing objects",
    );
    // as an interrupted git gc: no new pack nor temporary, the lock released, refs kept
    expect(packFiles(dir)).toEqual(before);
    expect(existsSync(join(dir, ".git", "gc.pid"))).toBe(false);
    expect(spawnSync("git", ["show-ref"], { cwd: dir, env: gcEnv(root) }).stdout.toString()).toBe(
      refs,
    );
    const fsck = spawnSync("git", ["fsck", "--strict", "--no-progress"], {
      cwd: dir,
      env: gcEnv(root),
    });
    expect(fsck.status, fsck.stderr.toString()).toBe(0);
  });

  for (const phase of ["Receiving objects", "Resolving deltas", "Updating files"]) {
    it(`t5601-clone.sh: "clone checks out files": a clone cancelled in ${phase}`, async () => {
      const caseDir = newCase(root, `clone-cancel-${phase.replace(/ /g, "-")}`);
      const repo = slidingWindowRepo(caseDir);
      repo.git(["repack", "-a", "-d", "-q"]);
      const src = join(caseDir, "src", "repo");
      const dest = join(caseDir, "ours");
      mkdirSync(dest);
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dest, env: gcEnv(root) });
      const git: Git = await openOurs(
        caseDir,
        createNodeGitHostEnvironment({ env: gcEnv(root) }),
        undefined,
        "ours",
      );
      await expect(
        git.clone().setURI(src).setLocal(false).setProgress(cancelAt(phase, 2)).call(),
      ).rejects.toThrow(`cancelled in ${phase}`);
      // no pack or temporary left half-written; a pack is only there once fully installed
      for (const name of packFiles(dest))
        expect(name).toMatch(/^pack-[0-9a-f]{40}\.(pack|idx|rev)$/);
      if (phase !== "Updating files") {
        // the fetch failed before any ref was written
        expect(packFiles(dest)).toEqual([]);
        const refs = spawnSync("git", ["for-each-ref"], { cwd: dest, env: gcEnv(root) });
        expect(refs.stdout.toString()).toBe("");
      } else {
        // the repository is kept (git's JUNK_LEAVE_REPO): its objects and refs are whole
        const fsck = spawnSync("git", ["fsck", "--strict", "--no-progress"], {
          cwd: dest,
          env: gcEnv(root),
        });
        expect(fsck.status, fsck.stderr.toString()).toBe(0);
        expect(existsSync(join(dest, ".git", "index.lock"))).toBe(false);
      }
    });
  }
});
