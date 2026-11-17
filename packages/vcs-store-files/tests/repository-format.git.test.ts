/**
 * The repository format check against repositories native git made: a reftable or sha256
 * repository, or one with an unknown version-1 extension, is refused when opened (git refuses
 * the last one too); preciousObjects, partial clones and repositories with alternates open,
 * but gc and repack delete nothing there. Reftable needs git 2.45 or newer: that test is skipped on older gits.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryFilesApi, GcOrchestrator } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertNoAlternates,
  checkRepositoryFormat,
  createGitFilesBackend,
  FileGcStrategy,
  gc,
  repack,
  UnsupportedRepositoryFormatError,
} from "../src/index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const home = mkdtempSync(join(tmpdir(), "repo-format-home-"));
dirs.push(home);
/** As `nativeGitEnv` in vcs-commands tests: fixed identities and dates, no background gc. */
const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  LANG: "C",
  LC_ALL: "C",
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
  ...(process.env.GIT_EXEC_PATH ? { GIT_EXEC_PATH: process.env.GIT_EXEC_PATH } : {}),
};
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).toString();

/**
 * `git fsck --full`. A git built without its own exec path (GIT_EXEC_PATH pointing at an
 * older git's helpers) fails with "'refs' is not a git command" when fsck runs `git refs
 * verify`: that build issue alone is tolerated, after checking connectivity another way.
 */
function fsck(dir: string) {
  const run = spawnSync("git", ["fsck", "--full", "--no-progress"], { cwd: dir, env: GIT_ENV });
  if (run.status === 0) return;
  const stderr = run.stderr.toString();
  if (stderr.includes("'refs' is not a git command")) {
    git(dir, ["rev-list", "--objects", "--all", "--reflog", "--indexed-objects"]);
    return;
  }
  throw new Error(`git fsck failed in ${dir}:\n${stderr}`);
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A repository native git made with `initArgs`, with one commit when git can make it. */
function nativeRepo(initArgs: string[] = []): string {
  const dir = tempDir("repo-format-");
  git(dir, ["init", "-q", "--initial-branch=main", ...initArgs, "."]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "first"]);
  return dir;
}

const open = (dir: string) =>
  createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });

