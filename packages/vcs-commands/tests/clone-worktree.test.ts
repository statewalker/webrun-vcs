/**
 * The checkout of a clone: CloneCommand writes the files of the cloned commit into the
 * worktree, as `git clone` does, and records them in the index.
 *
 * The worktree is a real FileWorktree over an in-memory FilesApi, with and without the
 * optional `chmod`/`symlink` operations, plus an in-memory worktree that keeps modes.
 * Assertions read the FilesApi back, below the Worktree layer the command writes through.
 */

import {
  createInMemoryFilesApi,
  createSymlinkFilesApi,
  FileMode,
  type FilesApi,
  type ObjectId,
} from "@statewalker/vcs-core";
import { createFileWorktree, type WorktreeFilesApi } from "@statewalker/vcs-store-files";
import {
  createMemoryObjectStores,
  MemoryRefs,
  MemoryStagingStore,
} from "@statewalker/vcs-store-mem";
import {
  MemoryCheckout,
  MemoryWorkingCopy,
  MemoryWorktree,
  type WorkingCopy,
  type Worktree,
} from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CloneCheckoutError, Git } from "../src/index.js";
import { createSimpleHistory } from "./simple-history-store.js";
import { testAuthor } from "./test-helper.js";
import {
  createInitializedTestServer,
  createTestServer,
  createTestUrl,
  type TestServer,
} from "./transport-test-helper.js";

const ROOT = "/repo";
const encoder = new TextEncoder();

/** A working copy over fresh memory stores, with the worktree `makeWorktree` builds. */
function createWorkingCopy(
  makeWorktree: (stores: ReturnType<typeof createMemoryObjectStores>) => Worktree,
  config: Record<string, unknown> = {},
): WorkingCopy {
  const stores = createMemoryObjectStores();
  const history = createSimpleHistory({
    blobs: stores.blobs,
    trees: stores.trees,
    commits: stores.commits,
    tags: stores.tags,
    refs: new MemoryRefs(),
  });
  return new MemoryWorkingCopy({
    history,
    checkout: new MemoryCheckout({ staging: new MemoryStagingStore() }),
    worktree: makeWorktree(stores),
    config,
  });
}

/** A FileWorktree under {@link ROOT} of `files`. */
function fileWorktree(files: WorktreeFilesApi) {
  return (stores: ReturnType<typeof createMemoryObjectStores>) =>
    createFileWorktree({
      files,
      rootPath: ROOT,
      gitDir: ".git",
      blobs: stores.blobs,
      trees: stores.trees,
    });
}

/**
 * An in-memory FilesApi with the POSIX operations (`chmod`, `symlink`, `lstat`,
 * `readlink`), recording the modes and links asked for.
 */
function filesWithModes(): {
  files: WorktreeFilesApi;
  modes: Map<string, number>;
  links: Map<string, string>;
} {
  const modes = new Map<string, number>();
  const links = new Map<string, string>();
  const base = createInMemoryFilesApi();
  const remove = base.remove.bind(base);
  const files: WorktreeFilesApi = Object.assign(base, {
    chmod: async (path: string, mode: number) => {
      modes.set(path, mode);
    },
    symlink: async (target: Uint8Array, path: string) => {
      links.set(path, new TextDecoder().decode(target));
    },
    lstat: async (path: string) => {
      const link = links.get(path);
      if (link !== undefined) {
        return { kind: "symlink" as const, size: link.length, lastModified: 1 };
      }
      const stats = await base.stats(path);
      if (!stats) return undefined;
      return stats.kind === "directory"
        ? { kind: "directory" as const, size: 0, lastModified: 0 }
        : {
            kind: "file" as const,
            size: stats.size ?? 0,
            lastModified: stats.lastModified ?? 0,
            mode: modes.get(path) ?? 0o644,
          };
    },
    readlink: async (path: string) => {
      const link = links.get(path);
      return link === undefined ? undefined : new TextEncoder().encode(link);
    },
    remove: async (path: string) => (links.delete(path) ? true : remove(path)),
  });
  return { files, modes, links };
}

async function readText(files: FilesApi, path: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of files.read(`${ROOT}/${path}`)) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Every path below {@link ROOT}, directories with a trailing slash. */
async function listAll(files: FilesApi): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of files.list(ROOT, { recursive: true })) {
    const path = entry.path.slice(ROOT.length + 1);
    out.push(entry.kind === "directory" ? `${path}/` : path);
  }
  return out.sort();
}

