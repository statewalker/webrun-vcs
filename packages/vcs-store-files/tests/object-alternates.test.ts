/**
 * Alternates in memory: git's parsing of `objects/info/alternates` and
 * `$GIT_ALTERNATE_OBJECT_DIRECTORIES`, the order and skips of `odb_add_alternate_recursively`,
 * and the store's reads and writes over them.
 */
import { createInMemoryFilesApi, GcOrchestrator, ObjectType } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";
import {
  AlternatesUnreadableError,
  collectReachabilityRoots,
  createGitFilesBackend,
  FileGcStrategy,
  FileWorktree,
  gc,
  listReachableObjects,
  MissingRootError,
  parseAlternates,
  repack,
} from "../src/index.js";

const enc = new TextEncoder();

describe("parseAlternates", () => {
  it("skips comments and empty entries, unquotes C-style paths, keeps the rest as written", () => {
    expect(parseAlternates('# a comment\n\n../x/objects\n"/a\\tb/objects"\n/c\r\n', "\n")).toEqual([
      "../x/objects",
      "/a\tb/objects",
      "/c\r",
    ]);
  });

  it("splits the variable at colons; a quoted entry may hold one", () => {
    expect(parseAlternates('/a/objects:"/b:c/objects":rel', ":")).toEqual([
      "/a/objects",
      "/b:c/objects",
      "rel",
    ]);
  });

  it("skips one character after a closing quote, whatever it is (git's end++)", () => {
    expect(parseAlternates('"/a"x/b\n', "\n")).toEqual(["/a", "/b"]);
  });

  it("reads broken quoting unquoted", () => {
    expect(parseAlternates('"/a\n/b\n', "\n")).toEqual(['"/a', "/b"]);
  });
});

/** A repository at `dir` in `files` holding one blob. */
async function repoWithBlob(
  files: ReturnType<typeof createInMemoryFilesApi>,
  dir: string,
  text: string,
) {
  const backend = await createGitFilesBackend({ files, gitDir: `${dir}/.git`, create: true });
  const bytes = enc.encode(text);
  const id = await backend.objects.put("blob", bytes.length, [bytes]);
  return { backend, id };
}

