import {
  createInMemoryFilesApi,
  createRefsAdapter,
  type FilesApi,
  type ObjectId,
} from "@statewalker/vcs-core";
import { createRefBatchTests } from "@statewalker/vcs-testing";
import { describe, expect, it } from "vitest";
import { createRefsStructure, FileRefStore, packRefs } from "../../src/refs/index.js";

async function gitFilesRefs(): Promise<{
  files: FilesApi;
  refs: ReturnType<typeof createRefsAdapter>;
}> {
  const files = createInMemoryFilesApi();
  await files.mkdir("/.git");
  await createRefsStructure(files, "/.git");
  return { files, refs: createRefsAdapter(new FileRefStore(files, "/.git")) };
}

createRefBatchTests("Git files", async () => ({ refs: (await gitFilesRefs()).refs }));

describe("Refs.batch on packed refs [Git files]", () => {
  const oid = (n: number): ObjectId => n.toString(16).padStart(40, "a");

  it("updates and deletes a ref that exists only in packed-refs", async () => {
    const { files, refs } = await gitFilesRefs();
    await refs.batch([{ name: "refs/heads/p", new: oid(1) }]);
    await refs.batch([{ name: "refs/heads/q", new: oid(2) }]);
    await packRefs(files, "/.git", ["refs/heads/p", "refs/heads/q"], true);
    expect(await files.stats("/.git/refs/heads/p")).toBeUndefined();

    expect(await refs.batch([{ name: "refs/heads/p", old: oid(1), new: oid(3) }])).toEqual({
      ok: true,
      rejected: [],
    });
    expect((await refs.resolve("refs/heads/p"))?.objectId).toBe(oid(3));

    expect(await refs.batch([{ name: "refs/heads/q", old: oid(2), new: null }])).toEqual({
      ok: true,
      rejected: [],
    });
    expect(await refs.has("refs/heads/q")).toBe(false);
  });
});
