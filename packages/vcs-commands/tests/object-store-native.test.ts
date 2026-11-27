/**
 * Object-store commands against native git: `git prune` (without gc), `git count-objects`,
 * `git verify-pack -v`/`-s`, `git show-index`, and pack indexes of version 1 read and written.
 * Each scenario builds a repository with native git, copies it (`cp -a`, file times kept),
 * runs native git in one copy and ours in the other, and compares stdout, stderr, the exit
 * status and the files of the object directory (and `shallow`) afterwards. Scenarios come from
 * git's t5304-prune, t5301-sliding-window, t5302-pack-index and t2200-add-update, each named by
 * its source.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { writePackIndexV1 } from "@statewalker/vcs-core";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlumbingCommand, PlumbingOutput } from "../src/commands/plumbing-command.js";
import { Git } from "../src/index.js";
import {
  bareEnv,
  copyTwin,
  DAY,
  gcEnv,
  initRepo,
  type NativeRepo,
  NOW,
  newCase,
  openOursGc,
} from "./gc-native-twins-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;

/** Every file below `<gitDir>/objects` (and `shallow`), with `shallow`'s content. */
function objectFiles(gitDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        out.push(`${relative(gitDir, path)}/`);
        walk(path);
      } else out.push(relative(gitDir, path));
    }
  };
  walk(join(gitDir, "objects"));
  const shallow = join(gitDir, "shallow");
  if (existsSync(shallow)) out.push(`shallow: ${readFileSync(shallow, "latin1")}`);
  // update-server-info output and the like are not ours to compare
  return out.filter((p) => !p.startsWith("objects/info/")).sort();
}

interface Outcome {
  stdout: string;
  stderr: string;
  status: number;
}

/** Sorts the lines of a text (git lists a directory in readdir order, ours in name order). */
const sortedLines = (text: string) => text.split("\n").filter(Boolean).sort();

/**
 * Runs `git <args>` in the native twin of `<caseDir>/src/<repo>` and `ours(git)` in the other,
 * returning both outcomes and both git directories.
 */
async function twins(
  caseDir: string,
  args: string[],
  ours: (git: Git) => PlumbingCommand,
  options: {
    repo?: string;
    env?: Record<string, string>;
    input?: Uint8Array;
    /** run in this linked worktree of the repository (its directory and id) */
    linked?: string;
  } = {},
): Promise<{ native: Outcome; ours: Outcome; gitDirs: { native: string; ours: string } }> {
  const repo = options.repo ?? "repo";
  const nativeDir = copyTwin(caseDir, `native-${args.join("_").replace(/[^\w.=-]/g, "")}`);
  const oursDir = copyTwin(caseDir, `ours-${args.join("_").replace(/[^\w.=-]/g, "")}`);
  const r = spawnSync("git", args, {
    cwd: join(nativeDir, repo, options.linked ?? ""),
    env: gcEnv(root, { ...bareEnv(join(nativeDir, repo)), ...options.env }),
    ...(options.input ? { input: options.input } : {}),
  });
  const git = options.linked
    ? await openLinked(oursDir, repo, options.linked)
    : await openOursGc(root, oursDir, repo, options.env);
  const out: PlumbingOutput = await ours(git).callOutput();
  const gitDirOf = (twin: string) =>
    existsSync(join(twin, repo, ".git")) ? join(twin, repo, ".git") : join(twin, repo);
  return {
    native: {
      stdout: r.stdout.toString("latin1"),
      stderr: r.stderr.toString("latin1"),
      status: r.status ?? -1,
    },
    ours: {
      stdout: Buffer.from(out.stdout).toString("latin1"),
      stderr: out.stderr,
      status: out.exitCode,
    },
    gitDirs: { native: gitDirOf(nativeDir), ours: gitDirOf(oursDir) },
  };
}

/** Our working copy of the linked worktree `<repo>/<id>` of a twin. */
async function openLinked(twinDir: string, repo: string, id: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: twinDir });
  const environment = createNodeGitHostEnvironment({ env: gcEnv(root) });
  const gitDir = `${repo}/.git`;
  const { history } = await createGitFilesBackend({ files, gitDir, environment });
  const linked = await openGitLinkedWorktrees({
    files,
    gitDir: `${gitDir}/worktrees/${id}`,
    history,
    environment,
  });
  return Git.fromWorkingCopy(await linked.openCurrent());
}