describe("a files store with alternates", () => {
  it("reads borrowed objects, lists them once, writes and removes only its own", async () => {
    const files = createInMemoryFilesApi();
    const alt = await repoWithBlob(files, "/alt", "borrowed\n");
    await files.write("/repo/.git/objects/info/alternates", [
      enc.encode("# shared\n../../../alt/.git/objects\n/alt/.git/objects\n/repo/.git/objects\n"),
    ]);
    const repo = await createGitFilesBackend({ files, gitDir: "/repo/.git", create: true });
    // the same directory twice and the objects directory itself are skipped quietly
    expect((await repo.objects.alternates?.list())?.map((a) => a.objectsDir)).toEqual([
      "/alt/.git/objects",
    ]);
    expect(repo.objects.alternates?.errors).toEqual([]);
    expect(await repo.objects.has(alt.id)).toBe(true);
    expect((await repo.objects.get(alt.id))?.type).toBe("blob");
    // a write of a borrowed object stores nothing here
    const bytes = enc.encode("borrowed\n");
    await repo.objects.put("blob", bytes.length, [bytes]);
    expect(await files.exists(`/repo/.git/objects/${alt.id.slice(0, 2)}/${alt.id.slice(2)}`)).toBe(
      false,
    );
    const own = enc.encode("own\n");
    const ownId = await repo.objects.put("blob", own.length, [own]);
    const listed: string[] = [];
    for await (const id of repo.objects.list()) listed.push(id);
    expect(listed.sort()).toEqual([alt.id, ownId].sort());
    const prefixed: string[] = [];
    for await (const id of repo.objects.listPrefix?.(alt.id.slice(0, 3)) ?? []) prefixed.push(id);
    expect(prefixed).toContain(alt.id);
    expect(await repo.objects.remove(alt.id)).toBe(false);
    expect(await alt.backend.objects.has(alt.id)).toBe(true);
  });

  it("reports a missing directory and nesting too deep, as git", async () => {
    const files = createInMemoryFilesApi();
    const dirs = ["/a0", "/a1", "/a2", "/a3", "/a4", "/a5", "/a6", "/a7"];
    const ids: string[] = [];
    for (const d of dirs) ids.push((await repoWithBlob(files, d, `${d}\n`)).id);
    for (let i = 0; i < dirs.length - 1; i++) {
      await files.write(`${dirs[i]}/.git/objects/info/alternates`, [
        enc.encode(`${dirs[i + 1]}/.git/objects\n${i === 0 ? "/gone/objects\n" : ""}`),
      ]);
    }
    const { objects } = await createGitFilesBackend({ files, gitDir: "/a0/.git" });
    // depth first: a1 and what it borrows are linked before a0's second entry
    expect(objects.alternates?.errors).toEqual([
      "error: /a6/.git/objects: ignoring alternate object stores, nesting too deep",
      "error: object directory /gone/objects does not exist; check .git/objects/info/alternates",
    ]);
    expect(await objects.has(ids[6] as string)).toBe(true);
    expect(await objects.has(ids[7] as string)).toBe(false);
  });

  it("adds an alternate (clone --shared) and dissociates from it (clone --dissociate)", async () => {
    const files = createInMemoryFilesApi();
    const alt = await repoWithBlob(files, "/alt", "borrowed\n");
    const repo = await createGitFilesBackend({ files, gitDir: "/repo/.git", create: true });
    expect(await repo.objects.has(alt.id)).toBe(false);
    await repo.objects.alternates?.add("/alt/.git/objects");
    await repo.objects.alternates?.add("/alt/.git/objects");
    expect(await files.exists("/repo/.git/objects/info/alternates")).toBe(true);
    expect(await repo.objects.has(alt.id)).toBe(true);
    await repo.history.refs.set("refs/tags/b", alt.id);
    await repo.objects.alternates?.dissociate?.();
    expect(await files.exists("/repo/.git/objects/info/alternates")).toBe(false);
    expect(await repo.objects.alternates?.list()).toEqual([]);
    // copied into a pack of its own
    expect(await repo.packs.has(alt.id)).toBe(true);
  });

  it("every later add() and refresh() invalidates the commit-graph, not only the first link", async () => {
    const files = createInMemoryFilesApi();
    await repoWithBlob(files, "/a1", "one\n");
    await repoWithBlob(files, "/a2", "two\n");
    const repo = await createGitFilesBackend({ files, gitDir: "/repo/.git", create: true });
    const provider = repo.history.commitGraph;
    if (!provider) throw new Error("no commit-graph provider");
    let invalidated = 0;
    const invalidate = provider.invalidate.bind(provider);
    provider.invalidate = () => {
      invalidated++;
      invalidate();
    };
    const alternates = repo.objects.alternates;
    if (!alternates?.onChange) throw new Error("no persistent change listener");
    let seen = 0;
    const stop = alternates.onChange(() => seen++);
    await alternates.add("/a1/.git/objects");
    expect(invalidated).toBe(1);
    // a second alternate (a later --reference, a refresh after another process wrote one)
    await alternates.add("/a2/.git/objects");
    expect(invalidated).toBe(2);
    await alternates.refresh();
    expect(invalidated).toBe(3);
    expect(seen).toBe(3);
    stop();
    await alternates.refresh();
    expect(seen).toBe(3);
    expect(invalidated).toBe(4);
  });
});