/** Every object id stored, loose or packed. */
const stored = (dir: string) =>
  new Set(
    git(dir, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
      .split("\n")
      .filter(Boolean),
  );

/** An unreachable loose blob, last modified a month ago (past every prune expiry). */
function oldOrphan(dir: string): string {
  const id = git(dir, ["hash-object", "-w", "--stdin"], "an old unreachable blob\n").trim();
  const month = Date.now() / 1000 - 30 * 24 * 3600;
  utimesSync(join(dir, ".git/objects", id.slice(0, 2), id.slice(2)), month, month);
  return id;
}

const reftableSupported =
  spawnSync("git", ["init", "-q", "--ref-format=reftable", tempDir("repo-format-probe-")], {
    env: GIT_ENV,
  }).status === 0;

describe("repositories we cannot read are refused when opened", () => {
  it("a sha256 repository", async () => {
    const dir = nativeRepo(["--object-format=sha256"]);
    await expect(open(dir)).rejects.toBeInstanceOf(UnsupportedRepositoryFormatError);
    await expect(open(dir)).rejects.toThrow(/extensions\.objectFormat = sha256/);
  });

  it.skipIf(!reftableSupported)("a reftable repository", async () => {
    const dir = nativeRepo(["--ref-format=reftable"]);
    await expect(open(dir)).rejects.toBeInstanceOf(UnsupportedRepositoryFormatError);
    await expect(open(dir)).rejects.toThrow(/extensions\.refStorage = reftable/);
  });

  it("an unknown version-1 extension, which native git refuses too", async () => {
    const dir = nativeRepo();
    git(dir, ["config", "core.repositoryformatversion", "1"]);
    git(dir, ["config", "extensions.frobnicate", "true"]);
    const native = spawnSync("git", ["status"], { cwd: dir, env: GIT_ENV });
    expect(native.status).not.toBe(0);
    expect(native.stderr.toString()).toContain("unknown repository extension found:");
    await expect(open(dir)).rejects.toThrow(/unknown repository extension found:\n\tfrobnicate/);
  });

  it("an unknown extension in version 0 is ignored, as native git ignores it", async () => {
    const dir = nativeRepo();
    git(dir, ["config", "extensions.frobnicate", "true"]);
    git(dir, ["status"]);
    const { history } = await open(dir);
    expect((await history.refs.resolve("HEAD"))?.objectId).toBe(
      git(dir, ["rev-parse", "HEAD"]).trim(),
    );
  });

  it("worktreeConfig opens", async () => {
    const dir = nativeRepo();
    git(dir, ["config", "extensions.worktreeConfig", "true"]);
    const { history } = await open(dir);
    expect(await history.refs.resolve("refs/heads/main")).toBeDefined();
  });
});

describe("preciousObjects", () => {
  it("gc() keeps an old unreachable object, as native git gc does; prune and repack refuse", async () => {
    const dir = nativeRepo();
    git(dir, ["config", "extensions.preciousObjects", "true"]);
    const orphan = oldOrphan(dir);

    const native = tempDir("repo-format-native-");
    cpSync(dir, native, { recursive: true });
    git(native, ["gc", "--quiet", "--prune=now"]);
    expect(stored(native).has(orphan)).toBe(true);
    expect(spawnSync("git", ["prune"], { cwd: native, env: GIT_ENV }).status).not.toBe(0);

    const backend = await open(dir);
    await gc({ history: backend.history, files: backend.files, pruneExpireMs: 0 });
    expect(stored(dir).has(orphan)).toBe(true);
    await expect(repack(backend)).rejects.toThrow(/precious-objects/);
    const orchestrator = new GcOrchestrator(backend.history, new FileGcStrategy(backend));
    await expect(orchestrator.run({ pruneExpireMs: 0 })).rejects.toThrow(
      /cannot prune in a precious-objects repo/,
    );
    expect(stored(dir).has(orphan)).toBe(true);
    fsck(dir);
  });
});

describe("a repository with alternates (git clone --shared)", () => {
  it("opens, but gc(), repack() and GcOrchestrator refuse and delete nothing", async () => {
    const src = nativeRepo();
    const dir = join(tempDir("repo-format-shared-"), "clone");
    git(src, ["clone", "-q", "--shared", src, dir]);
    git(dir, ["commit", "-q", "--allow-empty", "-m", "local"]);
    const orphan = oldOrphan(dir);
    const before = stored(dir);

    const backend = await open(dir);
    await expect(
      gc({ history: backend.history, files: backend.files, pruneExpireMs: 0 }),
    ).rejects.toThrow(/cannot gc in a repository with alternates/);
    await expect(repack(backend)).rejects.toBeInstanceOf(UnsupportedRepositoryFormatError);
    const orchestrator = new GcOrchestrator(backend.history, new FileGcStrategy(backend));
    await expect(orchestrator.run({ pruneExpireMs: 0 })).rejects.toThrow(/alternates/);
    expect(stored(dir)).toEqual(before);
    expect(before.has(orphan)).toBe(true);
  });

  it("reads objects/info/alternates as bytes: a latin-1 path counts, comments do not", async () => {
    const files = createInMemoryFilesApi();
    const alternates = ".git/objects/info/alternates";
    await files.write(alternates, [new TextEncoder().encode("# none here\n\n")]);
    await expect(assertNoAlternates(files)).resolves.toBeUndefined();
    await files.write(alternates, [new Uint8Array([0x2f, 0x63, 0x61, 0x66, 0xe9, 0x0a])]);
    await expect(assertNoAlternates(files)).rejects.toThrow(/alternates/);
  });
});

describe("format extensions read as git_config_bool", () => {
  const configOf = (entries: Record<string, unknown>) => ({
    get: (key: string) => entries[key],
    listKeys: (prefix = "") => Object.keys(entries).filter((k) => k.startsWith(prefix)),
  });

  it("an empty value is false, a key with no `=` true, integers count", () => {
    const format = (value: unknown) =>
      checkRepositoryFormat(configOf({ "extensions.worktreeconfig": value })).worktreeConfig;
    expect(format("")).toBe(false);
    expect(format(true)).toBe(true);
    expect(format("0x1")).toBe(true);
    expect(format(0)).toBe(false);
    expect(() => format("maybe")).toThrow(/bad boolean config value/);
  });
});

describe("a partial clone", () => {
  it("opens, but gc(), repack() and GcOrchestrator refuse and delete nothing", async () => {
    const src = nativeRepo();
    git(src, ["config", "uploadpack.allowFilter", "true"]);
    const dir = join(tempDir("repo-format-partial-"), "clone");
    git(src, ["clone", "-q", "--filter=blob:none", `file://${src}`, dir]);
    // git >= 2.29 marks the promisor remote, not extensions.partialClone
    expect(git(dir, ["config", "--bool", "remote.origin.promisor"]).trim()).toBe("true");
    const orphan = oldOrphan(dir);
    const before = stored(dir);

    const backend = await open(dir);
    expect((await backend.history.refs.resolve("HEAD"))?.objectId).toBe(
      git(dir, ["rev-parse", "HEAD"]).trim(),
    );
    await expect(
      gc({ history: backend.history, files: backend.files, pruneExpireMs: 0 }),
    ).rejects.toThrow(/cannot gc in a partial clone/);
    await expect(repack(backend)).rejects.toBeInstanceOf(UnsupportedRepositoryFormatError);
    const orchestrator = new GcOrchestrator(backend.history, new FileGcStrategy(backend));
    await expect(orchestrator.run({ pruneExpireMs: 0 })).rejects.toThrow(
      /cannot prune in a partial clone/,
    );
    expect(stored(dir)).toEqual(before);
    expect(before.has(orphan)).toBe(true);
  });
});
