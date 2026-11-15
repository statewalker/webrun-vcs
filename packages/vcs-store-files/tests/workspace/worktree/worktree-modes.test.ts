/**
 * FileWorktree writes git's file modes through the optional `chmod` and `symlink` of
 * its FilesApi, and falls back as git does without them (`core.filemode` /
 * `core.symlinks` false): a plain file, a file holding the link target.
 */
import { type Blobs, createInMemoryFilesApi, FileMode, type Trees } from "@statewalker/vcs-core";
import { createFileWorktree, type WorktreeFilesApi } from "@statewalker/vcs-store-files";
import { describe, expect, it } from "vitest";

const enc = new TextEncoder();

/** Checkout is not exercised: the worktree never reaches blobs or trees here. */
const noStores = { blobs: {} as Blobs, trees: {} as Trees };

async function readText(files: WorktreeFilesApi, path: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of files.read(path)) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

describe("FileWorktree file modes", () => {
  it("without chmod and symlink: plain files, the link target as content", async () => {
    const files = createInMemoryFilesApi();
    const worktree = createFileWorktree({ files, rootPath: "/w", ...noStores });

    expect(worktree.capabilities).toMatchObject({ executable: false, symlinks: false });
    await worktree.writeContent("run.sh", enc.encode("#!/bin/sh\n"), {
      mode: FileMode.EXECUTABLE_FILE,
    });
    await worktree.writeContent("link", enc.encode("run.sh"), { mode: FileMode.SYMLINK });

    expect(await readText(files, "/w/run.sh")).toBe("#!/bin/sh\n");
    expect(await readText(files, "/w/link")).toBe("run.sh");
  });

  it("with chmod and symlink: permission bits and a link", async () => {
    const modes = new Map<string, number>();
    const links = new Map<string, string>();
    const base = createInMemoryFilesApi();
    const files: WorktreeFilesApi = Object.assign(base, {
      chmod: async (path: string, mode: number) => {
        modes.set(path, mode);
      },
      symlink: async (target: Uint8Array, path: string) => {
        links.set(path, new TextDecoder().decode(target));
      },
      lstat: async (path: string) => {
        if (links.has(path)) return { kind: "symlink" as const, size: 1, lastModified: 1 };
        const stats = await base.stats(path);
        return stats && { kind: stats.kind, size: stats.size ?? 0, lastModified: 0, mode: 0o640 };
      },
      readlink: async (path: string) => {
        const link = links.get(path);
        return link === undefined ? undefined : enc.encode(link);
      },
    });
    const worktree = createFileWorktree({ files, rootPath: "/w", ...noStores });

    expect(worktree.capabilities).toMatchObject({ executable: true, symlinks: true });
    await worktree.writeContent("run.sh", enc.encode("x"), { mode: FileMode.EXECUTABLE_FILE });
    await worktree.writeContent("a.txt", enc.encode("y"), { mode: FileMode.REGULAR_FILE });
    await worktree.writeContent("d/link", [enc.encode("../"), enc.encode("a.txt")], {
      mode: FileMode.SYMLINK,
    });

    // x where r is set, from the file's own mode (0o640 here: the umask is kept)
    expect(modes.get("/w/run.sh")).toBe(0o750);
    // a regular file without x keeps its mode: no chmod
    expect(modes.has("/w/a.txt")).toBe(false);
    expect(links.get("/w/d/link")).toBe("../a.txt");
    expect(modes.has("/w/d/link")).toBe(false);
    expect(await files.exists("/w/d/link")).toBe(false);
  });
});