/**
 * Commits on the server's main branch a tree with a file, an executable, a symlink,
 * nested directories and a submodule (a gitlink to `gitlinkTo`).
 */
async function commitSampleTree(server: TestServer, parent: ObjectId): Promise<ObjectId> {
  const { blobs, trees, commits, refs } = server.serverStores;
  const blob = (text: string) => blobs.store([encoder.encode(text)]);
  const deep = await trees.store([
    { name: "deep.txt", mode: FileMode.REGULAR_FILE, id: await blob("deep\n") },
  ]);
  const dir = await trees.store([
    { name: "nested", mode: FileMode.TREE, id: deep },
    { name: "top.txt", mode: FileMode.REGULAR_FILE, id: await blob("top\n") },
  ]);
  const root = await trees.store([
    { name: "a.txt", mode: FileMode.REGULAR_FILE, id: await blob("hello\n") },
    { name: "dir", mode: FileMode.TREE, id: dir },
    { name: "link", mode: FileMode.SYMLINK, id: await blob("dir/nested/deep.txt") },
    { name: "run.sh", mode: FileMode.EXECUTABLE_FILE, id: await blob("#!/bin/sh\necho hi\n") },
    { name: "sub", mode: FileMode.GITLINK, id: parent },
  ]);
  const commit = await commits.store({
    tree: root,
    parents: [parent],
    author: testAuthor(),
    committer: testAuthor(),
    message: "sample tree",
  });
  await refs.set("refs/heads/main", commit);
  return commit;
}