/** Compares two twins' outcomes (stdout and stderr by sorted lines) and object files. */
function expectAlike(t: Awaited<ReturnType<typeof twins>>) {
  expect(t.ours.status).toBe(t.native.status);
  expect(sortedLines(t.ours.stdout)).toEqual(sortedLines(t.native.stdout));
  expect(sortedLines(t.ours.stderr)).toEqual(sortedLines(t.native.stderr));
  expect(objectFiles(t.gitDirs.ours)).toEqual(objectFiles(t.gitDirs.native));
}

/** A loose object's file. */
const looseFile = (r: NativeRepo, id: string) =>
  join(r.gitDir, "objects", id.slice(0, 2), id.slice(2));

/** Dates a file `seconds` before now (test-tool chmtime =-<seconds>). */
function chmtime(path: string, seconds: number) {
  const t = NOW - seconds;
  utimesSync(path, t, t);
}

/** t5304's setup: one commit of an empty file, then `git gc`. */
function setup(name: string) {
  const caseDir = newCase(root, name);
  const r = initRepo(root, caseDir);
  r.commit("initial", { file: "" });
  r.git(["gc", "-q"]);
  return { caseDir, r };
}

const prune =
  (configure: (c: ReturnType<Git["prune"]>) => ReturnType<Git["prune"]> = (c) => c) =>
  (git: Git) =>
    configure(git.prune());

