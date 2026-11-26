/**
 * `git repo info` and `git repo structure` (builtin/repo.c), native twins: t1900-repo-info.sh
 * and t1901-repo-structure.sh run by native git and by ours on the same repository, git as the
 * oracle (stdout bytes, stderr, exit status). Runs against the git on PATH and `$GIT3` (git
 * master), each skipped when it has no `git repo` (2.43). The key table follows what the
 * native `--keys` lists (2.54/2.55, 2.56, master).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RepoCompatibility } from "../src/index.js";
import {
  type NativeGit,
  NativeShell,
  nativeGits,
  type Outcome,
  openOursAt,
  openOursFromEnvironment,
  outcomeOf,
} from "./repo-native-support.js";

const runnable = process.platform !== "win32";

/** `git repo info <argv>` mapped onto RepoInfoCommand. */
async function oursInfo(
  shell: NativeShell,
  dir: string,
  argv: string[],
  compatibility: RepoCompatibility,
  cwd = "",
): Promise<Outcome> {
  const git = await openOursAt(shell.home, dir);
  return outcomeOf(() => {
    const command = git.repoInfo().setCompatibility(compatibility).setCurrentDirectory(cwd);
    for (const arg of argv) {
      if (arg === "-z") command.setNul();
      else if (arg.startsWith("--format=")) command.setFormat(arg.slice(9));
      else if (arg === "--all") command.setAll(true);
      else if (arg === "--keys") command.setShowKeys(true);
      else command.addKeys(arg);
    }
    return command.callOutput();
  });
}

/** `git repo structure <argv>` mapped onto RepoStructureCommand. */
async function oursStructure(shell: NativeShell, dir: string, argv: string[]): Promise<Outcome> {
  const git = await openOursAt(shell.home, dir);
  return outcomeOf(() => {
    const command = git.repoStructure();
    for (const arg of argv) {
      if (arg === "-z") command.setNul();
      else if (arg.startsWith("--format=")) command.setFormat(arg.slice(9));
      else if (arg === "--progress") command.setShowProgress(true);
      else if (arg === "--no-progress") command.setShowProgress(false);
    }
    return command.callOutput();
  });
}

for (const native of nativeGits()) {
  describeRepo(native);
}

