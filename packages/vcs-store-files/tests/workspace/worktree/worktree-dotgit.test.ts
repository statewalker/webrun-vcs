/**
 * Checkout never writes into the repository's own `.git`, whatever spelling a crafted tree uses
 * (git's verify_path, CVE-2014-9390): FileWorktree refuses such paths.
 */
import { createInMemoryFilesApi, createMemoryHistory, FileMode } from "@statewalker/vcs-core";
import { createFileWorktree } from "@statewalker/vcs-store-files";
import { describe, expect, it } from "vitest";

const enc = new TextEncoder();

async function read(files: ReturnType<typeof createInMemoryFilesApi>, path: string) {
  const chunks: Uint8Array[] = [];
  for await (const c of files.read(path)) chunks.push(c);
  return new TextDecoder().decode(chunks.length === 1 ? chunks[0] : new Uint8Array(0));
}

describe("FileWorktree refuses paths that name .git", () => {
  const spellings = [".git", ".GIT", "git~1", ".git. ", "‌.git"];

  for (const dotgit of spellings) {
    it(`checkoutTree does not write through a tree entry ${JSON.stringify(dotgit)}`, async () => {
      const files = createInMemoryFilesApi();
      await files.write("/repo/.git/config", [enc.encode("original")]);
      const stores = createMemoryHistory();
      const evil = await stores.blobs.store([enc.encode("evil")]);
      const gitTree = await stores.trees.store([
        { name: "config", mode: FileMode.REGULAR_FILE, id: evil },
      ]);
      const ok = await stores.blobs.store([enc.encode("ok")]);
      const root = await stores.trees.store([
        { name: dotgit, mode: FileMode.TREE, id: gitTree },
        { name: "a.txt", mode: FileMode.REGULAR_FILE, id: ok },
      ]);
      const worktree = createFileWorktree({
        files,
        rootPath: "/repo",
        blobs: stores.blobs,
        trees: stores.trees,
      });

      const result = await worktree.checkoutTree(root, { force: true });

      expect(result.updated).toEqual(["a.txt"]);
      expect(result.failed.map((f) => f.path)).toEqual([`${dotgit}/config`]);
      expect(await read(files, "/repo/.git/config")).toBe("original");
    });
  }

  it("writeContent, mkdir and rename refuse a .git path", async () => {
    const files = createInMemoryFilesApi();
    const stores = createMemoryHistory();
    const worktree = createFileWorktree({
      files,
      rootPath: "/repo",
      blobs: stores.blobs,
      trees: stores.trees,
    });
    await expect(worktree.writeContent(".git/config", enc.encode("x"))).rejects.toThrow(
      /Invalid worktree path/,
    );
    await expect(worktree.mkdir("sub/.Git")).rejects.toThrow(/Invalid worktree path/);
    await worktree.writeContent("a.txt", enc.encode("x"));
    await expect(worktree.rename("a.txt", ".git/hooks/post-checkout")).rejects.toThrow(
      /Invalid worktree path/,
    );
    expect(await files.exists("/repo/.git/hooks/post-checkout")).toBe(false);
  });
});