describe("CloneCommand checkout into the worktree", () => {
  let server: TestServer;
  let url: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    const initialized = await createInitializedTestServer();
    server = initialized;
    url = createTestUrl(server.baseUrl);
    await commitSampleTree(server, initialized.initialCommitId);
    globalThis.fetch = server.mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("writes every file of the commit, nested directories and empty submodule dirs", async () => {
    const files = createInMemoryFilesApi();
    const workingCopy = createWorkingCopy(fileWorktree(files));
    await Git.fromWorkingCopy(workingCopy).clone().setURI(url).call();

    expect(await listAll(files)).toEqual([
      "a.txt",
      "dir/",
      "dir/nested/",
      "dir/nested/deep.txt",
      "dir/top.txt",
      "link",
      "run.sh",
      "sub/",
    ]);
    expect(await readText(files, "a.txt")).toBe("hello\n");
    expect(await readText(files, "dir/nested/deep.txt")).toBe("deep\n");
    expect(await readText(files, "run.sh")).toBe("#!/bin/sh\necho hi\n");
  });

  it("without chmod and symlink: the link is a file holding its target, core.* say so", async () => {
    const files = createInMemoryFilesApi();
    const workingCopy = createWorkingCopy(fileWorktree(files));
    await Git.fromWorkingCopy(workingCopy).clone().setURI(url).call();

    expect(await readText(files, "link")).toBe("dir/nested/deep.txt");
    // git init's probe of a filesystem without modes or links
    const config = workingCopy.config as Record<string, unknown>;
    expect(config["core.filemode"]).toBe("false");
    expect(config["core.symlinks"]).toBe("false");
    // the index keeps the tree's modes
    const staging = workingCopy.checkout.staging;
    expect((await staging.getEntry("link"))?.mode).toBe(FileMode.SYMLINK);
    expect((await staging.getEntry("run.sh"))?.mode).toBe(FileMode.EXECUTABLE_FILE);
  });

  it("with chmod and symlink: executable bits and links as git writes them", async () => {
    const { files, modes, links } = filesWithModes();
    const workingCopy = createWorkingCopy(fileWorktree(files));
    await Git.fromWorkingCopy(workingCopy).clone().setURI(url).call();

    expect(modes.get(`${ROOT}/run.sh`)).toBe(0o755);
    expect(modes.has(`${ROOT}/a.txt`)).toBe(false);
    expect(links.get(`${ROOT}/link`)).toBe("dir/nested/deep.txt");
    expect(modes.has(`${ROOT}/link`)).toBe(false);
    const config = workingCopy.config as Record<string, unknown>;
    expect(config["core.filemode"]).toBeUndefined();
    expect(config["core.symlinks"]).toBeUndefined();
  });

  it("core.symlinks=false writes the link as a file even where links can be made", async () => {
    const { files, links } = filesWithModes();
    const workingCopy = createWorkingCopy(fileWorktree(files), { "core.symlinks": "false" });
    await Git.fromWorkingCopy(workingCopy).clone().setURI(url).call();

    expect(links.size).toBe(0);
    expect(await readText(files, "link")).toBe("dir/nested/deep.txt");
  });

  it("fills the index with the stat data of the files written", async () => {
    const files = createInMemoryFilesApi();
    const workingCopy = createWorkingCopy(fileWorktree(files));
    await Git.fromWorkingCopy(workingCopy).clone().setURI(url).call();

    const staging = workingCopy.checkout.staging;
    const paths: string[] = [];
    for await (const entry of staging.entries()) paths.push(entry.path);
    expect(paths).toEqual(["a.txt", "dir/nested/deep.txt", "dir/top.txt", "link", "run.sh", "sub"]);
    for (const path of ["a.txt", "dir/nested/deep.txt", "run.sh"]) {
      const entry = await staging.getEntry(path);
      const stats = await files.stats(`${ROOT}/${path}`);
      expect(stats?.kind).toBe("file");
      if (stats?.kind !== "file") continue;
      expect(entry?.size, path).toBe(stats.size);
      expect(entry?.mtime, path).toBe(stats.lastModified);
      expect(entry?.mtime, path).toBeGreaterThan(0);
    }
    expect((await staging.getEntry("sub"))?.mode).toBe(FileMode.GITLINK);
  });

  it("an in-memory worktree keeps the modes of the tree", async () => {
    const workingCopy = createWorkingCopy(
      (stores) => new MemoryWorktree({ blobs: stores.blobs, trees: stores.trees }),
    );
    await Git.fromWorkingCopy(workingCopy).clone().setURI(url).call();

    const worktree = workingCopy.worktree;
    expect((await worktree.getEntry("run.sh"))?.mode).toBe(FileMode.EXECUTABLE_FILE);
    expect((await worktree.getEntry("link"))?.mode).toBe(FileMode.SYMLINK);
    expect((await worktree.getEntry("a.txt"))?.mode).toBe(FileMode.REGULAR_FILE);
    expect((await worktree.getEntry("sub"))?.isDirectory).toBe(true);
  });

  it("--no-checkout writes no file and leaves the index empty", async () => {
    const files = createInMemoryFilesApi();
    const workingCopy = createWorkingCopy(fileWorktree(files));
    const result = await Git.fromWorkingCopy(workingCopy)
      .clone()
      .setURI(url)
      .setNoCheckout(true)
      .call();

    expect(result.headCommit).toBeDefined();
    expect(await listAll(files)).toEqual([]);
    expect(await workingCopy.checkout.staging.getEntryCount()).toBe(0);
  });

  it("a bare clone writes no file and no index", async () => {
    const files = createInMemoryFilesApi();
    const workingCopy = createWorkingCopy(fileWorktree(files));
    await Git.fromWorkingCopy(workingCopy).clone().setURI(url).setBare(true).call();

    expect(await listAll(files)).toEqual([]);
    expect(await workingCopy.checkout.staging.getEntryCount()).toBe(0);
  });

  it("an empty remote: nothing to write, HEAD names the unborn branch", async () => {
    const empty = createTestServer();
    globalThis.fetch = empty.mockFetch;
    const files = createInMemoryFilesApi();
    const workingCopy = createWorkingCopy(fileWorktree(files));
    const result = await Git.fromWorkingCopy(workingCopy)
      .clone()
      .setURI(createTestUrl(empty.baseUrl))
      .call();

    expect(result.fetchResult.isEmpty).toBe(true);
    expect(await listAll(files)).toEqual([]);
    expect(await workingCopy.checkout.staging.getEntryCount()).toBe(0);
  });
});

/** Commits on the server's main branch the tree `build` makes (raw: names may collide). */
async function commitRawTree(
  server: TestServer,
  build: (blob: (text: string) => Promise<ObjectId>) => Promise<ObjectId>,
): Promise<ObjectId> {
  const { blobs, commits, refs } = server.serverStores;
  const tree = await build((text) => blobs.store([encoder.encode(text)]));
  const parent = (await refs.resolve("refs/heads/main"))?.objectId;
  const commit = await commits.store({
    tree,
    parents: parent ? [parent] : [],
    author: testAuthor(),
    committer: testAuthor(),
    message: "crafted tree",
  });
  await refs.set("refs/heads/main", commit);
  return commit;
}