describe("gc, repack and prune over alternates that cannot be read", () => {
  /** A repository at /repo borrowing a commit from /alt, a branch at it, the blob also here. */
  async function borrowed() {
    const files = createInMemoryFilesApi();
    const alt = await createGitFilesBackend({ files, gitDir: "/alt/.git", create: true });
    const bytes = enc.encode("shared\n");
    const blob = await alt.objects.put("blob", bytes.length, [bytes]);
    const tree = await alt.history.trees.store([{ mode: 0o100644, name: "a.txt", id: blob }]);
    const who = { name: "a", email: "a@b", timestamp: 1, tzOffset: "+0000" };
    const commit = await alt.history.commits.store({
      tree,
      parents: [],
      author: who,
      committer: who,
      message: "c\n",
    });
    await alt.history.refs.set("refs/heads/main", commit);
    await files.write("/repo/.git/objects/info/alternates", [enc.encode("/alt/.git/objects\n")]);
    const repo = await createGitFilesBackend({ files, gitDir: "/repo/.git", create: true });
    await repo.history.refs.set("refs/heads/main", commit);
    // a loose copy of the blob of its own (git writes one, e.g. by hash-object -w)
    const loose = `/repo/.git/objects/${blob.slice(0, 2)}/${blob.slice(2)}`;
    const raw: Uint8Array[] = [];
    for await (const c of files.read(`/alt/.git/objects/${blob.slice(0, 2)}/${blob.slice(2)}`))
      raw.push(c);
    await files.write(loose, raw);
    return { files, commit, loose };
  }

  it("an alternate gone is no refusal, but a branch at its commit is bad object; nothing deleted", async () => {
    const { files, loose } = await borrowed();
    await files.remove("/alt");
    const repo = await createGitFilesBackend({ files, gitDir: "/repo/.git" });
    expect(repo.objects.alternates?.errors.length).toBeGreaterThan(0);
    const target = { ...repo, history: repo.history, gitDir: "/repo/.git" };
    await expect(gc({ ...target, pruneExpireMs: 0, writeCommitGraph: false })).rejects.toThrow(
      MissingRootError,
    );
    await expect(repack(target)).rejects.toThrow(MissingRootError);
    await expect(new FileGcStrategy(target).collectRoots()).rejects.toThrow(MissingRootError);
    expect(await files.exists(loose)).toBe(true);
  });

  it("refuses with an alternates file the store does not read (alternates: false)", async () => {
    const { files, loose } = await borrowed();
    const repo = await createGitFilesBackend({ files, gitDir: "/repo/.git", alternates: false });
    expect(repo.objects.alternates).toBeUndefined();
    const target = { ...repo, gitDir: "/repo/.git" };
    await expect(gc({ ...target, pruneExpireMs: 0, writeCommitGraph: false })).rejects.toThrow(
      /alternates are not read/,
    );
    await expect(repack(target)).rejects.toThrow(AlternatesUnreadableError);
    expect(await files.exists(loose)).toBe(true);
  });

  it("a ref whose object is missing is fatal (git's bad object), a reflog entry is not", async () => {
    const files = createInMemoryFilesApi();
    const { backend, id } = await repoWithBlob(files, "/r", "x\n");
    await backend.history.refs.set("refs/tags/x", id);
    const gone = "1".repeat(40);
    await files.write("/r/.git/logs/refs/tags/x", [
      enc.encode(`${"0".repeat(40)} ${gone} a <a@b> 1 +0000\tx\n`),
    ]);
    const roots = {
      files,
      gitDir: "/r/.git",
      refs: backend.history.refs,
      objects: backend.objects,
    };
    expect(await collectReachabilityRoots(roots)).toEqual([id]);
    await files.write("/r/.git/refs/heads/broken", [enc.encode(`${gone}\n`)]);
    await expect(collectReachabilityRoots(roots)).rejects.toThrow(MissingRootError);
    await expect(collectReachabilityRoots(roots)).rejects.toThrow("bad object refs/heads/broken");
  });
});