describeGit("object-store commands twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "object-store-twins-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  describe("prune", () => {
    it('t5304-prune.sh: "prune stale packs"', async () => {
      const { caseDir, r } = setup("stale-packs");
      writeFileSync(join(r.gitDir, "objects/tmp_1.pack"), "");
      writeFileSync(join(r.gitDir, "objects/tmp_2.pack"), "");
      chmtime(join(r.gitDir, "objects/tmp_1.pack"), 86501);
      const t = await twins(
        caseDir,
        ["prune", "--expire", "1.day"],
        prune((c) => c.setExpire("1.day")),
      );
      expectAlike(t);
      expect(existsSync(join(t.gitDirs.ours, "objects/tmp_1.pack"))).toBe(false);
      expect(existsSync(join(t.gitDirs.ours, "objects/tmp_2.pack"))).toBe(true);
    });

    it('t5304-prune.sh: "prune --expire"', async () => {
      const { caseDir, r } = setup("expire");
      const blob = r.blob("aleph_0\n");
      let t = await twins(
        caseDir,
        ["prune", "--expire=1.hour.ago"],
        prune((c) => c.setExpire("1.hour.ago")),
      );
      expectAlike(t);
      expect(existsSync(join(t.gitDirs.ours, "objects", blob.slice(0, 2), blob.slice(2)))).toBe(
        true,
      );
      chmtime(looseFile(r, blob), 86500);
      t = await twins(
        caseDir,
        ["prune", "-v", "--expire", "1.day"],
        prune((c) => c.setVerbose(true).setExpire("1.day")),
      );
      expectAlike(t);
      expect(t.ours.stdout).toBe(`${blob} blob\n`);
    });

    it('t5304-prune.sh: "prune: prune nonsense parameters"', async () => {
      const { caseDir } = setup("nonsense");
      const t = await twins(
        caseDir,
        ["prune", "garbage"],
        prune((c) => c.addHead("garbage")),
      );
      expectAlike(t);
      expect(t.ours.stderr).toBe("fatal: unrecognized argument: garbage\n");
    });

    it('t5304-prune.sh: "prune: handle expire option correctly"', async () => {
      const { caseDir } = setup("malformed-expire");
      const t = await twins(
        caseDir,
        ["prune", "--expire=nyah"],
        prune((c) => c.setExpire("nyah")),
      );
      expectAlike(t);
      expect(t.ours.stderr).toBe("fatal: malformed expiration date 'nyah'\n");
      const never = await twins(
        caseDir,
        ["prune", "--no-expire"],
        prune((c) => c.setExpire(undefined)),
      );
      expectAlike(never);
    });

    it('t5304-prune.sh: "prune: prune unreachable heads"', async () => {
      const { caseDir, r } = setup("unreachable-heads");
      r.git(["config", "core.logAllRefUpdates", "false"]);
      r.commit("temporary", { file2: "" });
      r.git(["reset", "-q", "HEAD^"]);
      // every entry: they are younger than reflog expire's default
      r.git(["reflog", "expire", "--all", "--expire=all"]);
      const t = await twins(
        caseDir,
        ["prune", "-v"],
        prune((c) => c.setVerbose(true)),
      );
      expectAlike(t);
      expect(sortedLines(t.ours.stdout)).toHaveLength(2);
    });

    it('t5304-prune.sh: "prune: do not prune detached HEAD with no reflog"', async () => {
      const { caseDir, r } = setup("detached");
      r.git(["checkout", "--detach", "--quiet"]);
      r.git(["commit", "-q", "--allow-empty", "-m", "detached commit"]);
      r.git(["reflog", "expire", "--all", "--expire=all"]);
      const t = await twins(
        caseDir,
        ["prune", "-n"],
        prune((c) => c.setDryRun(true)),
      );
      expectAlike(t);
      expect(t.ours.stdout).toBe("");
    });

    it('t5304-prune.sh: "prune: prune former HEAD after checking out branch"', async () => {
      const { caseDir, r } = setup("former-head");
      r.git(["checkout", "--detach", "--quiet"]);
      const head = r.commit("detached commit");
      r.git(["checkout", "--quiet", "main"]);
      r.git(["reflog", "expire", "--all", "--expire=all"]);
      const t = await twins(
        caseDir,
        ["prune", "-v"],
        prune((c) => c.setVerbose(true)),
      );
      expectAlike(t);
      expect(t.ours.stdout).toContain(`${head} commit`);
    });

    it('t5304-prune.sh: "prune: do not prune heads listed as an argument"', async () => {
      const { caseDir, r } = setup("listed-heads");
      const head = r.commit("temporary", { file2: "" });
      r.git(["reset", "-q", "HEAD^"]);
      r.git(["reflog", "expire", "--all", "--expire=all"]);
      const t = await twins(
        caseDir,
        ["prune", "-v", "--", head],
        prune((c) => c.setVerbose(true).addHead(head)),
      );
      expectAlike(t);
      expect(t.ours.stdout).toBe("");
    });

    it('t5304-prune.sh: "prune --expire=never"', async () => {
      const { caseDir, r } = setup("never");
      const blob = r.blob("aleph_0\n");
      chmtime(looseFile(r, blob), 30 * DAY);
      const t = await twins(
        caseDir,
        ["prune", "--expire=never"],
        prune((c) => c.setExpire("never")),
      );
      expectAlike(t);
      const all = await twins(
        caseDir,
        ["prune", "-n"],
        prune((c) => c.setDryRun(true)),
      );
      expectAlike(all);
      expect(all.ours.stdout).toBe(`${blob} blob\n`);
    });

    it("prune -n lists loose objects a pack holds as `rm -f` (prune-packed.c)", async () => {
      const { caseDir, r } = setup("prune-packed");
      // loose copies of packed objects (unpacked again from the pack)
      const pack = readdirSync(join(r.gitDir, "objects/pack")).find((n) => n.endsWith(".pack"));
      const bytes = readFileSync(join(r.gitDir, "objects/pack", pack as string));
      const scratch = join(caseDir, "scratch");
      spawnSync("git", ["init", "-q", scratch], { env: gcEnv(root) });
      spawnSync("git", ["unpack-objects", "-q"], { cwd: scratch, input: bytes, env: gcEnv(root) });
      spawnSync("cp", ["-a", `${join(scratch, ".git/objects")}/.`, join(r.gitDir, "objects")]);
      const dry = await twins(
        caseDir,
        ["prune", "-n"],
        prune((c) => c.setDryRun(true)),
      );
      expectAlike(dry);
      expect(dry.ours.stdout).toMatch(/^rm -f \.git\/objects\//m);
      const real = await twins(caseDir, ["prune"], prune());
      expectAlike(real);
    });

    it('t5304-prune.sh: "prune .git/shallow"', async () => {
      const { caseDir, r } = setup("shallow");
      const oid = r.git(["commit-tree", "HEAD^{tree}"], { input: "hi\n" });
      writeFileSync(join(r.gitDir, "shallow"), `${oid}\n`);
      const dry = await twins(
        caseDir,
        ["prune", "--dry-run"],
        prune((c) => c.setDryRun(true)),
      );
      expectAlike(dry);
      expect(dry.ours.stdout).toContain(`Removing ${oid} from .git/shallow`);
      const real = await twins(caseDir, ["prune"], prune());
      expectAlike(real);
      expect(existsSync(join(real.gitDirs.ours, "shallow"))).toBe(false);
    });

    it('t5304-prune.sh: "prune .git/shallow when there are no loose objects"', async () => {
      const { caseDir, r } = setup("shallow-packed");
      const oid = r.git(["commit-tree", "HEAD^{tree}"], { input: "hi\n" });
      writeFileSync(join(r.gitDir, "shallow"), `${oid}\n`);
      r.git(["update-ref", "refs/heads/shallow-tip", oid]);
      r.git(["repack", "-q", "-ad"]);
      const t = await twins(caseDir, ["prune"], prune());
      expectAlike(t);
      expect(readFileSync(join(t.gitDirs.ours, "shallow"), "latin1")).toBe(`${oid}\n`);
    });

    it('t5304-prune.sh: "prune: handle alternate object database"', async () => {
      const caseDir = newCase(root, "alternates");
      const a = initRepo(root, caseDir, false, "A");
      a.commit("initial commit");
      a.git(["clone", "-q", "--shared", join(caseDir, "src/A"), join(caseDir, "src/B")]);
      a.git(["commit", "-q", "--allow-empty", "-m", "next commit"], {
        cwd: join(caseDir, "src/B"),
      });
      // the twins' alternates point at their own copy of A, which ours reads below the root
      const t = await twins(
        caseDir,
        ["prune", "-v"],
        prune((c) => c.setVerbose(true)),
        { repo: "B" },
      );
      expectAlike(t);
    });

    it('t5304-prune.sh: "prune: handle index in multiple worktrees"', async () => {
      const { caseDir, r } = setup("worktree-index");
      r.git(["worktree", "add", "-q", "second-worktree"]);
      const second = join(r.dir, "second-worktree");
      writeFileSync(join(second, "blob"), "new blob for second-worktree\n");
      r.git(["add", "blob"], { cwd: second });
      const t = await twins(
        caseDir,
        ["prune", "-v", "--expire=now"],
        prune((c) => c.setVerbose(true).setExpire("now")),
      );
      expectAlike(t);
      expect(t.ours.stdout).toBe("");
    });

    it('t5304-prune.sh: "prune: handle HEAD in multiple worktrees", "prune: handle HEAD reflog in multiple worktrees"', async () => {
      const { caseDir, r } = setup("worktree-head");
      r.git(["config", "core.logAllRefUpdates", "true"]);
      r.git(["worktree", "add", "-q", "--detach", "third-worktree"]);
      const third = join(r.dir, "third-worktree");
      writeFileSync(join(third, "blob"), "new blob for third-worktree\n");
      r.git(["add", "blob"], { cwd: third });
      r.git(["commit", "-q", "-m", "third"], { cwd: third });
      writeFileSync(join(third, "blob"), "lost blob for third-worktree\n");
      r.git(["add", "blob"], { cwd: third });
      r.git(["commit", "-q", "-m", "second commit in third"], { cwd: third });
      r.git(["reset", "-q", "--hard", "HEAD^"], { cwd: third });
      rmSync(join(r.gitDir, "worktrees/third-worktree/index"));
      const t = await twins(
        caseDir,
        ["prune", "-v", "--expire=now"],
        prune((c) => c.setVerbose(true).setExpire("now")),
      );
      expectAlike(t);
      expect(t.ours.stdout).toBe("");
    });

    it('t5304-prune.sh: "old reachable-from-recent retained with bitmaps"', async () => {
      const { caseDir, r } = setup("recent-walk");
      r.git(["repack", "-q", "-adb"]);
      const toDrop = r.blob("bitmap-from-recent-1\n");
      chmtime(looseFile(r, toDrop), 86400);
      const toSave = r.blob("bitmap-from-recent-2\n");
      chmtime(looseFile(r, toSave), 86400);
      const tree = r.git(["mktree"], { input: `100644 blob ${toSave}\tfile\n` });
      chmtime(looseFile(r, tree), 86400);
      const commit = r.git(["commit-tree", tree], { input: "foo\n" });
      const t = await twins(
        caseDir,
        ["prune", "-v", "--expire=12.hours.ago"],
        prune((c) => c.setVerbose(true).setExpire("12.hours.ago")),
      );
      expectAlike(t);
      expect(t.ours.stdout).toBe(`${toDrop} blob\n`);
      expect(existsSync(join(t.gitDirs.ours, "objects", commit.slice(0, 2), commit.slice(2)))).toBe(
        true,
      );
    });

    it("a recent packed object keeps the old loose objects it reaches (reachable.c add_recent_packed)", async () => {
      const { caseDir, r } = setup("recent-packed");
      const blob = r.blob("old blob reached from a young pack\n");
      const tree = r.git(["mktree"], { input: `100644 blob ${blob}\tfile\n` });
      const commit = r.git(["commit-tree", tree], { input: "young\n" });
      // the commit alone in a young pack, its tree and blob old and loose
      r.git(["pack-objects", "-q", join(r.gitDir, "objects/pack/pack")], { input: `${commit}\n` });
      rmSync(looseFile(r, commit));
      chmtime(looseFile(r, tree), 3 * DAY);
      chmtime(looseFile(r, blob), 3 * DAY);
      const old = r.blob("old and alone\n");
      chmtime(looseFile(r, old), 3 * DAY);
      const t = await twins(
        caseDir,
        ["prune", "-v", "--expire=1.day.ago"],
        prune((c) => c.setVerbose(true).setExpire("1.day.ago")),
      );
      expectAlike(t);
      expect(t.ours.stdout).toBe(`${old} blob\n`);
    });

    it("stale tmp_obj_ files and bad sha1 files in a fan-out directory (builtin/prune.c prune_cruft)", async () => {
      const { caseDir, r } = setup("cruft");
      const blob = r.blob("cruft neighbour\n");
      const fan = join(r.gitDir, "objects", blob.slice(0, 2));
      writeFileSync(join(fan, "tmp_obj_old"), "");
      chmtime(join(fan, "tmp_obj_old"), 3 * DAY);
      writeFileSync(join(fan, "tmp_obj_new"), "");
      writeFileSync(join(fan, "not-an-object"), "");
      writeFileSync(join(r.gitDir, "objects/pack/tmp_pack_old"), "");
      chmtime(join(r.gitDir, "objects/pack/tmp_pack_old"), 3 * DAY);
      const t = await twins(
        caseDir,
        ["prune", "-v", "--expire=1.day.ago"],
        prune((c) => c.setVerbose(true).setExpire("1.day.ago")),
      );
      expectAlike(t);
      expect(t.ours.stderr).toContain("bad sha1 file: .git/objects/");
    });
  });

  describe("count-objects", () => {
    const count =
      (verbose: boolean, human = false) =>
      (git: Git) =>
        git.countObjects().setVerbose(verbose).setHumanReadable(human);

    it('t2200-add-update.sh: "add -n -u should not add but just report" (count-objects -v, -H)', async () => {
      const { caseDir, r } = setup("counts");
      for (let i = 0; i < 20; i++) r.blob(`loose ${i}\n${"x".repeat(i * 500)}`);
      // a loose copy of a packed object: prune-packable
      r.git(["cat-file", "blob", "HEAD:file"]);
      const pack = readdirSync(join(r.gitDir, "objects/pack")).find((n) => n.endsWith(".pack"));
      const scratch = join(caseDir, "scratch");
      spawnSync("git", ["init", "-q", scratch], { env: gcEnv(root) });
      spawnSync("git", ["unpack-objects", "-q"], {
        cwd: scratch,
        input: readFileSync(join(r.gitDir, "objects/pack", pack as string)),
        env: gcEnv(root),
      });
      spawnSync("cp", ["-a", `${join(scratch, ".git/objects")}/.`, join(r.gitDir, "objects")]);
      for (const [args, verbose, human] of [
        [["count-objects"], false, false],
        [["count-objects", "-v"], true, false],
        [["count-objects", "-H"], false, true],
        [["count-objects", "-v", "-H"], true, true],
      ] as const) {
        const t = await twins(caseDir, [...args], count(verbose, human));
        expect(t.ours, args.join(" ")).toEqual(t.native);
      }
    });

    it('t5304-prune.sh: "garbage report in count-objects -v"', async () => {
      const { caseDir, r } = setup("garbage");
      const packDir = join(r.gitDir, "objects/pack");
      for (const name of [
        "foo",
        "foo.bar",
        "foo.keep",
        "foo.pack",
        "fake.bar",
        "fake.keep",
        "fake.pack",
        "fake.idx",
        "fake2.keep",
        "fake3.idx",
      ])
        writeFileSync(join(packDir, name), "");
      r.blob("a loose object\n");
      const t = await twins(caseDir, ["count-objects", "-v"], count(true));
      expect(t.ours.status).toBe(t.native.status);
      expect(t.ours.stdout).toBe(t.native.stdout);
      expect(sortedLines(t.ours.stderr)).toEqual(sortedLines(t.native.stderr));
      expect(t.ours.stderr).toContain("index file .git/objects/pack/fake.idx is too small");
    });

    it('t5304-prune.sh: "clean pack garbage with gc" (count-objects -v after gc)', async () => {
      const { caseDir, r } = setup("garbage-after-gc");
      const packDir = join(r.gitDir, "objects/pack");
      for (const name of [
        "foo.keep",
        "foo.pack",
        "fake.idx",
        "fake2.keep",
        "fake2.idx",
        "fake3.keep",
      ])
        writeFileSync(join(packDir, name), "");
      r.git(["gc", "-q", "--no-cruft"]);
      const t = await twins(caseDir, ["count-objects", "-v"], count(true));
      expect(t.ours.stdout).toBe(t.native.stdout);
      expect(sortedLines(t.ours.stderr)).toEqual(sortedLines(t.native.stderr));
    });

    it('t5304-prune.sh: "prune: handle alternate object database" (count-objects -v lists the alternate)', async () => {
      const caseDir = newCase(root, "count-alternates");
      const a = initRepo(root, caseDir, false, "A");
      a.commit("initial commit");
      a.git(["clone", "-q", "--shared", join(caseDir, "src/A"), join(caseDir, "src/B")]);
      const t = await twins(caseDir, ["count-objects", "-v"], count(true), { repo: "B" });
      // each twin's alternate is its own copy of A
      const twinOf = (gitDir: string) => gitDir.slice(0, -"/B/.git".length);
      expect(t.ours.stdout.replace(twinOf(t.gitDirs.ours), "<twin>")).toBe(
        t.native.stdout.replace(twinOf(t.gitDirs.native), "<twin>"),
      );
      expect(t.ours.stderr).toBe(t.native.stderr);
      expect(t.ours.stdout).toMatch(/^alternate: \//m);
    });
    it('t5304-prune.sh: "garbage report in count-objects -v" (from a linked worktree)', async () => {
      const { caseDir, r } = setup("garbage-worktree");
      r.git(["worktree", "add", "-q", "linked"]);
      writeFileSync(join(r.gitDir, "objects/pack/foo"), "");
      writeFileSync(join(r.gitDir, "objects/pack/foo.keep"), "");
      const t = await twins(caseDir, ["count-objects", "-v"], count(true), { linked: "linked" });
      const twinOf = (gitDir: string) => gitDir.slice(0, gitDir.indexOf("/repo/"));
      expect(t.ours.stdout).toBe(t.native.stdout);
      expect(sortedLines(t.ours.stderr.replaceAll(twinOf(t.gitDirs.ours), "<twin>"))).toEqual(
        sortedLines(t.native.stderr.replaceAll(twinOf(t.gitDirs.native), "<twin>")),
      );
      expect(t.ours.stderr).toContain("/repo/.git/objects/pack/foo");
    });
  });

  describe("verify-pack and pack indexes", () => {
    /** A repository with a few hundred objects and deltas (t5301-sliding-window's setup). */
    function slidingWindow(name: string) {
      const caseDir = newCase(root, name);
      const r = initRepo(root, caseDir);
      let content = "";
      for (let i = 1; i <= 25; i++) {
        content += `${"x".repeat(200)} ${i}\n`;
        r.commit(`commit #${i}`, { [`file${i % 5}`]: content, z: `${i}\n` });
      }
      r.git(["repack", "-q", "-a", "-d"]);
      return { caseDir, r };
    }

    const packOf = (gitDir: string) =>
      join(
        gitDir,
        "objects/pack",
        readdirSync(join(gitDir, "objects/pack")).find((n) => n.endsWith(".idx")) as string,
      );

    it('t5301-sliding-window.sh: "verify-pack -v, defaults", "verify-pack -v, packedGitWindowSize == 1 page"', async () => {
      const { caseDir, r } = slidingWindow("sliding-window");
      const idx = relative(r.dir, packOf(r.gitDir));
      const git = await openOursGc(root, join(caseDir, "src"));
      const files = createNodeFilesApi({ rootDir: r.dir });
      for (const config of [
        [],
        ["-c", "core.packedGitWindowSize=4k", "-c", "core.packedGitLimit=4k"],
      ]) {
        for (const flag of ["-v", "-s"]) {
          const native = spawnSync("git", [...config, "verify-pack", flag, idx], {
            cwd: r.dir,
            env: gcEnv(root),
          });
          const ours = await git
            .verifyPack()
            .setRepositoryFiles({ files })
            .addPack(idx)
            .setVerbose(flag === "-v")
            .setStatOnly(flag === "-s")
            .call();
          expect(ours.exitCode).toBe(native.status);
          expect(ours.output).toBe(native.stdout.toString());
        }
      }
    });

    it('t5302-pack-index.sh: "pack-objects with index version 1", "index-pack with index version 1": show-index and verify-pack -v read version 1 as git', async () => {
      const { caseDir, r } = slidingWindow("idx-v1");
      const idx = packOf(r.gitDir);
      const pack = idx.replace(/\.idx$/, ".pack");
      const v1 = join(caseDir, "v1.idx");
      r.git(["index-pack", "--index-version=1", "-o", v1, pack]);
      const v2 = join(caseDir, "v2.idx");
      r.git(["index-pack", "--index-version=2", "-o", v2, pack]);
      for (const file of [v1, v2]) {
        const input = readFileSync(file);
        const native = spawnSync("git", ["show-index"], { cwd: r.dir, env: gcEnv(root), input });
        const git = await openOursGc(root, join(caseDir, "src"));
        const ours = await git.showIndex().setInput(new Uint8Array(input)).callOutput();
        expect(Buffer.from(ours.stdout).toString()).toBe(native.stdout.toString());
        expect(ours.exitCode).toBe(native.status);
      }
      // the pack with its version 1 index: verify-pack -v and object reads
      const caseV1 = newCase(root, "idx-v1-repo");
      spawnSync("cp", ["-a", join(caseDir, "src/repo"), join(caseV1, "src/repo")]);
      const gitDirV1 = join(caseV1, "src/repo/.git");
      const idxV1 = packOf(gitDirV1);
      // git writes .idx files 0444; CI does not run as root
      chmodSync(idxV1, 0o644);
      writeFileSync(idxV1, readFileSync(v1));
      rmSync(idxV1.replace(/\.idx$/, ".rev"), { force: true });
      const rel = relative(join(caseV1, "src/repo"), idxV1);
      const native = spawnSync("git", ["verify-pack", "-v", rel], {
        cwd: join(caseV1, "src/repo"),
        env: gcEnv(root),
      });
      expect(native.status).toBe(0);
      const git = await openOursGc(root, join(caseV1, "src"));
      const files = createNodeFilesApi({ rootDir: join(caseV1, "src/repo") });
      const ours = await git
        .verifyPack()
        .setRepositoryFiles({ files })
        .addPack(rel)
        .setVerbose(true)
        .call();
      expect(ours.output).toBe(native.stdout.toString());
      expect(ours.exitCode).toBe(0);
      // every object reads through the version 1 index
      const fsck = await git.countObjects().setVerbose(true).callOutput();
      const nativeCount = spawnSync("git", ["count-objects", "-v"], {
        cwd: join(caseV1, "src/repo"),
        env: gcEnv(root),
      });
      expect(Buffer.from(fsck.stdout).toString()).toBe(nativeCount.stdout.toString());
      const log = spawnSync("git", ["rev-list", "--objects", "--all"], {
        cwd: join(caseV1, "src/repo"),
        env: gcEnv(root),
      });
      for (const line of log.stdout.toString().split("\n").filter(Boolean)) {
        const id = line.slice(0, 40);
        expect(await git.history?.objects?.has(id)).toBe(true);
        const object = await git.history?.objects?.getRaw?.(id);
        expect(object).toBeDefined();
      }
    });

    it('t5302-pack-index.sh: "index-pack with index version 1": our version 1 writer is byte for byte git\'s', async () => {
      const { caseDir, r } = slidingWindow("idx-v1-write");
      const idx = packOf(r.gitDir);
      const pack = idx.replace(/\.idx$/, ".pack");
      const v1 = join(caseDir, "v1.idx");
      r.git(["index-pack", "--index-version=1", "-o", v1, pack]);
      // the entries as show-index of the version 2 index gives them
      const shown = spawnSync("git", ["show-index"], { input: readFileSync(idx) })
        .stdout.toString()
        .trim();
      const entries = shown
        .split("\n")
        .map((l) => l.split(" "))
        .map(([offset, id, crc]) => ({
          id: id as string,
          offset: Number(offset),
          crc32: Number.parseInt((crc as string).slice(1, -1), 16),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const packBytes = readFileSync(pack);
      const checksum = new Uint8Array(packBytes.subarray(packBytes.length - 20));
      const ours = await writePackIndexV1(entries, checksum);
      expect(Buffer.from(ours).equals(readFileSync(v1))).toBe(true);
      // native git reads ours: index-pack --verify and verify-pack
      // native git reads ours: index-pack --verify (t5302's "index-pack --verify on index
      // version 1") and verify-pack, the pack beside our index
      const mine = join(caseDir, "mine.pack");
      writeFileSync(mine, packBytes);
      writeFileSync(join(caseDir, "mine.idx"), ours);
      const verify = spawnSync("git", ["index-pack", "--verify", "--index-version=1", mine], {
        cwd: r.dir,
        env: gcEnv(root),
      });
      expect(verify.status, verify.stderr.toString()).toBe(0);
      const verifyPack = spawnSync("git", ["verify-pack", join(caseDir, "mine.idx")], {
        cwd: r.dir,
        env: gcEnv(root),
      });
      expect(verifyPack.status, verifyPack.stderr.toString()).toBe(0);
      expect(verify.status, verify.stderr.toString()).toBe(0);
    });

    it('t5302-pack-index.sh: "index v2: force some 64-bit offsets with pack-objects": show-index prints them as git', async () => {
      const { caseDir, r } = slidingWindow("idx-64");
      // past 0x40000 bytes of pack: incompressible content
      writeFileSync(join(r.dir, "big"), randomBytes(300 * 1024));
      r.commit("big");
      writeFileSync(join(r.dir, "big2"), randomBytes(300 * 1024));
      r.commit("big2");
      const out = join(caseDir, "test-3");
      const objects = r
        .git(["rev-list", "--objects", "--all"])
        .split("\n")
        .map((l) => l.slice(0, 40));
      const name = r.git(["pack-objects", "--index-version=2,0x40000", out], {
        input: `${objects.join("\n")}\n`,
      });
      const input = readFileSync(`${out}-${name}.idx`);
      const native = spawnSync("git", ["show-index"], { cwd: r.dir, env: gcEnv(root), input });
      const git = await openOursGc(root, join(caseDir, "src"));
      const ours = await git.showIndex().setInput(new Uint8Array(input)).callOutput();
      expect(Buffer.from(ours.stdout).toString()).toBe(native.stdout.toString());
      expect(native.stdout.toString()).toMatch(/^\d{6,} /m);
    });

    it("show-index dies as git on a short or corrupt index (builtin/show-index.c)", async () => {
      const { caseDir, r } = slidingWindow("idx-short");
      const idx = readFileSync(packOf(r.gitDir));
      const git = () => openOursGc(root, join(caseDir, "src"));
      const v1 = join(caseDir, "v1.idx");
      r.git([
        "index-pack",
        "--index-version=1",
        "-o",
        v1,
        packOf(r.gitDir).replace(/\.idx$/, ".pack"),
      ]);
      const v1Bytes = readFileSync(v1);
      const corrupt = Buffer.from(idx);
      corrupt.writeUInt32BE(0xffffffff, 8 + 4 * 10);
      for (const input of [
        idx.subarray(0, 4),
        idx.subarray(0, 100),
        idx.subarray(0, 8 + 1024 + 20 * 3),
        idx.subarray(0, idx.length - 60),
        v1Bytes.subarray(0, 1024 + 24 * 2 + 5),
        Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 3]),
        corrupt,
      ]) {
        const native = spawnSync("git", ["show-index"], { cwd: r.dir, env: gcEnv(root), input });
        const ours = await (await git()).showIndex().setInput(new Uint8Array(input)).callOutput();
        expect(ours.stderr).toBe(native.stderr.toString());
        expect(ours.exitCode).toBe(native.status);
        expect(Buffer.from(ours.stdout).toString()).toBe(native.stdout.toString());
      }
    });
  });
});
