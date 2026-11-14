import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitObjectStore,
  MemoryRawStorage,
  MemoryRefs,
  type Refs,
} from "@statewalker/vcs-core";
import { createRefsStructure, FileRefStore } from "@statewalker/vcs-store-files";
import { createNodeAtomicFiles, createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createCoreRepositoryAccess } from "../src/index.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const backends: Array<[string, () => Promise<Refs>]> = [
  ["MemoryRefs", async () => new MemoryRefs()],
  [
    "FileRefStore",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "core-access-"));
      roots.push(dir);
      const files = createNodeFilesApi({ rootDir: dir });
      await files.mkdir(".git");
      await createRefsStructure(files, ".git");
      return new FileRefStore(files, ".git", {
        atomicFiles: createNodeAtomicFiles(join(dir, ".git")),
      });
    },
  ],
];

describe.each(backends)("createCoreRepositoryAccess.updateRef [%s]", (_name, makeRefs) => {
  async function setup() {
    const refs = await makeRefs();
    const access = createCoreRepositoryAccess({
      objectStore: createGitObjectStore(new MemoryRawStorage()),
      refStore: refs,
    });
    return { refs, access };
  }

  it("creates only when the ref does not exist (old id null)", async () => {
    const { refs, access } = await setup();
    expect(await access.updateRef("refs/heads/x", null, A)).toBe(true);
    expect(await access.updateRef("refs/heads/x", null, B)).toBe(false);
    expect((await refs.resolve("refs/heads/x"))?.objectId).toBe(A);
  });

  it("updates only from the expected old id", async () => {
    const { refs, access } = await setup();
    await refs.set("refs/heads/x", A);
    expect(await access.updateRef("refs/heads/x", C, B)).toBe(false);
    expect(await access.updateRef("refs/heads/x", A, B)).toBe(true);
    expect((await refs.resolve("refs/heads/x"))?.objectId).toBe(B);
  });

  it("deletes with or without an old id; a stale old id or a missing ref gives false", async () => {
    const { refs, access } = await setup();
    await refs.set("refs/heads/x", A);
    await refs.set("refs/heads/y", A);
    expect(await access.updateRef("refs/heads/x", C, null)).toBe(false);
    expect(await access.updateRef("refs/heads/x", A, null)).toBe(true);
    expect(await access.updateRef("refs/heads/y", null, null)).toBe(true);
    expect(await access.updateRef("refs/heads/missing", null, null)).toBe(false);
    expect(await refs.has("refs/heads/x")).toBe(false);
    expect(await refs.has("refs/heads/y")).toBe(false);
  });

  it("deletes a symbolic ref itself, keeping its target", async () => {
    const { refs, access } = await setup();
    await refs.set("refs/remotes/origin/main", A);
    await refs.setSymbolic("refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect(await access.updateRef("refs/remotes/origin/HEAD", null, null)).toBe(true);
    expect(await refs.has("refs/remotes/origin/HEAD")).toBe(false);
    expect((await refs.resolve("refs/remotes/origin/main"))?.objectId).toBe(A);
  });

  it("refuses names outside refs/ and HEAD", async () => {
    const { access } = await setup();
    expect(await access.updateRef("ORIG_HEAD", null, A)).toBe(false);
  });
});