describe("alternates' upkeep", () => {
  it("refs() leaves out an alternate's refs to objects it lacks (for-each-ref there)", async () => {
    const files = createInMemoryFilesApi();
    const alt = await repoWithBlob(files, "/alt", "a\n");
    await alt.backend.history.refs.set("refs/tags/good", alt.id);
    await files.write("/alt/.git/refs/tags/dangling", [enc.encode(`${"2".repeat(40)}\n`)]);
    await files.write("/repo/.git/objects/info/alternates", [enc.encode("/alt/.git/objects\n")]);
    const repo = await createGitFilesBackend({ files, gitDir: "/repo/.git", create: true });
    expect(await repo.objects.alternates?.refs()).toEqual([alt.id]);
  });

  it("add() writes the file through alternates.lock and refuses while the lock is held", async () => {
    const files = createInMemoryFilesApi();
    await repoWithBlob(files, "/alt", "a\n");
    const repo = await createGitFilesBackend({ files, gitDir: "/repo/.git", create: true });
    await files.write("/repo/.git/objects/info/alternates.lock", [new Uint8Array()]);
    await expect(repo.objects.alternates?.add("/alt/.git/objects")).rejects.toThrow(
      /alternates\.lock': File exists/,
    );
    expect(await files.exists("/repo/.git/objects/info/alternates")).toBe(false);
    await files.remove("/repo/.git/objects/info/alternates.lock");
    await repo.objects.alternates?.add("/alt/.git/objects");
    expect(await files.exists("/repo/.git/objects/info/alternates.lock")).toBe(false);
    const text: string[] = [];
    for await (const c of files.read("/repo/.git/objects/info/alternates"))
      text.push(new TextDecoder().decode(c));
    expect(text.join("")).toBe("/alt/.git/objects\n");
  });

  it("a repository without alternates reads through its own store, no layer added", async () => {
    const files = createInMemoryFilesApi();
    const alt = await repoWithBlob(files, "/alt", "a\n");
    const local = await createGitFilesBackend({ files, gitDir: "/repo/.git", create: true });
    const getBefore = local.objects.get;
    expect(await local.objects.alternates?.refs()).toEqual([]);
    // linking one wraps the reads in place
    await local.objects.alternates?.add("/alt/.git/objects");
    expect(local.objects.get).not.toBe(getBefore);
    expect(await local.objects.has(alt.id)).toBe(true);
    expect(await local.history.blobs.has(alt.id)).toBe(true);
  });
});

describe("$GIT_ALTERNATE_OBJECT_DIRECTORIES and submodules", () => {
  it("a submodule opened through openGitlink does not read the variable (git: superproject only)", async () => {
    const files = createInMemoryFilesApi();
    const alt = await repoWithBlob(files, "/alt", "borrowed\n");
    const environment = {
      readFile: async () => undefined,
      alternateObjectDirectories: "/alt/.git/objects",
    };
    const superproject = await createGitFilesBackend({
      files,
      gitDir: "/super/.git",
      create: true,
      environment,
    });
    expect(await superproject.objects.has(alt.id)).toBe(true);
    await createGitFilesBackend({ files, gitDir: "/super/sub/.git", create: true });
    const worktree = new FileWorktree({
      files,
      rootPath: "/super",
      gitDir: "/super/.git",
      blobs: superproject.history.blobs,
      trees: superproject.history.trees,
      environment,
    });
    const sub = await worktree.openGitlink("sub");
    expect(sub).toBeDefined();
    expect(await sub?.history?.objects?.has(alt.id)).toBe(false);
  });
});

