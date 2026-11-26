/**
 * `FileWorktree.gitlinkHeadState` of a nested reftable repository (statewalker/webrun-vcs#459):
 * its `.git/HEAD` is git's stub `ref: refs/heads/.invalid`, never read for HEAD. The native
 * twins are vcs-commands' `tests/reftable-submodule-native.test.ts`; these cover what native
 * git cannot build.
 */
import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";
import { createGitFilesBackend, FileWorktree } from "../../../src/index.js";

const text = (s: string) => [new TextEncoder().encode(s)];

async function superprojectWithSub(subConfig: string) {
  const files = createInMemoryFilesApi();
  const { history } = await createGitFilesBackend({ files, gitDir: "/super/.git", create: true });
  await files.write("/super/sub/.git/HEAD", text("ref: refs/heads/.invalid\n"));
  await files.write("/super/sub/.git/refs/heads", text(""));
  await files.mkdir("/super/sub/.git/objects");
  await files.write("/super/sub/.git/config", text(subConfig));
  return new FileWorktree({
    files,
    rootPath: "/super",
    gitDir: "/super/.git",
    blobs: history.blobs,
    trees: history.trees,
  });
}

describe("gitlinkHeadState of a reftable repository", () => {
  it("reads HEAD from the stack, never the stub: an empty stack has no commit", async () => {
    const worktree = await superprojectWithSub(
      "[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefStorage = reftable\n",
    );
    expect(await worktree.gitlinkHeadState("sub")).toEqual({ state: "none" });
  });

  it("is unknown, not 'no commit', when the format is refused", async () => {
    // an extension we do not support (git master's objectStorage payload): the stub must not
    // be followed as a files repository's HEAD
    const worktree = await superprojectWithSub(
      "[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefStorage = reftable\n" +
        "\tobjectStorage = files://elsewhere\n",
    );
    expect(await worktree.gitlinkHeadState("sub")).toEqual({ state: "unknown" });
    expect(await worktree.readGitlinkHead("sub")).toBeUndefined();
  });
});