describe("CloneCommand checkout of a crafted tree", () => {
  let server: TestServer;
  let url: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    server = await createInitializedTestServer();
    url = createTestUrl(server.baseUrl);
    globalThis.fetch = server.mockFetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** A tree with a symlink `h` -> `.git/hooks` and a tree `dir` holding `post-commit`. */
  const linkAndTree = async (blob: (text: string) => Promise<ObjectId>, dir = "h") => {
    const { trees } = server.serverStores;
    const hooks = await trees.store([
      { name: "post-commit", mode: FileMode.EXECUTABLE_FILE, id: await blob("#!/bin/sh\n") },
    ]);
    return trees.store([
      { name: "a.txt", mode: FileMode.REGULAR_FILE, id: await blob("a\n") },
      { name: "h", mode: FileMode.SYMLINK, id: await blob(".git/hooks") },
      { name: dir, mode: FileMode.TREE, id: hooks },
    ]);
  };

  it("refuses a path beneath a symlink of the same tree, before writing anything", async () => {
    await commitRawTree(server, (blob) => linkAndTree(blob));
    const { files, links } = filesWithModes();
    const workingCopy = createWorkingCopy(fileWorktree(files));

    const error = await Git.fromWorkingCopy(workingCopy)
      .clone()
      .setURI(url)
      .call()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloneCheckoutError);
    expect(String((error as Error).message)).toMatch(/^Clone succeeded, but checkout failed: /);
    expect(String((error as Error).message)).toMatch(/collides|not a directory/);
    expect(links.size).toBe(0);
    expect(await listAll(files)).toEqual([]);
  });

  it("with core.ignorecase, `H` beneath a symlink `h` collides too", async () => {
    await commitRawTree(server, (blob) => linkAndTree(blob, "H"));
    const sensitive = filesWithModes();
    await Git.fromWorkingCopy(createWorkingCopy(fileWorktree(sensitive.files)))
      .clone()
      .setURI(url)
      .call();
    // a case-sensitive worktree has room for both
    expect(await listAll(sensitive.files)).toEqual(["H/", "H/post-commit", "a.txt"]);
    expect(sensitive.links.get(`${ROOT}/h`)).toBe(".git/hooks");

    const insensitive = filesWithModes();
    const error = await Git.fromWorkingCopy(
      createWorkingCopy(fileWorktree(insensitive.files), { "core.ignorecase": "true" }),
    )
      .clone()
      .setURI(url)
      .call()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloneCheckoutError);
    expect(await listAll(insensitive.files)).toEqual([]);
    expect(insensitive.links.size).toBe(0);
  });

  it("refuses a .git path and a symlinked .gitmodules before the first write", async () => {
    const { trees } = server.serverStores;
    await commitRawTree(server, async (blob) => {
      const inner = await trees.store([
        { name: "config", mode: FileMode.REGULAR_FILE, id: await blob("x") },
      ]);
      const zz = await trees.store([{ name: ".GIT", mode: FileMode.TREE, id: inner }]);
      return trees.store([
        { name: "a.txt", mode: FileMode.REGULAR_FILE, id: await blob("a\n") },
        { name: "zz", mode: FileMode.TREE, id: zz },
      ]);
    });
    const files = createInMemoryFilesApi();
    const error = await Git.fromWorkingCopy(createWorkingCopy(fileWorktree(files)))
      .clone()
      .setURI(url)
      .call()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloneCheckoutError);
    expect(String((error as Error).message)).toMatch(/invalid path/);
    expect(await listAll(files)).toEqual([]);

    await commitRawTree(server, async (blob) =>
      trees.store([{ name: ".gitmodules", mode: FileMode.SYMLINK, id: await blob("../x") }]),
    );
    const other = createInMemoryFilesApi();
    await expect(
      Git.fromWorkingCopy(createWorkingCopy(fileWorktree(other)))
        .clone()
        .setURI(url)
        .call(),
    ).rejects.toBeInstanceOf(CloneCheckoutError);
    expect(await listAll(other)).toEqual([]);
  });

  it("after a failed checkout the repository is usable: refs, config, fetch", async () => {
    await commitRawTree(server, (blob) => linkAndTree(blob));
    const files = createInMemoryFilesApi();
    const workingCopy = createWorkingCopy(fileWorktree(files));
    const ours = Git.fromWorkingCopy(workingCopy);
    const error = await ours
      .clone()
      .setURI(url)
      .call()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloneCheckoutError);
    const result = (error as CloneCheckoutError).result;
    const tip = await server.serverStores.refs.resolve("refs/heads/main");
    expect(result.headCommit).toBe(tip?.objectId);

    const refs = workingCopy.history.refs;
    const head = await refs.get("HEAD");
    expect(head && "target" in head ? head.target : undefined).toBe("refs/heads/main");
    expect((await refs.resolve("HEAD"))?.objectId).toBe(tip?.objectId);
    const remoteHead = await refs.get("refs/remotes/origin/HEAD");
    expect(remoteHead && "target" in remoteHead ? remoteHead.target : undefined).toBe(
      "refs/remotes/origin/main",
    );
    const config = workingCopy.config as Record<string, unknown>;
    expect(config["remote.origin.url"]).toBe(url);
    expect(config["branch.main.merge"]).toBe("refs/heads/main");

    // a later fetch works from the configuration the clone wrote
    const next = await commitRawTree(server, async (blob) =>
      server.serverStores.trees.store([
        { name: "fixed.txt", mode: FileMode.REGULAR_FILE, id: await blob("fixed\n") },
      ]),
    );
    await ours.fetch().call();
    expect((await refs.resolve("refs/remotes/origin/main"))?.objectId).toBe(next);
  });
});