describe("gc, repack and prune with an alternate gone: the walk refuses, deleting nothing", () => {
  const who = { name: "a", email: "a@b", timestamp: 1, tzOffset: "+0000" };

  /**
   * /alt holds a commit (tree, blob) and an annotated tag of it; /repo borrows from it, holds
   * a loose copy of the borrowed blob and an unborrowed blob of its own; /alt is then removed
   * (git's error, no refusal up front: the walk alone must stop gc, repack and prune).
   */
  async function blindBorrower() {
    const files = createInMemoryFilesApi();
    const alt = await createGitFilesBackend({ files, gitDir: "/alt/.git", create: true });
    const shared = enc.encode("shared\n");
    const blob = await alt.objects.put("blob", shared.length, [shared]);
    const tree = await alt.history.trees.store([{ mode: 0o100644, name: "a.txt", id: blob }]);
    const commit = await alt.history.commits.store({
      tree,
      parents: [],
      author: who,
      committer: who,
      message: "c\n",
    });
    const tag = await alt.history.tags.store({
      object: commit,
      objectType: ObjectType.COMMIT,
      tag: "t",
      tagger: who,
      message: "t\n",
    });
    await alt.history.refs.set("refs/heads/main", commit);
    await files.write("/repo/.git/objects/info/alternates", [enc.encode("/alt/.git/objects\n")]);
    const seen = await createGitFilesBackend({ files, gitDir: "/repo/.git", create: true });
    const own = enc.encode("own\n");
    const mine = await seen.objects.put("blob", own.length, [own]);
    const loose = `/repo/.git/objects/${blob.slice(0, 2)}/${blob.slice(2)}`;
    const raw: Uint8Array[] = [];
    for await (const c of files.read(`/alt/.git/objects/${blob.slice(0, 2)}/${blob.slice(2)}`))
      raw.push(c);
    await files.write(loose, raw);
    await files.remove("/alt");
    const repo = await createGitFilesBackend({ files, gitDir: "/repo/.git" });
    expect(repo.objects.alternates?.errors.length).toBeGreaterThan(0);
    return { files, repo, blob, tree, commit, tag, mine, loose };
  }

  /** Every loose object file of /repo. */
  async function looseOf(files: ReturnType<typeof createInMemoryFilesApi>): Promise<string[]> {
    const out: string[] = [];
    for await (const d of files.list("/repo/.git/objects")) {
      if (d.kind !== "directory" || !/\/[0-9a-f]{2}$/.test(d.path)) continue;
      for await (const f of files.list(d.path)) out.push(f.path);
    }
    return out.sort();
  }

  /** gc, repack -a -d and the prune orchestrator each refuse, deleting nothing. */
  async function expectAllRefuse(fixture: Awaited<ReturnType<typeof blindBorrower>>) {
    const { files, repo } = fixture;
    const before = await looseOf(files);
    const target = { ...repo, gitDir: "/repo/.git" };
    await expect(gc({ ...target, pruneExpireMs: 0, writeCommitGraph: false })).rejects.toThrow();
    await expect(repack(target)).rejects.toThrow();
    await expect(
      new GcOrchestrator(repo.history, new FileGcStrategy(target)).run({ pruneExpireMs: 0 }),
    ).rejects.toThrow();
    expect(await looseOf(files)).toEqual(before);
    expect(await files.exists(fixture.loose)).toBe(true);
  }

  it("nothing borrowed reached: gc and repack go on, reporting git's error lines", async () => {
    const f = await blindBorrower();
    const own = await f.repo.history.trees.store([{ mode: 0o100644, name: "o", id: f.mine }]);
    const local = await f.repo.history.commits.store({
      tree: own,
      parents: [],
      author: who,
      committer: who,
      message: "local\n",
    });
    await f.repo.history.refs.set("refs/heads/main", local);
    const errors = f.repo.objects.alternates?.errors ?? [];
    expect(errors).toEqual([
      "error: object directory /alt/.git/objects does not exist; check .git/objects/info/alternates",
    ]);
    const target = { ...f.repo, gitDir: "/repo/.git" };
    const result = await gc({ ...target, pruneExpireMs: 0, writeCommitGraph: false });
    expect(result.errors).toEqual(errors);
    expect(result.repack?.objectCount).toBe(3);
    // the loose copy of the borrowed blob was unreachable here: pruned, as git prunes it
    expect(await f.files.exists(f.loose)).toBe(false);
    expect(await f.repo.objects.has(f.mine)).toBe(true);
    expect((await repack({ ...target, all: true }))?.errors).toEqual(errors);
  });

  it("a branch at a borrowed commit: bad object (MissingRootError)", async () => {
    const f = await blindBorrower();
    await f.repo.history.refs.set("refs/heads/main", f.commit);
    await expect(
      gc({ ...f.repo, gitDir: "/repo/.git", pruneExpireMs: 0, writeCommitGraph: false }),
    ).rejects.toThrow(MissingRootError);
    await expectAllRefuse(f);
  });

  it("a tag ref at a borrowed tag object: bad object (MissingRootError)", async () => {
    const f = await blindBorrower();
    await f.repo.history.refs.set("refs/tags/t", f.tag);
    await expectAllRefuse(f);
  });

  it("a local commit of a borrowed tree, or with a borrowed parent: the walk fails", async () => {
    for (const shape of ["tree", "parent"] as const) {
      const f = await blindBorrower();
      const own = await f.repo.history.trees.store([{ mode: 0o100644, name: "o", id: f.mine }]);
      const local = await f.repo.history.commits.store({
        tree: shape === "tree" ? f.tree : own,
        parents: shape === "parent" ? [f.commit] : [],
        author: who,
        committer: who,
        message: "local\n",
      });
      await f.repo.history.refs.set("refs/heads/main", local);
      await expectAllRefuse(f);
    }
  });

  it("a local tree naming a borrowed blob: the walk fails", async () => {
    const f = await blindBorrower();
    // the borrowed blob, which this store cannot see (its loose copy removed)
    await f.files.remove(f.loose);
    const borrowedOnly = await f.repo.history.trees.store([
      { mode: 0o100644, name: "a.txt", id: f.blob },
      { mode: 0o100644, name: "o", id: f.mine },
    ]);
    const local = await f.repo.history.commits.store({
      tree: borrowedOnly,
      parents: [],
      author: who,
      committer: who,
      message: "local\n",
    });
    await f.repo.history.refs.set("refs/heads/main", local);
    const before = await looseOf(f.files);
    const target = { ...f.repo, gitDir: "/repo/.git" };
    await expect(gc({ ...target, pruneExpireMs: 0, writeCommitGraph: false })).rejects.toThrow();
    await expect(repack(target)).rejects.toThrow();
    await expect(
      new GcOrchestrator(f.repo.history, new FileGcStrategy(target)).run({ pruneExpireMs: 0 }),
    ).rejects.toThrow();
    expect(await looseOf(f.files)).toEqual(before);
  });
});

