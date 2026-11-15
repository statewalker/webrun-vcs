/**
 * The resolution store reads and writes worktree files through a link-aware worktree: a
 * conflict path that is a symbolic link is staged as the link (its target as content,
 * never the file it names), and accepting a side replaces the link rather than writing
 * into its target.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryHistory } from "@statewalker/vcs-core";
import { GitResolutionStore } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { createMemoryGitStaging, MergeStage } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const enc = new TextEncoder();

describe("GitResolutionStore and symbolic links", () => {
  let base: string;
  let repo: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "resolution-links-"));
    repo = join(base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(base, "secret.txt"), "SECRET, never staged\n");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  async function conflicted(path: string) {
    const { blobs } = createMemoryHistory();
    const staging = createMemoryGitStaging();
    const ours = await blobs.store([enc.encode("ours\n")]);
    const theirs = await blobs.store([enc.encode("theirs\n")]);
    await staging.setEntry({ path, objectId: ours, mode: 0o100644, stage: MergeStage.OURS });
    await staging.setEntry({ path, objectId: theirs, mode: 0o100644, stage: MergeStage.THEIRS });
    const store = new GitResolutionStore(
      createNodeFilesApi({ rootDir: repo }),
      staging,
      blobs,
      "/.git",
      "/",
    );
    return { store, staging, blobs };
  }

  it("markAllResolved stages a link as a link, never its target's content", async () => {
    const { store, staging, blobs } = await conflicted("x");
    symlinkSync("../secret.txt", join(repo, "x"));
    await store.markAllResolved();
    const entry = await staging.getEntry("x");
    expect(entry?.mode).toBe(0o120000);
    const chunks: Uint8Array[] = [];
    for await (const chunk of (await blobs.load(entry?.objectId ?? "")) ?? []) chunks.push(chunk);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("../secret.txt");
  });

  it("acceptOurs replaces a link instead of writing through it", async () => {
    const { store } = await conflicted("x");
    symlinkSync("../secret.txt", join(repo, "x"));
    await store.acceptOurs("x");
    expect(readFileSync(join(base, "secret.txt"), "utf8")).toBe("SECRET, never staged\n");
    expect(readFileSync(join(repo, "x"), "utf8")).toBe("ours\n");
  });

  it("acceptTheirs refuses a path beneath a link", async () => {
    const { store } = await conflicted("d/x");
    mkdirSync(join(base, "outdir"));
    symlinkSync("../outdir", join(repo, "d"));
    await expect(store.acceptTheirs("d/x")).rejects.toThrow(/symbolic link/);
  });
});