function describeRepo(native: NativeGit) {
  describe.runIf(runnable)(`git repo, native twins (${native.label})`, () => {
    let root: string;
    let shell: NativeShell;
    let compatibility: RepoCompatibility | undefined;
    let counter = 0;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "repo-native-"));
      shell = new NativeShell(native, root);
      shell.ok(shell.home, "init", "-q", "probe");
      compatibility = shell.repoCompatibility(join(shell.home, "probe"));
    });
    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    /** A new repository made by `git init <args>`. */
    const init = (...args: string[]): string => {
      const dir = join(shell.home, `r${counter++}`);
      shell.ok(shell.home, "init", "-q", ...args, dir);
      return dir;
    };

    async function info(dir: string, argv: string[], cwd = ""): Promise<Outcome> {
      if (!compatibility) throw new Error("no git repo");
      const nativeOut = shell.run(cwd ? join(dir, cwd) : dir, ["repo", "info", ...argv]);
      const ours = await oursInfo(shell, dir, argv, compatibility, cwd);
      expect(ours).toEqual(nativeOut);
      return nativeOut;
    }

    async function structure(dir: string, argv: string[]): Promise<Outcome> {
      const nativeOut = shell.run(dir, ["repo", "structure", ...argv]);
      const ours = await oursStructure(shell, dir, argv);
      expect(ours).toEqual(nativeOut);
      return nativeOut;
    }

    const skip = () => !compatibility;

    describe("t1900-repo-info.sh", () => {
      it("t1900-repo-info.sh: 'lines: ref format files is retrieved correctly'", async ({
        skip: s,
      }) => {
        if (skip()) s();
        const key = compatibility === "2.57" ? "references.storageFormat" : "references.format";
        const files = init("--ref-format=files");
        await info(files, [key]);
        await info(files, ["--format=nul", key]);
        const reftable = init("--ref-format=reftable");
        await info(reftable, [key]);
        await info(reftable, ["--format=nul", key]);
      });

      it("t1900-repo-info.sh: 'lines: bare repository = true is retrieved correctly'", async ({
        skip: s,
      }) => {
        if (skip()) s();
        await info(init(), ["layout.bare"]);
        await info(init("--bare"), ["layout.bare"]);
        await info(init("--bare"), ["--format=nul", "layout.bare"]);
      });

      it("t1900-repo-info.sh: 'lines: shallow repository = true is retrieved correctly'", async ({
        skip: s,
      }) => {
        if (skip()) s();
        await info(init(), ["layout.shallow"]);
        const remote = init();
        shell.commit(remote, "x");
        const shallow = join(shell.home, `r${counter++}`);
        shell.ok(shell.home, "clone", "-q", "--depth", "1", `file://${remote}`, shallow);
        await info(shallow, ["layout.shallow"]);
        await info(shallow, ["--format=nul", "layout.shallow"]);
      });

      it("t1900-repo-info.sh: 'lines: object.format = sha256 is retrieved correctly'", async ({
        skip: s,
      }) => {
        if (skip()) s();
        await info(init("--object-format=sha1"), ["object.format"]);
        await info(init("--object-format=sha256"), ["object.format"]);
      });

      it("t1900-repo-info.sh: 'lines: objects.storageFormat = files is retrieved correctly'", async ({
        skip: s,
      }) => {
        if (skip()) s();
        await info(init(), ["objects.storageFormat"]);
      });

      it("t1900-repo-info.sh: 'values returned in order requested'", async ({ skip: s }) => {
        if (skip()) s();
        const dir = init("--ref-format=files");
        await info(dir, ["layout.bare", "object.format", "layout.bare"]);
      });

      it("t1900-repo-info.sh: 'git-repo-info fails if an invalid key is requested'", async ({
        skip: s,
      }) => {
        if (skip()) s();
        const dir = init();
        const out = await info(dir, ["foo"]);
        expect(out.status).not.toBe(0);
        await info(dir, ["foo", "object.format", "bar"]);
      });

      it("t1900-repo-info.sh: 'git-repo-info aborts when requesting an invalid format'", async ({
        skip: s,
      }) => {
        if (skip()) s();
        const out = await info(init(), ["--format=foo"]);
        expect(out.status).toBe(128);
      });

      it("t1900-repo-info.sh: '-z uses nul-terminated format'", async ({ skip: s }) => {
        if (skip()) s();
        const dir = init();
        await info(dir, ["-z", "layout.bare", "layout.shallow"]);
        // t1900-repo-info.sh: "git repo info uses the last requested format"
        await info(dir, ["--format=nul", "-z", "--format=lines", "layout.bare"]);
      });

      it("t1900-repo-info.sh: 'git repo info --all and git repo info $(git repo info --keys) output the same data'", async ({
        skip: s,
      }) => {
        if (skip()) s();
        const dir = init();
        mkdirSync(join(dir, "sub"));
        await info(dir, ["--all"]);
        await info(dir, ["--all", "-z"]);
        await info(dir, ["--keys"]);
        await info(dir, ["--all"], "sub");
        await info(init("--bare"), ["--all"]);
      });

      it("t1900-repo-info.sh: 'git repo info --all <key> aborts'", async ({ skip: s }) => {
        if (skip()) s();
        await info(init(), ["--all", "object.format"]);
      });

      it("t1900-repo-info.sh: 'git repo info --keys --format=nul uses nul-terminated output'", async ({
        skip: s,
      }) => {
        if (skip()) s();
        const dir = init();
        await info(dir, ["--keys", "--format=nul"]);
        await info(dir, ["--keys", "--format=lines"]);
        // t1900-repo-info.sh: "git repo info --keys aborts when using --format other than lines or nul"
        await info(dir, ["--keys", "--format=table"]);
        // t1900-repo-info.sh: "git repo info --keys aborts when requesting keys"
        await info(dir, ["--keys", "--all"]);
        await info(dir, ["--keys", "some.key"]);
      });

      it("t1900-repo-info.sh: 'absolute: commondir standard'", async ({ skip: s }) => {
        if (skip() || compatibility === "2.54") s();
        const dir = init();
        mkdirSync(join(dir, "sub"));
        for (const key of [
          "path.commondir.absolute",
          "path.commondir.relative",
          "path.gitdir.absolute",
          "path.gitdir.relative",
        ]) {
          await info(dir, [key]);
          await info(dir, [key], "sub");
        }
      });

      it("t1900-repo-info.sh: 'absolute: gitdir standard'", async ({ skip: s }) => {
        if (skip() || compatibility === "2.54") s();
        // the same keys in a linked worktree (git worktree add)
        const dir = init();
        shell.commit(dir, "base");
        const wt = join(shell.home, `wt${counter++}`);
        shell.ok(dir, "worktree", "add", "-q", wt);
        const nativeOut = shell.run(wt, ["repo", "info", "--all"]);
        expect(await oursInfo(shell, wt, ["--all"], compatibility as RepoCompatibility)).toEqual(
          nativeOut,
        );
      });

      it("t1900-repo-info.sh: 'path.prefix in subdirectory'", async ({ skip: s }) => {
        if (compatibility !== "2.57") s();
        const dir = init();
        mkdirSync(join(dir, "sub/dir"), { recursive: true });
        await info(dir, ["path.prefix"]);
        await info(dir, ["path.prefix"], "sub/dir");
        // t1900-repo-info.sh: "absolute: index standard", "relative: index standard"
        await info(dir, ["path.index.absolute", "path.index.relative"], "sub/dir");
        // t1900-repo-info.sh: "path.workingtree absolute and relative"
        await info(dir, ["path.workingtree.absolute", "path.workingtree.relative"], "sub/dir");
        await info(dir, ["path.workingtree.relative"]);
        // t1900-repo-info.sh: "path.superprojectworkingtree returns empty when not in a submodule"
        await info(dir, [
          "path.superprojectworkingtree.absolute",
          "path.superprojectworkingtree.relative",
        ]);
      });

      it("t1900-repo-info.sh: 'path.workingtree absolute and relative in a bare repository'", async ({
        skip: s,
      }) => {
        if (compatibility !== "2.57") s();
        const bare = init("--bare");
        await info(bare, ["path.workingtree.absolute", "path.workingtree.relative"]);
        // t1900-repo-info.sh: "path.index in a bare repository returns default index location"
        await info(bare, ["path.index.absolute", "path.index.relative"]);
      });

      it("t1900-repo-info.sh: 'path.superprojectworkingtree absolute and relative'", async ({
        skip: s,
      }) => {
        if (compatibility !== "2.57") s();
        const sub = init();
        shell.commit(sub, "initial");
        const sup = init();
        shell.ok(sup, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
        shell.ok(sup, "commit", "-q", "-m", "add submodule");
        const keys = [
          "path.superprojectworkingtree.absolute",
          "path.superprojectworkingtree.relative",
        ];
        const nativeOut = shell.run(join(sup, "sub"), ["repo", "info", ...keys]);
        const ours = await oursInfo(shell, join(sup, "sub"), keys, "2.57");
        expect(ours).toEqual(nativeOut);
        const all = shell.run(join(sup, "sub"), ["repo", "info", "--all"]);
        expect(await oursInfo(shell, join(sup, "sub"), ["--all"], "2.57")).toEqual(all);
      });

      /** `git repo info <keys>` run in `cwd` with `env`, ours opened from the same variables. */
      async function infoFromEnvironment(
        cwd: string,
        env: Record<string, string>,
        keys: string[],
      ): Promise<Outcome> {
        const nativeOut = shell.run(cwd, ["repo", "info", ...keys], { env });
        const {
          git,
          prefix,
          cwd: setupDirectory,
        } = await openOursFromEnvironment(shell.home, cwd, env);
        const ours = await outcomeOf(() =>
          git
            .repoInfo()
            .setCompatibility(compatibility as RepoCompatibility)
            .setSetupDirectory(setupDirectory)
            .setCurrentDirectory(prefix.replace(/\/$/, ""))
            .setAll(keys.includes("--all"))
            .addKeys(...keys.filter((key) => key !== "--all"))
            .callOutput(),
        );
        expect(ours).toEqual(nativeOut);
        return nativeOut;
      }

      const commondirKeys = ["path.commondir.absolute", "path.commondir.relative"];
      const gitdirKeys = ["path.gitdir.absolute", "path.gitdir.relative"];

      it("t1900-repo-info.sh: 'absolute: commondir with GIT_COMMON_DIR and GIT_DIR'", async ({
        skip: s,
      }) => {
        if (skip() || compatibility === "2.54") s();
        // t1900-repo-info.sh: "relative: commondir with GIT_COMMON_DIR and GIT_DIR"
        const dir = init();
        mkdirSync(join(dir, "sub"));
        const common = join(dir, "custom-common");
        shell.ok(shell.home, "init", "-q", "--bare", common);
        const env = { GIT_COMMON_DIR: common, GIT_DIR: "../.git" };
        const out = await infoFromEnvironment(join(dir, "sub"), env, commondirKeys);
        expect(out.stdout).toContain(`path.commondir.absolute=${common}\n`);
        await infoFromEnvironment(join(dir, "sub"), env, gitdirKeys);
      });

      it("t1900-repo-info.sh: 'absolute: commondir with only GIT_DIR'", async ({ skip: s }) => {
        if (skip() || compatibility === "2.54") s();
        // t1900-repo-info.sh: "relative: commondir with only GIT_DIR"
        const dir = init();
        mkdirSync(join(dir, "sub"));
        const env = { GIT_DIR: "../.git" };
        await infoFromEnvironment(join(dir, "sub"), env, commondirKeys);
        // t1900-repo-info.sh: "absolute: gitdir with explicit GIT_DIR"
        const out = await infoFromEnvironment(join(dir, "sub"), env, gitdirKeys);
        expect(out.stdout).toContain("path.gitdir.relative=../.git\n");
        // t1900-repo-info.sh: "relative: gitdir with explicit GIT_DIR"
        await infoFromEnvironment(join(dir, "sub"), { GIT_DIR: join(dir, ".git") }, gitdirKeys);
      });

      it("t1900-repo-info.sh: 'absolute: index with GIT_INDEX_FILE override'", async ({
        skip: s,
      }) => {
        if (compatibility !== "2.57") s();
        // t1900-repo-info.sh: "relative: index with GIT_INDEX_FILE override"
        const dir = init();
        mkdirSync(join(dir, "sub"));
        const keys = ["path.index.absolute", "path.index.relative"];
        await infoFromEnvironment(
          join(dir, "sub"),
          { GIT_INDEX_FILE: join(dir, "custom-index-file") },
          keys,
        );
        await infoFromEnvironment(join(dir, "sub"), { GIT_INDEX_FILE: "custom-index" }, keys);
        await infoFromEnvironment(
          join(dir, "sub"),
          { GIT_DIR: "../.git", GIT_INDEX_FILE: "idx" },
          keys,
        );
        // outside the worktree git's setup stays where it started: the index is read there,
        // and the relative keys are relative to it (statewalker/webrun-vcs#457)
        const out = join(shell.home, `out${counter++}`);
        mkdirSync(out);
        const outside = await infoFromEnvironment(
          out,
          { GIT_DIR: join(dir, ".git"), GIT_WORK_TREE: dir, GIT_INDEX_FILE: "idx" },
          [...keys, "path.gitdir.relative", "path.workingtree.relative"],
        );
        expect(outside.stdout).toContain("path.index.relative=idx\n");
        await infoFromEnvironment(
          out,
          {
            GIT_DIR: `../${basename(dir)}/.git`,
            GIT_WORK_TREE: `../${basename(dir)}`,
            GIT_INDEX_FILE: "idx",
          },
          ["--all"],
        );
        // a bare `$GIT_DIR`: git stays where it started, and so does a relative index
        const bare = init("--bare");
        const bareOut = await infoFromEnvironment(
          out,
          { GIT_DIR: `../${basename(bare)}`, GIT_INDEX_FILE: "idx" },
          [...keys, ...gitdirKeys],
        );
        expect(bareOut.stdout).toContain(`path.index.absolute=${realpathSync(out)}/idx\n`);
        await infoFromEnvironment(out, { GIT_DIR: `../${basename(bare)}` }, ["--all"]);
      });

      /** `repo info`'s superproject keys in `dir`, native and ours. */
      async function superproject(dir: string): Promise<Outcome> {
        const keys = [
          "path.superprojectworkingtree.absolute",
          "path.superprojectworkingtree.relative",
        ];
        const nativeOut = shell.run(dir, ["repo", "info", ...keys]);
        expect(await oursInfo(shell, dir, keys, "2.57")).toEqual(nativeOut);
        return nativeOut;
      }

      it("path.superprojectworkingtree of an embedded submodule, nested ones and a dropped gitlink", async ({
        skip: s,
      }) => {
        if (compatibility !== "2.57") s();
        const sup = init();
        shell.commit(sup, "base");
        // an embedded `.git` directory: `git submodule add ./inner inner` over a repository
        const inner = join(sup, "inner");
        shell.ok(shell.home, "init", "-q", inner);
        shell.commit(inner, "inner");
        shell.ok(
          sup,
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "-q",
          "./inner",
          "inner",
        );
        let out = await superproject(inner);
        expect(out.stdout).toContain(`path.superprojectworkingtree.absolute=${sup}\n`);
        // a submodule below a directory: the superproject is two levels up
        mkdirSync(join(sup, "libs"));
        const deep = join(sup, "libs", "deep");
        shell.ok(shell.home, "init", "-q", deep);
        shell.commit(deep, "deep");
        shell.ok(
          sup,
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "-q",
          "./libs/deep",
          "libs/deep",
        );
        out = await superproject(deep);
        expect(out.stdout).toContain(`path.superprojectworkingtree.relative=../../\n`);
        // a submodule of the superproject's linked worktree (`.git/worktrees/<id>/modules/`)
        shell.ok(sup, "commit", "-q", "-m", "submodules");
        const linked = join(shell.home, `wt${counter++}`);
        shell.ok(sup, "worktree", "add", "-q", linked);
        shell.ok(
          linked,
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "update",
          "-q",
          "--init",
          "inner",
        );
        out = await superproject(join(linked, "inner"));
        expect(out.stdout).toContain(`path.superprojectworkingtree.absolute=${linked}\n`);
        // a repository the parent does not track: no superproject
        const loose = join(sup, "loose");
        shell.ok(shell.home, "init", "-q", loose);
        out = await superproject(loose);
        expect(out.stdout).toContain("path.superprojectworkingtree.absolute=\n");
        // a submodule under .git/modules whose gitlink left the superproject's index
        const sub = init();
        shell.commit(sub, "initial");
        shell.ok(sup, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "mod");
        await superproject(join(sup, "mod"));
        shell.ok(sup, "rm", "-q", "--cached", "mod");
        out = await superproject(join(sup, "mod"));
        expect(out.stdout).toContain("path.superprojectworkingtree.absolute=\n");
      });
    });

    describe("t1901-repo-structure.sh", () => {
      it("t1901-repo-structure.sh: 'empty repository'", async ({ skip: s }) => {
        if (skip()) s();
        const dir = init();
        await structure(dir, []);
        await structure(dir, ["--format=lines"]);
      });

      it("t1901-repo-structure.sh: 'repository with references and objects'", async ({
        skip: s,
      }) => {
        if (skip()) s();
        const dir = init("--ref-format=files");
        shell.commitBulk(dir, 1005);
        shell.ok(dir, "tag", "-a", "foo", "-m", "bar");
        const head = shell.ok(dir, "rev-parse", "HEAD").trim();
        shell.ok(dir, "update-ref", "refs/remotes/origin/foo", head);
        shell.ok(dir, "notes", "add", "-m", "foo");
        await structure(dir, []);
        await structure(dir, ["--format=lines"]);
      }, 120_000);

      it("t1901-repo-structure.sh: 'lines and nul format'", async ({ skip: s }) => {
        if (skip()) s();
        const dir = init();
        shell.commitBulk(dir, 42);
        shell.ok(dir, "tag", "-a", "foo", "-m", "bar");
        await structure(dir, ["--format=lines"]);
        await structure(dir, ["--format=nul"]);
        await structure(dir, ["--format=table", "-z"]);
        await structure(dir, []);
      });

      it("t1901-repo-structure.sh: 'progress meter option'", async ({ skip: s }) => {
        if (skip()) s();
        const dir = init();
        shell.commit(dir, "foo");
        const nativeOut = shell.run(dir, ["repo", "structure", "--progress"], {
          env: { GIT_PROGRESS_DELAY: "0" },
        });
        const ours = await oursStructure(shell, dir, ["--progress"]);
        expect(ours.stdout).toBe(nativeOut.stdout);
        expect(nativeOut.stderr).toContain("Counting references: 2, done.");
        expect(nativeOut.stderr).toContain("Counting objects: 3, done.");
        expect(ours.stderr).toContain("Counting references: 2, done.");
        expect(ours.stderr).toContain("Counting objects: 3, done.");
        await structure(dir, ["--no-progress"]);
      });

      it("shared trees, merges, tags of trees and blobs, a loose and a packed copy", async ({
        skip: s,
      }) => {
        if (skip()) s();
        const dir = init();
        shell.commit(dir, "a");
        shell.ok(dir, "checkout", "-q", "-b", "side");
        shell.commit(dir, "b");
        shell.ok(dir, "checkout", "-q", "-");
        shell.commit(dir, "c");
        shell.tick();
        shell.ok(dir, "merge", "-q", "--no-edit", "side");
        shell.ok(dir, "repack", "-adq");
        shell.commit(dir, "d");
        const tree = shell.ok(dir, "rev-parse", "HEAD^{tree}").trim();
        const blob = shell.ok(dir, "rev-parse", "HEAD:a.t").trim();
        shell.ok(dir, "tag", "-a", "-m", "tree", "tree-tag", tree);
        shell.ok(dir, "tag", "blob-tag", blob);
        shell.ok(dir, "tag", "-a", "-m", "nested", "nested", "tree-tag");
        await structure(dir, []);
        await structure(dir, ["--format=lines"]);
      });
    });
  });
}