describe("why alternates: false still refuses", () => {
  it("a local object reached only through a borrowed reflog entry is not listed blind", async () => {
    const files = createInMemoryFilesApi();
    const who = { name: "a", email: "a@b", timestamp: 1, tzOffset: "+0000" };
    const alt = await createGitFilesBackend({ files, gitDir: "/alt/.git", create: true });
    await files.write("/repo/.git/objects/info/alternates", [enc.encode("/alt/.git/objects\n")]);
    const seen = await createGitFilesBackend({ files, gitDir: "/repo/.git", create: true });
    // a blob only here, under a borrowed commit that only the reflog names
    const bytes = enc.encode("only here\n");
    const blob = await seen.objects.put("blob", bytes.length, [bytes]);
    const tree = await alt.history.trees.store([{ mode: 0o100644, name: "a", id: blob }]);
    const commit = await alt.history.commits.store({
      tree,
      parents: [],
      author: who,
      committer: who,
      message: "c\n",
    });
    await files.write("/repo/.git/logs/refs/heads/x", [
      enc.encode(`${"0".repeat(40)} ${commit} a <a@b> 1 +0000\tx\n`),
    ]);
    const roots = { files, gitDir: "/repo/.git", refs: seen.history.refs, objects: seen.objects };
    expect((await listReachableObjects(roots)).map((o) => o.id)).toContain(blob);
    const repo = await createGitFilesBackend({ files, gitDir: "/repo/.git", alternates: false });
    const blind = { ...roots, objects: repo.objects };
    // the walk skips the reflog entry it cannot read, as git skips a commit that is gone
    expect((await listReachableObjects(blind)).map((o) => o.id)).not.toContain(blob);
    await expect(
      gc({ ...repo, gitDir: "/repo/.git", pruneExpireMs: 0, writeCommitGraph: false }),
    ).rejects.toThrow(/alternates are not read/);
    expect(await seen.objects.has(blob)).toBe(true);
  });
});
