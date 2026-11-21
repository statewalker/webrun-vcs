/**
 * The repository format check (git's check_repository_format / verify_repository_format):
 * which `core.repositoryformatversion` and `extensions.*` combinations open, and which are
 * refused, by createGitFilesBackend, gc(), repack() and FileGcStrategy.
 */
import { createInMemoryFilesApi, GcOrchestrator } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";

import {
  createGitFilesBackend,
  FileGcStrategy,
  gc,
  readRepositoryFormat,
  repack,
  UnsupportedRepositoryFormatError,
} from "../src/index.js";

/** A repository made by us, whose config is then replaced by `config`. */
async function repoWithConfig(config: string) {
  const files = createInMemoryFilesApi();
  const { history } = await createGitFilesBackend({ files, create: true });
  await history.initialize();
  await files.write(".git/config", [new TextEncoder().encode(config)]);
  return files;
}

const v = (version: number, extensions = "") =>
  `[core]\n\trepositoryformatversion = ${version}\n\tbare = false\n${extensions ? `[extensions]\n${extensions}` : ""}`;

describe("repository format check", () => {
  it.each([
    ["version 0, no extensions", v(0)],
    ["no version at all", "[core]\n\tbare = false\n"],
    ["version 1, no extensions", v(1)],
    ["version 0 ignores an unknown extension, as git", v(0, "\tfrobnicate = yes\n")],
    ["noop", v(0, "\tnoop = true\n")],
    ["noop-v1 in version 1", v(1, "\tnoop-v1 = true\n")],
    ["worktreeConfig", v(1, "\tworktreeConfig = true\n")],
    ["preciousObjects (opens; gc refuses)", v(0, "\tpreciousObjects = true\n")],
    ["partialClone (opens; gc refuses)", v(1, "\tpartialClone = origin\n")],
    ["objectFormat = sha1", v(1, "\tobjectFormat = sha1\n")],
    ["refStorage = files", v(1, "\trefStorage = files\n")],
    ["relativeWorktrees", v(1, "\trelativeWorktrees = true\n")],
  ])("opens: %s", async (_name, config) => {
    const files = await repoWithConfig(config);
    const { history } = await createGitFilesBackend({ files });
    await history.initialize();
    expect(await history.refs.resolve("HEAD")).toBeUndefined();
  });

  it.each([
    ["a version above 1", v(2), /Expected git repo version <= 1, found 2/],
    [
      "an unknown extension in version 1",
      v(1, "\tfrobnicate = yes\n"),
      /unknown repository extension found:\n\tfrobnicate/,
    ],
    [
      "two unknown extensions in version 1",
      v(1, "\tfoo = 1\n\tbar = 1\n"),
      /unknown repository extensions found:\n\tfoo\n\tbar/,
    ],
    [
      "a v1-only extension in version 0",
      v(0, "\trefStorage = files\n"),
      /repo version is 0, but v1-only extension found:\n\trefstorage/,
    ],
    ["reftable refs", v(1, "\trefStorage = reftable\n"), /extensions\.refStorage = reftable/],
    ["sha256 objects", v(1, "\tobjectFormat = sha256\n"), /extensions\.objectFormat = sha256/],
    [
      "a compatibility object format",
      v(1, "\tobjectFormat = sha1\n\tcompatObjectFormat = sha256\n"),
      /extensions\.compatObjectFormat = sha256/,
    ],
    [
      "an invalid object format",
      v(1, "\tobjectFormat = md5\n"),
      /invalid value for 'extensions.objectformat': 'md5'/,
    ],
    [
      "a non-numeric version",
      "[core]\n\trepositoryformatversion = one\n",
      /bad numeric config value/,
    ],
  ])("refuses %s", async (_name, config, message) => {
    const files = await repoWithConfig(config);
    const opened = createGitFilesBackend({ files });
    await expect(opened).rejects.toBeInstanceOf(UnsupportedRepositoryFormatError);
    await expect(createGitFilesBackend({ files })).rejects.toThrow(message);
  });

  it("refuses before writing anything, even with create", async () => {
    const config = v(1, "\trefStorage = reftable\n");
    const files = await repoWithConfig(config);
    await expect(createGitFilesBackend({ files, create: true })).rejects.toBeInstanceOf(
      UnsupportedRepositoryFormatError,
    );
    expect(new TextDecoder().decode(await readAll(files, ".git/config"))).toBe(config);
  });

  it("reads what the format allows", async () => {
    const files = await repoWithConfig(
      v(1, "\tpreciousObjects\n\tpartialClone = origin\n\tworktreeConfig = false\n"),
    );
    expect(await readRepositoryFormat(files, ".git")).toEqual({
      version: 1,
      preciousObjects: true,
      partialClone: "origin",
      worktreeConfig: false,
      relativeWorktrees: false,
    });
  });

  it("a remote marked promisor makes a partial clone, as git clone --filter writes it", async () => {
    const files = await repoWithConfig(
      `${v(1)}[remote "Upstream"]\n\turl = https://example.com/r.git\n\tpromisor = true\n`,
    );
    expect((await readRepositoryFormat(files, ".git")).partialClone).toBe("Upstream");
  });
});