describe("tree paths with a backslash, and the porcelain checkout", () => {
  let server: TestServer;
  let url: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    const initialized = await createInitializedTestServer();
    server = initialized;
    url = createTestUrl(server.baseUrl);
    await commitSampleTree(server, initialized.initialCommitId);
    globalThis.fetch = server.mockFetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("on Windows refuses `d\\post-checkout` beside a link `d` (CVE-2019-1354), before writing", async () => {
    await commitRawTree(server, async (blob) =>
      server.serverStores.trees.store([
        { name: "d", mode: FileMode.SYMLINK, id: await blob(".git/hooks") },
        { name: "d\\post-checkout", mode: FileMode.EXECUTABLE_FILE, id: await blob("#!/bin/sh\n") },
      ]),
    );
    // a FilesApi on Windows says `\` is a separator there
    const { files, links } = filesWithModes();
    Object.assign(files, { pathSeparators: "/\\" });
    const error = await Git.fromWorkingCopy(createWorkingCopy(fileWorktree(files)))
      .clone()
      .setURI(url)
      .call()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloneCheckoutError);
    expect(String((error as Error).message)).toMatch(/invalid path/);
    expect(links.size).toBe(0);
    expect(await listAll(files)).toEqual([]);

    // elsewhere `d\post-checkout` is a file name beside the link, as git checks it out
    const posix = filesWithModes();
    await Git.fromWorkingCopy(createWorkingCopy(fileWorktree(posix.files)))
      .clone()
      .setURI(url)
      .call();
    expect(posix.links.get(`${ROOT}/d`)).toBe(".git/hooks");
    expect(await readText(posix.files, "d\\post-checkout")).toBe("#!/bin/sh\n");
  });

  it("checkout writes links, executables and submodule dirs, and removes dropped files", async () => {
    const { files, links, modes } = filesWithModes();
    const workingCopy = createWorkingCopy(fileWorktree(files));
    const ours = Git.fromWorkingCopy(workingCopy);
    await ours.clone().setURI(url).setNoCheckout(true).call();
    expect(await listAll(files)).toEqual([]);

    // after --no-checkout HEAD already names main: like `git checkout -f main`, a forced
    // checkout writes the tree (a plain one keeps the empty index and worktree, as git)
    await ours.checkout().setName("main").setForced(true).call();
    expect(links.get(`${ROOT}/link`)).toBe("dir/nested/deep.txt");
    expect(modes.get(`${ROOT}/run.sh`)).toBe(0o755);
    expect(await listAll(files)).toContain("sub/");
    expect(await readText(files, "a.txt")).toBe("hello\n");

    // the next commit drops a.txt: checking it out removes the file
    await commitRawTree(server, async (blob) =>
      server.serverStores.trees.store([
        { name: "only.txt", mode: FileMode.REGULAR_FILE, id: await blob("only\n") },
      ]),
    );
    await ours.fetch().call();
    await ours.checkout().setName("refs/remotes/origin/main").call();
    expect(await files.exists(`${ROOT}/a.txt`)).toBe(false);
    expect(links.has(`${ROOT}/link`)).toBe(false);
    expect(await readText(files, "only.txt")).toBe("only\n");
  });
});

