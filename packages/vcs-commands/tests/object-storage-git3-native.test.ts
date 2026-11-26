/**
 * git master's `extensions.objectStorage` and its variables (`$GIT_OBJECT_STORAGE_FORMAT`,
 * `$GIT_DEFAULT_OBJECT_STORAGE_FORMAT`, `init.defaultObjectStorageFormat`) against the git
 * master oracle (`$GIT3`, skipped without it: no release has the extension yet, 2.43 and
 * 2.56 refuse it as an unknown extension). The one format is `files`; a plain `files`
 * repository opens as any other, while `files://<directory>` (objects outside `objects/`) is
 * refused before anything is read or written, and only that repository is: a superproject
 * whose submodule uses one still has its status and diff (statewalker/webrun-vcs#441), and a
 * clone of one says why it is refused. The scenarios are t7427's (git master): its formats
 * run through init and open, and its `submodule add`/`update` and `clone` options.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Git } from "../src/index.js";
import { ourClone, ourCloneFails } from "./clone-options-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { git3Binary, nativeGit3Env } from "./native-git3.js";

const git3 = git3Binary();

describe.skipIf(!git3)("extensions.objectStorage (git master)", () => {
  let root = "";
  let n = 0;
  const fresh = (name: string) => join(root, `${name}-${n++}`);
  const env = (extra: Record<string, string> = {}) => ({
    ...nativeGit3Env(root),
    GIT_DEFAULT_REF_FORMAT: "files",
    GIT_AUTHOR_NAME: "A",
    GIT_AUTHOR_EMAIL: "a@example.com",
    GIT_COMMITTER_NAME: "C",
    GIT_COMMITTER_EMAIL: "c@example.com",
    GIT_AUTHOR_DATE: "1700000000 +0000",
    GIT_COMMITTER_DATE: "1700000000 +0000",
    ...extra,
  });
  const git = (cwd: string, args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync(git3 as string, args, { cwd, env: env(extra), encoding: "utf8" });
    return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
  };
  /** A repository with one commit and `extensions.objectStorage = <value>` (version 1). */
  const repoWith = (value: string | undefined) => {
    const dir = fresh("repo");
    mkdirSync(dir);
    expect(git(dir, ["init", "-q"]).status).toBe(0);
    expect(git(dir, ["commit", "-q", "--allow-empty", "-m", "one"]).status).toBe(0);
    expect(git(dir, ["config", "core.repositoryformatversion", "1"]).status).toBe(0);
    if (value !== undefined) {
      expect(git(dir, ["config", "extensions.objectStorage", value]).status).toBe(0);
    }
    return dir;
  };
  /** Our init in `dir` with `extra` variables: the lines it dies with, or its warnings. */
  const oursInit = async (dir: string, extra: Record<string, string>) => {
    mkdirSync(dir, { recursive: true });
    const init = Git.init()
      .setFilesApi(createNodeFilesApi({ rootDir: dir }))
      .setEnvironment(createNodeGitHostEnvironment({ env: env(extra) }));
    try {
      const result = await init.call();
      return { status: 0, lines: result.warnings ?? [] };
    } catch (e) {
      return { status: 128, lines: (e as { lines?: string[] }).lines ?? [String(e)] };
    }
  };
  const lines = (text: string) =>
    text.split("\n").filter((l) => l !== "" && !l.startsWith("hint:"));

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "object-storage-git3-")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("a plain files storage opens as any repository; files:// reads as files", async () => {
    // a plain `files` storage is the repository as always: both read the same history
    const dir = repoWith("files");
    expect(git(dir, ["rev-parse", "--show-object-storage-format"]).out).toBe("files\n");
    const head = git(dir, ["rev-parse", "HEAD"]).out.trim();
    const g = await openOurs(dir);
    const ids: string[] = [];
    for await (const c of await g.log().call()) ids.push(c.id);
    expect(ids).toEqual([head]);
    // and `files://` (an empty payload) reads as `files`
    const empty = repoWith("files://");
    expect(git(empty, ["rev-parse", "--show-object-storage-format"]).out).toBe("files\n");
    await expect(openOurs(empty)).resolves.toBeDefined();
  });

  it("files://objs (git init --object-storage-format) is refused unchanged", async () => {
    // `git init --object-storage-format=files://objs`: objects in `.git/objs`, which native
    // git reads; we refuse it before reading or writing anything
    const dir = fresh("objs");
    mkdirSync(dir);
    expect(git(dir, ["init", "-q", "--object-storage-format=files://objs"]).status).toBe(0);
    expect(git(dir, ["commit", "-q", "--allow-empty", "-m", "one"]).status).toBe(0);
    expect(git(dir, ["rev-parse", "--show-object-storage-format"]).out).toBe("files://objs\n");
    const before = readFileSync(join(dir, ".git/config"), "utf8");
    await expect(openOurs(dir)).rejects.toThrow(
      "repository format not supported by webrun-vcs:\n\textensions.objectStorage = files://objs",
    );
    expect(readFileSync(join(dir, ".git/config"), "utf8")).toBe(before);
  });

  it("an unknown format in the config or in $GIT_OBJECT_STORAGE_FORMAT", async () => {
    // an unknown format in the repository's config: git's error line
    const dir = repoWith("garbage");
    const native = git(dir, ["status"]);
    expect(native.status).toBe(128);
    expect(lines(native.err)[0]).toBe(
      "error: invalid value for 'extensions.objectstorage': 'garbage'",
    );
    await expect(openOurs(dir)).rejects.toThrow(
      "invalid value for 'extensions.objectstorage': 'garbage'",
    );
    // `$GIT_OBJECT_STORAGE_FORMAT` overrides the config when opening
    const plain = repoWith(undefined);
    const over = git(plain, ["status"], { GIT_OBJECT_STORAGE_FORMAT: "garbage" });
    expect(over.status).toBe(128);
    expect(lines(over.err)).toEqual(["fatal: unknown object storage format: 'garbage'"]);
    const files = createNodeFilesApi({ rootDir: plain });
    const environment = createNodeGitHostEnvironment({
      env: env({ GIT_OBJECT_STORAGE_FORMAT: "garbage" }),
    });
    await expect(createGitFilesBackend({ files, environment })).rejects.toThrow(
      "unknown object storage format: 'garbage'",
    );
    // a payload there would move the objects: refused, as git would read elsewhere
    expect(
      git(plain, ["rev-parse", "--show-object-storage-format"], {
        GIT_OBJECT_STORAGE_FORMAT: "files://zz",
      }).out,
    ).toBe("files://zz\n");
    const moved = createNodeGitHostEnvironment({
      env: env({ GIT_OBJECT_STORAGE_FORMAT: "files://zz" }),
    });
    await expect(createGitFilesBackend({ files, environment: moved })).rejects.toThrow(
      "GIT_OBJECT_STORAGE_FORMAT = files://zz",
    );
    await expect(
      createGitFilesBackend({
        files,
        environment: createNodeGitHostEnvironment({
          env: env({ GIT_OBJECT_STORAGE_FORMAT: "files" }),
        }),
      }),
    ).resolves.toBeDefined();
  });

  it("init: the variables and init.defaultObjectStorageFormat", async () => {
    // init's defaults: an unknown name in either variable dies with git's line
    for (const variable of ["GIT_OBJECT_STORAGE_FORMAT", "GIT_DEFAULT_OBJECT_STORAGE_FORMAT"]) {
      const nativeDir = fresh("init-native");
      mkdirSync(nativeDir);
      const native = git(nativeDir, ["init", "-q"], { [variable]: "garbage" });
      const ours = await oursInit(fresh("init-ours"), { [variable]: "garbage" });
      expect(ours).toEqual({ status: native.status, lines: lines(native.err) });
    }
    // an unknown name in the config warns and is passed over; `files` writes no extension
    for (const value of ["garbage", "files"]) {
      const cfg = {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "init.defaultObjectStorageFormat",
        GIT_CONFIG_VALUE_0: value,
      };
      const nativeDir = fresh("cfg-native");
      mkdirSync(nativeDir);
      const native = git(nativeDir, ["init", "-q"], cfg);
      const oursDir = fresh("cfg-ours");
      const ours = await oursInit(oursDir, cfg);
      expect(ours).toEqual({ status: native.status, lines: lines(native.err) });
      expect(readFileSync(join(oursDir, ".git/config"), "utf8")).toBe(
        readFileSync(join(nativeDir, ".git/config"), "utf8"),
      );
    }
    // a payload: native git creates `.git/objs`; we refuse before creating anything
    const nativeDir = fresh("payload-native");
    mkdirSync(nativeDir);
    expect(
      git(nativeDir, ["init", "-q"], { GIT_DEFAULT_OBJECT_STORAGE_FORMAT: "files://objs" }).status,
    ).toBe(0);
    const oursDir = fresh("payload-ours");
    expect(await oursInit(oursDir, { GIT_DEFAULT_OBJECT_STORAGE_FORMAT: "files://objs" })).toEqual({
      status: 128,
      lines: ["fatal: object storage format not supported by webrun-vcs: 'files://objs'"],
    });
    expect(spawnSync("ls", ["-A", oursDir], { encoding: "utf8" }).stdout).toBe("");
    // reinitializing with another payload: git's death
    const re = repoWith(undefined);
    const native = git(re, ["init", "-q"], { GIT_OBJECT_STORAGE_FORMAT: "files://zz" });
    const ours = await (async () => {
      try {
        await Git.init()
          .setFilesApi(createNodeFilesApi({ rootDir: re }))
          .setEnvironment(
            createNodeGitHostEnvironment({ env: env({ GIT_OBJECT_STORAGE_FORMAT: "files://zz" }) }),
          )
          .call();
        return { status: 0, lines: [] as string[] };
      } catch (e) {
        return { status: 128, lines: (e as { lines?: string[] }).lines ?? [String(e)] };
      }
    })();
    expect(ours).toEqual({ status: native.status, lines: lines(native.err) });
  });

  it("reinit drops a plain extensions.objectStorage, as initialize_repository_version", async () => {
    const nativeDir = repoWith("files");
    const oursDir = repoWith("files");
    expect(git(nativeDir, ["init", "-q"]).status).toBe(0);
    await Git.init()
      .setFilesApi(createNodeFilesApi({ rootDir: oursDir }))
      .setEnvironment(createNodeGitHostEnvironment({ env: env() }))
      .call();
    expect(readFileSync(join(oursDir, ".git/config"), "utf8")).toBe(
      readFileSync(join(nativeDir, ".git/config"), "utf8"),
    );
  });
  /** A file:// submodule clone needs `protocol.file.allow=always` (t7427's setup). */
  const ALLOW_FILE = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
  };
  /** What our command died with: its first line (git's `fatal:`). */
  const deathOf = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (e) {
      return String((e as Error).message).split("\n")[0];
    }
    throw new Error("succeeded");
  };
  /** An empty superproject `<dir>/upstream` and a repository `<dir>/submodule` with a commit. */
  const upstreamAndSubmodule = () => {
    const dir = fresh("t7427");
    mkdirSync(dir);
    expect(git(dir, ["init", "-q", "submodule"]).status).toBe(0);
    expect(git(join(dir, "submodule"), ["commit", "-q", "--allow-empty", "-m", "s"]).status).toBe(
      0,
    );
    expect(git(dir, ["init", "-q", "upstream"]).status).toBe(0);
    return dir;
  };

  it('t7427-submodule-object-storage-format.sh: "add existing repository with different object storage format"', async () => {
    // a superproject whose submodule keeps its objects in `.git/objs`: native git master
    // reads both; we read the superproject and report the submodule as far as its refs go
    const dir = fresh("parent");
    mkdirSync(dir);
    expect(git(dir, ["init", "-q"]).status).toBe(0);
    expect(git(dir, ["commit", "-q", "--allow-empty", "-m", "parent"]).status).toBe(0);
    expect(
      git(dir, ["init", "-q", "--object-storage-format=files://objs", "submodule"]).status,
    ).toBe(0);
    const sub = join(dir, "submodule");
    expect(git(sub, ["commit", "-q", "--allow-empty", "-m", "submodule"]).status).toBe(0);
    expect(git(dir, ["submodule", "add", "./submodule"]).status).toBe(0);
    expect(git(sub, ["rev-parse", "--show-object-storage-format"]).out).toBe("files://objs\n");
    // a new commit in the submodule: the superproject sees it through the submodule's refs
    expect(git(sub, ["commit", "-q", "--allow-empty", "-m", "two"]).status).toBe(0);
    const ours = await openOurs(dir);
    const status = await ours.status().call();
    expect(status.files.map((f) => `${f.index}${f.worktree} ${f.path}`)).toEqual(
      lines(git(dir, ["status", "--porcelain"]).out),
    );
    // its own changes are unknown to us (its objects are elsewhere): a warning says so
    expect(status.warnings).toEqual([
      "warning: cannot look into submodule 'submodule': repository format not supported by webrun-vcs:\n\textensions.objectStorage = files://objs",
    ]);
    const diff = ours.diff();
    expect(await diff.callText()).toBe(git(dir, ["diff"]).out);
    expect(diff.warnings.length).toBe(1);
    // the superproject's own history reads as always
    const ids: string[] = [];
    for await (const c of await ours.log().call()) ids.push(c.id);
    expect(ids).toEqual([git(dir, ["rev-parse", "HEAD"]).out.trim()]);
  });

  it("a local clone of a files://objs repository is refused with its format", async () => {
    // native git master falls back to a non-local clone; we cannot read the source's
    // objects and say so (never "does not exist"), writing nothing
    const dir = fresh("clone-src");
    mkdirSync(dir);
    expect(git(dir, ["init", "-q", "--object-storage-format=files://objs", "src"]).status).toBe(0);
    expect(git(join(dir, "src"), ["commit", "-q", "--allow-empty", "-m", "one"]).status).toBe(0);
    const native = git(dir, ["clone", "-q", "src", "native"]);
    expect(native.status).toBe(0);
    expect(lines(native.err)).toEqual([
      "warning: falling back to non-local clone because of non-default object storage format",
    ]);
    for (const local of [true, false]) {
      const target = join(dir, `ours-${local}`);
      const death = await ourCloneFails(dir, target, (c) =>
        c.setURI(join(dir, "src")).setLocal(local),
      );
      expect(death.message).toBe(
        "fatal: repository format not supported by webrun-vcs:\n\textensions.objectStorage = files://objs",
      );
      expect(existsSync(join(target, ".git/refs/remotes"))).toBe(false);
    }
  });

  it('t7427-submodule-object-storage-format.sh: "add submodules with garbage object storage format", "add submodules with object storage payload is rejected"', async () => {
    for (const format of ["garbage", "files://objs"]) {
      const dir = upstreamAndSubmodule();
      const up = join(dir, "upstream");
      const native = git(
        up,
        ["submodule", "add", `--object-storage-format=${format}`, `file://${dir}/submodule`],
        ALLOW_FILE,
      );
      expect(native.status).toBe(128);
      expect(lines(native.err)).toEqual([`fatal: unknown object storage format '${format}'`]);
      const ours = await openOurs(up);
      expect(
        await deathOf(() =>
          ours
            .submoduleAdd()
            .setObjectStorageFormat(format)
            .setURI(`file://${dir}/submodule`)
            .call(),
        ),
      ).toBe(lines(native.err)[0]);
      // and the same for submodule update
      expect(
        await deathOf(() =>
          ours.submoduleUpdate().setInit(true).setObjectStorageFormat(format).call(),
        ),
      ).toBe(`fatal: unknown object storage format '${format}'`);
      expect(
        lines(git(up, ["submodule", "update", "--init", `--object-storage-format=${format}`]).err),
      ).toEqual([`fatal: unknown object storage format '${format}'`]);
    }
  });

  it('t7427-submodule-object-storage-format.sh: "clone submodules with explicit object storage format"', async () => {
    const dir = upstreamAndSubmodule();
    const up = join(dir, "upstream");
    expect(git(up, ["submodule", "add", `file://${dir}/submodule`], ALLOW_FILE).status).toBe(0);
    expect(git(up, ["commit", "-q", "-m", "upstream submodule"]).status).toBe(0);
    expect(
      git(dir, ["clone", "-q", "--no-recurse-submodules", `file://${up}`, "native"]).status,
    ).toBe(0);
    expect(
      git(dir, ["clone", "-q", "--no-recurse-submodules", `file://${up}`, "ours"]).status,
    ).toBe(0);
    const native = git(
      join(dir, "native"),
      ["submodule", "update", "--init", "--object-storage-format=files"],
      ALLOW_FILE,
    );
    expect(native.status).toBe(0);
    const ours = await openOurs(
      dir,
      createNodeGitHostEnvironment({ env: env(ALLOW_FILE) }),
      undefined,
      "ours",
    );
    const result = await ours
      .submoduleUpdate()
      .setInit(true)
      .setObjectStorageFormat("files")
      .call();
    expect(result.stderr.split("/ours/").join("/<T>/")).toBe(
      native.err.split("/native/").join("/<T>/"),
    );
    expect(result.exitCode).toBe(0);
    for (const side of ["native", "ours"]) {
      const sub = join(dir, side, "submodule");
      expect(git(sub, ["rev-parse", "--show-object-storage-format"]).out).toBe("files\n");
      expect(existsSync(join(dir, side, ".git/modules/submodule/objects/pack"))).toBe(true);
      expect(git(sub, ["rev-parse", "HEAD"]).out).toBe(
        git(join(dir, "submodule"), ["rev-parse", "HEAD"]).out,
      );
    }
  });

  it('t7427-submodule-object-storage-format.sh: "recursive clone propagates object storage format"', async () => {
    // with `files` (the payload of t7427's clone is refused: see the next case)
    const dir = upstreamAndSubmodule();
    const up = join(dir, "upstream");
    expect(git(up, ["submodule", "add", `file://${dir}/submodule`], ALLOW_FILE).status).toBe(0);
    expect(git(up, ["commit", "-q", "-am", "add submodule"]).status).toBe(0);
    const args = ["clone", "-q", "--object-storage-format=files", "--recurse-submodules"];
    expect(git(dir, [...args, "upstream", "native"], ALLOW_FILE).status).toBe(0);
    const result = await ourClone(
      dir,
      join(dir, "ours"),
      (c) => c.setURI(up).setObjectStorageFormat("files").setRecurseSubmodules(true),
      { extraEnv: ALLOW_FILE },
    );
    expect(result.submodules?.exitCode ?? 0).toBe(0);
    for (const side of ["native", "ours"]) {
      for (const repo of [join(dir, side), join(dir, side, "submodule")]) {
        expect(git(repo, ["rev-parse", "--show-object-storage-format"]).out).toBe("files\n");
      }
      expect(existsSync(join(dir, side, ".git/modules/submodule/objects/pack"))).toBe(true);
      expect(readFileSync(join(dir, side, ".git/config"), "utf8")).not.toContain("objectstorage");
    }
  });

  it("clone --object-storage-format: an unknown format dies, a payload is refused", async () => {
    const dir = upstreamAndSubmodule();
    const sub = join(dir, "submodule");
    const native = git(dir, ["clone", "-q", "--object-storage-format=garbage", sub, "native"]);
    expect(native.status).toBe(128);
    expect(lines(native.err)).toEqual(["fatal: unknown object storage format 'garbage'"]);
    expect(
      (
        await ourCloneFails(dir, join(dir, "ours"), (c) =>
          c.setURI(sub).setObjectStorageFormat("garbage"),
        )
      ).message,
    ).toBe(lines(native.err)[0]);
    // a payload: native git master clones into `.git/objs`; we refuse before fetching
    expect(
      git(dir, ["clone", "-q", "--object-storage-format=files://objs", sub, "n2"]).status,
    ).toBe(0);
    expect(git(join(dir, "n2"), ["rev-parse", "--show-object-storage-format"]).out).toBe(
      "files://objs\n",
    );
    const refused = await ourCloneFails(dir, join(dir, "o2"), (c) =>
      c.setURI(sub).setObjectStorageFormat("files://objs"),
    );
    expect(refused.message).toBe(
      "fatal: object storage format not supported by webrun-vcs: 'files://objs'",
    );
    expect(existsSync(join(dir, "o2/.git/refs/remotes"))).toBe(false);
  });
});