async function readAll(files: ReturnType<typeof createInMemoryFilesApi>, path: string) {
  const parts: Uint8Array[] = [];
  for await (const c of files.read(path)) parts.push(c);
  return Buffer.concat(parts);
}

/** A repository with one unreachable loose blob, and the given extensions. */
async function backendWith(extensions: string) {
  const files = createInMemoryFilesApi();
  const backend = await createGitFilesBackend({ files, create: true });
  await backend.history.initialize();
  const orphan = await backend.history.blobs.store([new TextEncoder().encode("orphan\n")]);
  await files.write(".git/config", [new TextEncoder().encode(v(1, extensions))]);
  return { files, backend, orphan };
}

describe("gc in a precious-objects repository", () => {
  it("gc() prunes nothing, as git gc skips repack and prune", async () => {
    const { files, backend, orphan } = await backendWith("\tpreciousObjects = true\n");
    const result = await gc({ history: backend.history, files, pruneExpireMs: 0 });
    expect(result.removedObjects).toBe(0);
    expect(result.repack).toBeNull();
    expect(await backend.history.blobs.has(orphan)).toBe(true);
  });

  it("repack() and GcOrchestrator refuse, as git repack -d and git prune", async () => {
    const { backend, orphan } = await backendWith("\tpreciousObjects = true\n");
    await expect(repack(backend)).rejects.toThrow(/cannot repack in a precious-objects repo/);
    const orchestrator = new GcOrchestrator(backend.history, new FileGcStrategy(backend));
    await expect(orchestrator.run({ pruneExpireMs: 0 })).rejects.toThrow(
      /cannot prune in a precious-objects repo/,
    );
    expect(await backend.history.blobs.has(orphan)).toBe(true);
  });
});

describe("gc in a partial clone", () => {
  it("GcOrchestrator refuses, deleting nothing; gc() and repack() run as git's", async () => {
    const { files, backend, orphan } = await backendWith("\tpartialClone = origin\n");
    const orchestrator = new GcOrchestrator(backend.history, new FileGcStrategy(backend));
    await expect(orchestrator.run({ pruneExpireMs: 0 })).rejects.toThrow(
      /cannot prune in a partial clone/,
    );
    expect(await backend.history.blobs.has(orphan)).toBe(true);
    // the promisor objects stay out of the walk; what nothing reaches is pruned
    await repack(backend);
    const result = await gc({ history: backend.history, files, pruneExpireMs: 0 });
    expect(result.skipped).toBe(false);
    expect(await backend.history.blobs.has(orphan)).toBe(false);
  });
});

describe("repository format values as git parses them (review fixes)", () => {
  it.each([
    ["submodulePathConfig (git 2.56, v1)", v(1, "\tsubmodulePathConfig = true\n")],
    ["a version written as 01 (strtoimax base 0)", "[core]\n\trepositoryformatversion = 01\n"],
    ["preciousObjects = 0x1", v(0, "\tpreciousObjects = 0x1\n")],
  ])("opens: %s", async (_name, config) => {
    const files = await repoWithConfig(config);
    const { history } = await createGitFilesBackend({ files });
    await history.initialize();
    expect(await history.refs.resolve("HEAD")).toBeUndefined();
  });

  it("reads 0x1 as a true preciousObjects", async () => {
    const files = await repoWithConfig(v(0, "\tpreciousObjects = 0x1\n"));
    expect((await readRepositoryFormat(files, ".git")).preciousObjects).toBe(true);
  });

  it.each([
    [
      "objectFormat = SHA1 (git compares case-sensitively)",
      v(1, "\tobjectFormat = SHA1\n"),
      /invalid value for 'extensions.objectformat'/,
    ],
    [
      "refStorage = Files",
      v(1, "\trefStorage = Files\n"),
      /invalid value for 'extensions.refstorage'/,
    ],
    [
      "a bare partialClone key (git requires a value)",
      v(1, "\tpartialClone\n"),
      /missing value for/,
    ],
  ])("refuses: %s", async (_name, config, message) => {
    const files = await repoWithConfig(config);
    await expect(createGitFilesBackend({ files })).rejects.toThrow(message);
  });
});