describe("CloneCommand records the worktree's case folding", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("writes core.ignorecase / core.precomposeunicode when the probe finds folding", async () => {
    const server = await createInitializedTestServer();
    globalThis.fetch = server.mockFetch;
    const folding = createWorkingCopy((stores) =>
      Object.assign(new MemoryWorktree({ blobs: stores.blobs, trees: stores.trees }), {
        probeCaseFolding: async () => ({ ignoreCase: true, precomposeUnicode: true }),
      }),
    );
    await Git.fromWorkingCopy(folding).clone().setURI(createTestUrl(server.baseUrl)).call();
    const config = folding.config as Record<string, unknown>;
    expect(config["core.ignorecase"]).toBe("true");
    expect(config["core.precomposeunicode"]).toBe("true");

    const plain = createWorkingCopy(fileWorktree(createInMemoryFilesApi()));
    await Git.fromWorkingCopy(plain).clone().setURI(createTestUrl(server.baseUrl)).call();
    expect((plain.config as Record<string, unknown>)["core.ignorecase"]).toBeUndefined();
  });
});

describe("CloneCommand on a case-folding worktree", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("checks out files differing only in case, reporting them as collided (as git)", async () => {
    const server = await createInitializedTestServer();
    globalThis.fetch = server.mockFetch;
    await commitRawTree(server, async (blob) =>
      server.serverStores.trees.store([
        { name: "README", mode: FileMode.REGULAR_FILE, id: await blob("upper\n") },
        { name: "readme", mode: FileMode.REGULAR_FILE, id: await blob("lower\n") },
      ]),
    );
    const files = createSymlinkFilesApi(createInMemoryFilesApi(), { ignoreCase: true });
    const workingCopy = createWorkingCopy(fileWorktree(files), { "core.ignorecase": "true" });
    const result = await Git.fromWorkingCopy(workingCopy)
      .clone()
      .setURI(createTestUrl(server.baseUrl))
      .call();
    expect(result.collidedPaths).toEqual(["README", "readme"]);
    // one file of the group is in the worktree: the last written wins
    expect(await listAll(files)).toEqual(["README"]);
    expect(await readText(files, "README")).toBe("lower\n");
  });
});

describe("the simulated-links table name in a cloned tree", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("is refused only where the storage reserves it: at the root of a simulated-links FilesApi", async () => {
    const server = await createInitializedTestServer();
    globalThis.fetch = server.mockFetch;
    await commitRawTree(server, async (blob) =>
      server.serverStores.trees.store([
        { name: ".WEBRUN-SYMLINKS.JSON", mode: FileMode.REGULAR_FILE, id: await blob("{}") },
      ]),
    );
    const url = createTestUrl(server.baseUrl);
    const atRoot = (files: WorktreeFilesApi, rootPath: string) =>
      createWorkingCopy((stores) =>
        createFileWorktree({ files, rootPath, blobs: stores.blobs, trees: stores.trees }),
      );

    const simulated = createSymlinkFilesApi(createInMemoryFilesApi());
    await expect(
      Git.fromWorkingCopy(atRoot(simulated, "/")).clone().setURI(url).call(),
    ).rejects.toBeInstanceOf(CloneCheckoutError);

    // a plain storage, or a worktree below the simulated root: an ordinary file name
    const plain = createInMemoryFilesApi();
    await Git.fromWorkingCopy(atRoot(plain, "/")).clone().setURI(url).call();
    expect(await plain.exists("/.WEBRUN-SYMLINKS.JSON")).toBe(true);
    const below = createSymlinkFilesApi(createInMemoryFilesApi());
    await Git.fromWorkingCopy(atRoot(below, "/repo")).clone().setURI(url).call();
    expect(await below.exists("/repo/.WEBRUN-SYMLINKS.JSON")).toBe(true);
  });
});
