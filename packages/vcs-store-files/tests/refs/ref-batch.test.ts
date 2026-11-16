import { createInMemoryFilesApi, type FilesApi, type ObjectId } from "@statewalker/vcs-core";
import { createRefBatchTests } from "@statewalker/vcs-testing";
import { type AtomicFiles, atomicFilesOver } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import {
  createFilesRefOps,
  createRefsStructure,
  FileRefStore,
  packRefs,
} from "../../src/refs/index.js";

async function gitFilesRefs(): Promise<{
  files: FilesApi;
  refs: FileRefStore;
}> {
  const files = createInMemoryFilesApi();
  await files.mkdir("/.git");
  await createRefsStructure(files, "/.git");
  return { files, refs: new FileRefStore(files, "/.git") };
}

createRefBatchTests("Git files", async () => ({ refs: (await gitFilesRefs()).refs }), {
  reflog: true,
});

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

describe("ref batches over files whose read throws for a missing file", () => {
  const oid = (n: number): ObjectId => n.toString(16).padStart(40, "a");

  /** `files`, its `read` throwing (as a Node or browser FilesApi may) where nothing is stored. */
  function throwingOnMissing(files: AtomicFiles): AtomicFiles {
    return new Proxy(files, {
      get(target, prop, receiver) {
        if (prop === "read") {
          return (path: string) =>
            (async function* () {
              if (!(await target.exists(path))) throw new Error(`ENOENT: ${path}`);
              yield* target.read(path);
            })();
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("reads a missing loose ref and a missing packed-refs as absent", async () => {
    const { files } = await gitFilesRefs();
    const ops = createFilesRefOps(throwingOnMissing(atomicFilesOver(files, "/.git")));
    let packed: string | undefined | null = null;
    await ops.updatePackedRefs((text) => {
      packed = text;
      return undefined;
    });
    expect(packed).toBeUndefined();
    expect(await ops.batch([{ name: "refs/heads/p", new: oid(1) }])).toEqual({
      ok: true,
      rejected: [],
    });
    expect(await ops.batch([{ name: "refs/heads/p", old: oid(1), new: oid(2) }])).toEqual({
      ok: true,
      rejected: [],
    });
    expect(await ops.batch([{ name: "refs/heads/p", old: oid(2), new: null }])).toEqual({
      ok: true,
      rejected: [],
    });
    expect(await files.stats("/.git/refs/heads/p")).toBeUndefined();
  });
});
