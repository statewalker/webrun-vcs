/**
 * The symbolic-link security suite, run against any link-aware FilesApi (`PosixFilesApi`):
 * a real directory (`createNodeFilesApi`) and simulated links (`createSymlinkFilesApi`) over
 * memory or a mounted composite. Every repro of the three reviews of the clone checkout:
 * writes through links, `h -> .git/hooks`, backslash paths on Windows, case folding,
 * dangling links, add/status of links, reset/stash/checkout, the resolution store.
 *
 * Everything goes through the FilesApi: the worktree lives at `/repo`, the "outside" files
 * a link points to at `/outside.txt` and `/outdir` of the same FilesApi.
 */

import {
  type Blobs,
  FileMode,
  type ObjectId,
  type PosixFilesApi,
  type Trees,
} from "@statewalker/vcs-core";
import {
  createFileWorktree,
  GitResolutionStore,
  probeCaseFolding,
} from "@statewalker/vcs-store-files";
import {
  createMemoryObjectStores,
  MemoryRefs,
  MemoryStagingStore,
} from "@statewalker/vcs-store-mem";
import {
  createMemoryGitStaging,
  MemoryCheckout,
  MemoryWorkingCopy,
  MergeStage,
  type WorkingCopy,
  type Worktree,
} from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planTreeRestore } from "../src/commands/tree-restore.js";
import { Git, ResetMode } from "../src/index.js";
import { createSimpleHistory } from "./simple-history-store.js";
import { testAuthor } from "./test-helper.js";

/** A link-aware FilesApi to run the suite on. */
export interface LinkAwareFactory {
  name: string;
  /** A fresh, empty FilesApi */
  create(): Promise<{ files: PosixFilesApi; cleanup(): Promise<void> }>;
  /** The same storage, as on Windows (`pathSeparators` `"/\\"`) */
  windows?(): Promise<{ files: PosixFilesApi; cleanup(): Promise<void> }>;
  /** A storage that folds case, when the implementation can simulate one */
  caseInsensitive?(): Promise<{ files: PosixFilesApi; cleanup(): Promise<void> }>;
}

const ROOT = "/repo";
const enc = new TextEncoder();
const dec = new TextDecoder();
const noStores = { blobs: {} as Blobs, trees: {} as Trees };

async function text(files: PosixFilesApi, path: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of files.read(path)) chunks.push(chunk);
  return dec.decode(Buffer.concat(chunks));
}

async function collect(stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return dec.decode(Buffer.concat(chunks));
}

/** The trees of a working copy as a restore plan walks them (`loadTree`). */
function planTrees(wc: WorkingCopy): Parameters<typeof planTreeRestore>[0] {
  const trees = wc.history.trees;
  return Object.assign(Object.create(trees), {
    loadTree: async function* (id: ObjectId) {
      const entries = await trees.load(id);
      if (entries) yield* entries;
    },
  });
}

/** A working copy: memory history and index, the worktree a FileWorktree at /repo. */
function workingCopyOver(files: PosixFilesApi): WorkingCopy {
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
    worktree: createFileWorktree({
      files,
      rootPath: ROOT,
      blobs: stores.blobs,
      trees: stores.trees,
    }),
    config: {},
  });
}

/** Commits a tree of `entries` (path → [content, mode]) on main, HEAD naming main. */
async function commit(
  wc: WorkingCopy,
  entries: Record<string, [string, number]>,
  message: string,
): Promise<ObjectId> {
  const { blobs, trees, commits, refs } = wc.history;
  type Node = Map<string, Node | { id: ObjectId; mode: number }>;
  const root: Node = new Map();
  for (const [path, [content, mode]] of Object.entries(entries)) {
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.get(part) as Node | undefined;
      if (!next) {
        next = new Map();
        node.set(part, next);
      }
      node = next;
    }
    node.set(parts[parts.length - 1], { id: await blobs.store([enc.encode(content)]), mode });
  }
  const store = async (node: Node): Promise<ObjectId> => {
    const list: { name: string; mode: number; id: ObjectId }[] = [];
    for (const [name, value] of node) {
      if (value instanceof Map) list.push({ name, mode: FileMode.TREE, id: await store(value) });
      else list.push({ name, ...value });
    }
    return trees.store(list);
  };
  const parent = (await refs.resolve("HEAD"))?.objectId;
  const id = await commits.store({
    tree: await store(root),
    parents: parent ? [parent] : [],
    author: testAuthor(),
    committer: testAuthor(),
    message,
  });
  await refs.set("refs/heads/main", id);
  await refs.setSymbolic("HEAD", "refs/heads/main");
  return id;
}

