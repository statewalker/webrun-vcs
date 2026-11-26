/**
 * git master's `extensions.objectStorage` and its variables (`$GIT_OBJECT_STORAGE_FORMAT`,
 * `$GIT_DEFAULT_OBJECT_STORAGE_FORMAT`, `init.defaultObjectStorageFormat`) against the git
 * master oracle (`$GIT3`, skipped without it: no release has the extension yet, 2.43 and
 * 2.56 refuse it as an unknown extension). The one format is `files`; a plain `files`
 * repository opens as any other, while `files://<directory>` (objects outside `objects/`) is
 * refused before anything is read or written. Scenarios from t7427 (git master).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Git } from "../src/index.js";
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

  it('t7427-submodule-object-storage-format.sh: "add submodules with explicit files storage format"', async () => {
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

  it('t7427-submodule-object-storage-format.sh: "add existing repository with different object storage format"', async () => {
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

  it('t7427-submodule-object-storage-format.sh: "add submodules with garbage object storage format"', async () => {
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

  it('t7427-submodule-object-storage-format.sh: "add submodules with object storage payload is rejected"', async () => {
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
});