/**
 * Two commits on main and `other`: HEAD at main (`from`, checked out with reset --hard),
 * `other` holding `to`.
 */
async function branches(
  wc: WorkingCopy,
  from: Record<string, [string, number]>,
  to: Record<string, [string, number]>,
): Promise<Git> {
  const git = Git.fromWorkingCopy(wc);
  const main = await commit(wc, from, "main");
  await git.reset().setMode(ResetMode.HARD).setRef(main).call();
  const other = await commit(wc, to, "other");
  await wc.history.refs.set("refs/heads/other", other);
  await wc.history.refs.set("refs/heads/main", main);
  return git;
}

/** The suite, for one link-aware FilesApi implementation. */
export function describeSymlinkSecurity(factory: LinkAwareFactory): void {
  describe(`symbolic-link security (${factory.name})`, () => {
    let files: PosixFilesApi;
    let cleanup: () => Promise<void>;
    let worktree: Worktree;

    beforeEach(async () => {
      ({ files, cleanup } = await factory.create());
      await files.mkdir(ROOT);
      await files.mkdir(`${ROOT}/.git/hooks`);
      await files.write(`${ROOT}/.git/config`, [enc.encode("[core]\n")]);
      await files.write("/outside.txt", [enc.encode("original\n")]);
      await files.write("/outdir/secret.txt", [enc.encode("SECRET\n")]);
      await files.symlink?.(enc.encode("../outside.txt"), `${ROOT}/x`);
      await files.symlink?.(enc.encode("../outdir"), `${ROOT}/d`);
      await files.symlink?.(enc.encode(".git/hooks"), `${ROOT}/h`);
      await files.symlink?.(enc.encode("missing"), `${ROOT}/dangling`);
      worktree = createFileWorktree({ files, rootPath: ROOT, gitDir: `${ROOT}/.git`, ...noStores });
    });
    afterEach(async () => cleanup());

    const outsideUntouched = async () => {
      expect(await text(files, "/outside.txt")).toBe("original\n");
      const names: string[] = [];
      for await (const entry of files.list("/outdir")) names.push(entry.name);
      expect(names).toEqual(["secret.txt"]);
    };

    it("reports links as links: lstat, readlink, list, capabilities", async () => {
      expect((await files.lstat?.(`${ROOT}/x`))?.kind).toBe("symlink");
      expect(dec.decode(await files.readlink?.(`${ROOT}/x`))).toBe("../outside.txt");
      expect(worktree.capabilities).toMatchObject({ symlinks: true });
      const entry = await worktree.getEntry("x");
      expect(entry?.mode).toBe(FileMode.SYMLINK);
      expect(await collect(worktree.readContent("x"))).toBe("../outside.txt");
    });

    it("replaces a link at the path written, never writing through it", async () => {
      await worktree.writeContent("x", enc.encode("PWNED\n"));
      await outsideUntouched();
      expect((await files.lstat?.(`${ROOT}/x`))?.kind).toBe("file");
      expect(await text(files, `${ROOT}/x`)).toBe("PWNED\n");
    });

    it("refuses every operation beneath a link", async () => {
      await expect(worktree.writeContent("d/evil.txt", enc.encode("x"))).rejects.toThrow(
        /symbolic link/,
      );
      await expect(worktree.mkdir("d/sub")).rejects.toThrow(/symbolic link/);
      await expect(collect(worktree.readContent("d/secret.txt"))).rejects.toThrow(/symbolic link/);
      await expect(worktree.computeHash("d/secret.txt")).rejects.toThrow(/symbolic link/);
      expect(await worktree.getEntry("d/secret.txt")).toBeUndefined();
      expect(await worktree.remove("d/secret.txt")).toBe(false);
      await expect(files.lstat?.(`${ROOT}/d/secret.txt`)).rejects.toThrow(/symbolic link/);
      await outsideUntouched();
    });

    it("never writes a hook through h -> .git/hooks; a forced write replaces the link", async () => {
      await expect(
        worktree.writeContent("h/post-commit", enc.encode("#!/bin/sh\n")),
      ).rejects.toThrow(/symbolic link/);
      expect(await files.exists(`${ROOT}/.git/hooks/post-commit`)).toBe(false);
      await worktree.writeContent("h/post-commit", enc.encode("#!/bin/sh\n"), {
        replaceInTheWay: true,
      });
      expect(await files.exists(`${ROOT}/.git/hooks/post-commit`)).toBe(false);
      expect((await files.lstat?.(`${ROOT}/h`))?.kind).toBe("directory");
    });

    it("replaces and removes dangling links", async () => {
      expect(await worktree.exists("dangling")).toBe(true);
      await worktree.writeContent("dangling", enc.encode("file\n"));
      expect((await files.lstat?.(`${ROOT}/dangling`))?.kind).toBe("file");
      await files.symlink?.(enc.encode("nowhere"), `${ROOT}/gone`);
      expect(await worktree.remove("gone")).toBe(true);
      expect(await files.lstat?.(`${ROOT}/gone`)).toBeUndefined();
    });

    it("stages a link as 120000 with its target, never the file it names (add, status)", async () => {
      const wc = workingCopyOver(files);
      const git = Git.fromWorkingCopy(wc);
      await git.add().addFilepattern("x").call();
      const entry = await wc.checkout.staging.getEntry("x");
      expect(entry?.mode).toBe(FileMode.SYMLINK);
      expect(await collect((await wc.history.blobs.load(entry?.objectId ?? "")) ?? [])).toBe(
        "../outside.txt",
      );
      // what status compares: the worktree's hash of the link is the staged blob
      expect(await wc.worktree.computeHash("x")).toBe(entry?.objectId);
    });

    it("reset --hard from links to files replaces them, never writing through", async () => {
      const wc = workingCopyOver(files);
      const git = Git.fromWorkingCopy(wc);
      await commit(wc, { a: ["a\n", FileMode.REGULAR_FILE] }, "base");
      await commit(
        wc,
        {
          x: ["../outside.txt", FileMode.SYMLINK],
          d: ["../outdir", FileMode.SYMLINK],
        },
        "links",
      );
      await git.reset().setMode(ResetMode.HARD).setRef("HEAD").call();
      const files2 = await commit(
        wc,
        {
          x: ["PWNED\n", FileMode.REGULAR_FILE],
          "d/evil.txt": ["EVIL\n", FileMode.REGULAR_FILE],
        },
        "files",
      );
      await git.reset().setMode(ResetMode.HARD).setRef(files2).call();
      await outsideUntouched();
      expect(await text(files, `${ROOT}/x`)).toBe("PWNED\n");
      expect(await text(files, `${ROOT}/d/evil.txt`)).toBe("EVIL\n");
    });

    it("reset --hard replaces an untracked directory where a file must go", async () => {
      const wc = workingCopyOver(files);
      const git = Git.fromWorkingCopy(wc);
      await files.write(`${ROOT}/spot/inner.txt`, [enc.encode("untracked\n")]);
      const id = await commit(wc, { spot: ["file\n", FileMode.REGULAR_FILE] }, "file");
      await git.reset().setMode(ResetMode.HARD).setRef(id).call();
      expect((await files.lstat?.(`${ROOT}/spot`))?.kind).toBe("file");
      expect(await text(files, `${ROOT}/spot`)).toBe("file\n");
    });

    it("checkout keeps unstaged edits and refuses to overwrite them", async () => {
      const wc = workingCopyOver(files);
      const git = Git.fromWorkingCopy(wc);
      await commit(
        wc,
        {
          "gone.txt": ["gone\n", FileMode.REGULAR_FILE],
          "same.txt": ["same\n", FileMode.REGULAR_FILE],
        },
        "main",
      );
      await git.reset().setMode(ResetMode.HARD).setRef("HEAD").call();
      const main = (await wc.history.refs.resolve("HEAD"))?.objectId ?? "";
      const other = await commit(wc, { "same.txt": ["same\n", FileMode.REGULAR_FILE] }, "other");
      await wc.history.refs.set("refs/heads/other", other);
      await wc.history.refs.set("refs/heads/main", main);

      await files.write(`${ROOT}/gone.txt`, [enc.encode("EDITED\n")]);
      const refused = await git.checkout().setName("other").call();
      expect(refused.status).toBe("CONFLICTS");
      expect(refused.message).toContain("would be overwritten by checkout");
      expect(await text(files, `${ROOT}/gone.txt`)).toBe("EDITED\n");

      await files.write(`${ROOT}/gone.txt`, [enc.encode("gone\n")]);
      await files.write(`${ROOT}/same.txt`, [enc.encode("LOCAL\n")]);
      const switched = await git.checkout().setName("other").call();
      expect(switched.status).toBe("OK");
      expect(await text(files, `${ROOT}/same.txt`)).toBe("LOCAL\n");
      expect(await files.exists(`${ROOT}/gone.txt`)).toBe(false);
    });

    it("stash apply restores links as links", async () => {
      const wc = workingCopyOver(files);
      const git = Git.fromWorkingCopy(wc);
      await files.remove(`${ROOT}/x`);
      const head = await commit(wc, { a: ["a\n", FileMode.REGULAR_FILE] }, "base");
      await git.reset().setMode(ResetMode.HARD).setRef("HEAD").call();
      // a stash (index and worktree commits) whose trees hold a link `ln -> a`
      const { blobs, trees, commits, refs } = wc.history;
      const tree = await trees.store([
        { name: "a", mode: FileMode.REGULAR_FILE, id: await blobs.store([enc.encode("a\n")]) },
        { name: "ln", mode: FileMode.SYMLINK, id: await blobs.store([enc.encode("a")]) },
      ]);
      const who = testAuthor();
      const indexCommit = await commits.store({
        tree,
        parents: [head],
        author: who,
        committer: who,
        message: "index on main",
      });
      const stash = await commits.store({
        tree,
        parents: [head, indexCommit],
        author: who,
        committer: who,
        message: "WIP on main",
      });
      await refs.set("refs/stash", stash);
      await git.stashApply().call();
      expect((await files.lstat?.(`${ROOT}/ln`))?.kind).toBe("symlink");
      expect(dec.decode(await files.readlink?.(`${ROOT}/ln`))).toBe("a");
    });

    it("the resolution store stages a link as a link and replaces it, never writing through", async () => {
      const { blobs } = createMemoryObjectStores();
      const staging = createMemoryGitStaging();
      const ours = await blobs.store([enc.encode("ours\n")]);
      const theirs = await blobs.store([enc.encode("theirs\n")]);
      for (const [stage, id] of [
        [MergeStage.OURS, ours],
        [MergeStage.THEIRS, theirs],
      ] as const) {
        await staging.setEntry({ path: "x", objectId: id, mode: 0o100644, stage });
      }
      const store = new GitResolutionStore(files, staging, blobs, `${ROOT}/.git`, ROOT);
      await store.markAllResolved();
      expect((await staging.getEntry("x"))?.mode).toBe(FileMode.SYMLINK);
      // conflicted again: accepting a side replaces the link
      await staging.removeEntry("x", MergeStage.MERGED);
      for (const [stage, id] of [
        [MergeStage.OURS, ours],
        [MergeStage.THEIRS, theirs],
      ] as const) {
        await staging.setEntry({ path: "x", objectId: id, mode: 0o100644, stage });
      }
      await store.acceptOurs("x");
      await outsideUntouched();
      expect(await text(files, `${ROOT}/x`)).toBe("ours\n");
    });

    it("plans refuse a path beneath a link of the same tree", async () => {
      const wc = workingCopyOver(files);
      const hooks = await wc.history.trees.store([
        {
          name: "post-commit",
          mode: FileMode.EXECUTABLE_FILE,
          id: await wc.history.blobs.store([enc.encode("x")]),
        },
      ]);
      const tree = await wc.history.trees.store([
        {
          name: "h",
          mode: FileMode.SYMLINK,
          id: await wc.history.blobs.store([enc.encode(".git/hooks")]),
        },
        { name: "h", mode: FileMode.TREE, id: hooks },
      ]);
      await expect(
        planTreeRestore(planTrees(wc), wc.history.blobs, tree, "test", { symlinks: true }),
      ).rejects.toThrow(/collides|not a directory/);
    });

    const F = FileMode.REGULAR_FILE;

    it("stash apply never deletes an untracked directory, nor overwrites unrelated edits", async () => {
      const wc = workingCopyOver(files);
      const git = Git.fromWorkingCopy(wc);
      await files.remove(`${ROOT}/x`);
      const head = await commit(wc, { a: ["a\n", F], b: ["b\n", F] }, "base");
      await git.reset().setMode(ResetMode.HARD).setRef(head).call();
      const { trees, blobs, commits, refs } = wc.history;
      const blob = async (t: string) => blobs.store([enc.encode(t)]);
      const tree = await trees.store([
        { name: "a", mode: F, id: await blob("a stashed\n") },
        { name: "b", mode: F, id: await blob("b\n") },
        { name: "spot", mode: F, id: await blob("spot\n") },
      ]);
      const who = testAuthor();
      const index = await commits.store({
        tree,
        parents: [head],
        author: who,
        committer: who,
        message: "i",
      });
      const stash = await commits.store({
        tree,
        parents: [head, index],
        author: who,
        committer: who,
        message: "WIP",
      });
      await refs.set("refs/stash", stash);

      await files.write(`${ROOT}/spot/precious.txt`, [enc.encode("precious\n")]);
      await expect(git.stashApply().call()).rejects.toThrow(
        /Updating the following directories would lose untracked files in them:\n\tspot\n\nAborting/,
      );
      expect(await text(files, `${ROOT}/spot/precious.txt`)).toBe("precious\n");
      expect(await text(files, `${ROOT}/a`)).toBe("a\n");

      await files.remove(`${ROOT}/spot`);
      await files.write(`${ROOT}/b`, [enc.encode("b EDITED\n")]);
      await git.stashApply().call();
      expect(await text(files, `${ROOT}/a`)).toBe("a stashed\n");
      expect(await text(files, `${ROOT}/b`)).toBe("b EDITED\n");

      await git.reset().setMode(ResetMode.HARD).setRef(head).call();
      await files.write(`${ROOT}/a`, [enc.encode("a EDITED\n")]);
      await expect(git.stashApply().call()).rejects.toThrow(
        /Your local changes to the following files would be overwritten by merge:\n\ta\n/,
      );
      expect(await text(files, `${ROOT}/a`)).toBe("a EDITED\n");
    });

    it("checkout refuses an untracked file on a leading component, removing nothing", async () => {
      const wc = workingCopyOver(files);
      const git = await branches(wc, { gone: ["gone\n", F] }, { "new/x": ["x\n", F] });
      await files.write(`${ROOT}/new`, [enc.encode("untracked\n")]);
      const result = await git.checkout().setName("other").call();
      expect(result.status).toBe("CONFLICTS");
      expect(result.message).toContain(
        "untracked working tree files would be overwritten by checkout:\n\tnew\n",
      );
      expect(await text(files, `${ROOT}/gone`)).toBe("gone\n");
    });

    it("checkout switches a clean directory to a file, refusing one with untracked files", async () => {
      const wc = workingCopyOver(files);
      const git = await branches(wc, { "d/x": ["x\n", F] }, { d: ["file\n", F] });
      await files.write(`${ROOT}/d/extra`, [enc.encode("untracked\n")]);
      const refused = await git.checkout().setName("other").call();
      expect(refused.message).toBe(
        "error: Updating the following directories would lose untracked files in them:\n\td\n\nAborting",
      );
      expect(await text(files, `${ROOT}/d/x`)).toBe("x\n");
      await files.remove(`${ROOT}/d/extra`);
      const switched = await git.checkout().setName("other").call();
      expect(switched.status).toBe("OK");
      expect(await text(files, `${ROOT}/d`)).toBe("file\n");
    });

    it("checkout refuses a local executable-bit change on a path the target changes", async () => {
      const wc = workingCopyOver(files);
      if (!wc.worktree.capabilities?.executable) return;
      const git = await branches(wc, { run: ["1\n", F] }, { run: ["2\n", F] });
      await files.chmod?.(`${ROOT}/run`, 0o755);
      const result = await git.checkout().setName("other").call();
      expect(result.status).toBe("CONFLICTS");
      expect(result.message).toContain(
        "Your local changes to the following files would be overwritten",
      );
    });

    it("checkout refuses to remove a file a staged deletion left untracked", async () => {
      const wc = workingCopyOver(files);
      const git = await branches(wc, { keep: ["k\n", F], gone: ["g\n", F] }, { keep: ["k\n", F] });
      await wc.checkout.staging.removeEntry("gone");
      const result = await git.checkout().setName("other").call();
      expect(result.message).toBe(
        [
          "error: The following untracked working tree files would be removed by checkout:",
          "\tgone",
          "Please move or remove them before you switch branches.",
          "Aborting",
        ].join("\n"),
      );
      expect(await text(files, `${ROOT}/gone`)).toBe("g\n");
    });

    it("checkout overwrites an ignored file in the way (.gitignore read as git)", async () => {
      const wc = workingCopyOver(files);
      const git = await branches(
        wc,
        { ".gitignore": ["*.log\n", F] },
        { ".gitignore": ["*.log\n", F], "new.log": ["tracked\n", F] },
      );
      await files.write(`${ROOT}/new.log`, [enc.encode("ignored scratch\n")]);
      const result = await git.checkout().setName("other").call();
      expect(result.status).toBe("OK");
      expect(await text(files, `${ROOT}/new.log`)).toBe("tracked\n");
    });

    if (factory.windows) {
      it("on Windows refuses a backslash path; elsewhere it is a file name", async () => {
        const win = await factory.windows?.();
        if (!win) return;
        try {
          const w = createFileWorktree({ files: win.files, rootPath: "/w", ...noStores });
          await expect(w.writeContent("d\\post-checkout", enc.encode("x"))).rejects.toThrow();
        } finally {
          await win.cleanup();
        }
        await worktree.writeContent("a\\b.txt", enc.encode("x"));
        expect(await text(files, `${ROOT}/a\\b.txt`)).toBe("x");
      });
    }

    if (factory.caseInsensitive) {
      it("probes case folding; colliding files both planned, a path beneath a link refused", async () => {
        const folded = await factory.caseInsensitive?.();
        if (!folded) return;
        try {
          await folded.files.write("/.git/config", [enc.encode("[core]\n")]);
          expect((await probeCaseFolding(folded.files, "/.git")).ignoreCase).toBe(true);
          const wc = workingCopyOver(folded.files);
          const blob = await wc.history.blobs.store([enc.encode("x")]);
          const tree = await wc.history.trees.store([
            { name: "README", mode: FileMode.REGULAR_FILE, id: blob },
            { name: "readme", mode: FileMode.REGULAR_FILE, id: blob },
          ]);
          const plan = await planTreeRestore(planTrees(wc), wc.history.blobs, tree, "t", {
            ignoreCase: true,
          });
          expect(plan.collided).toEqual(["README", "readme"]);
          const sub = await wc.history.trees.store([
            { name: "x", mode: FileMode.REGULAR_FILE, id: blob },
          ]);
          const evil = await wc.history.trees.store([
            { name: "H", mode: FileMode.TREE, id: sub },
            { name: "h", mode: FileMode.SYMLINK, id: blob },
          ]);
          await expect(
            planTreeRestore(planTrees(wc), wc.history.blobs, evil, "t", {
              ignoreCase: true,
              symlinks: true,
            }),
          ).rejects.toThrow(/collides/);

          // a case-only rename switches, as git does on a case-folding worktree
          await folded.files.mkdir(ROOT);
          const renaming = workingCopyOver(folded.files);
          (renaming.config as Record<string, unknown>)["core.ignorecase"] = "true";
          const git = await branches(
            renaming,
            { README: ["text\n", FileMode.REGULAR_FILE] },
            { readme: ["text\n", FileMode.REGULAR_FILE] },
          );
          const switched = await git.checkout().setName("other").call();
          expect(switched.status).toBe("OK");
          const names: string[] = [];
          for await (const entry of folded.files.list(ROOT)) names.push(entry.name);
          expect(names).toEqual(["readme"]);
        } finally {
          await folded.cleanup();
        }
      });
    }
  });
}
