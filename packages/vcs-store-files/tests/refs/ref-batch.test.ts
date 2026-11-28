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

describe("initial ref batches (git clone's write_remote_refs) [Git files]", () => {
  const oid = (n: number): ObjectId => n.toString(16).padStart(40, "a");
  const dec = new TextDecoder();
  const text = async (files: FilesApi, path: string) => {
    let out = "";
    for await (const chunk of files.read(path)) out += dec.decode(chunk, { stream: true });
    return out;
  };

  it("writes the refs into packed-refs only, under git's header, unlogged", async () => {
    const { files, refs } = await gitFilesRefs();
    const result = await refs.batch(
      [
        { name: "refs/remotes/origin/main", old: null, new: oid(2) },
        { name: "refs/remotes/origin/a", new: oid(1) },
      ],
      { initial: true, message: "clone: from x" },
    );
    expect(result).toEqual({ ok: true, rejected: [] });
    expect(await files.stats("/.git/refs/remotes/origin/main")).toBeUndefined();
    expect(await files.stats("/.git/logs/refs/remotes/origin/main")).toBeUndefined();
    expect(await text(files, "/.git/packed-refs")).toBe(
      `# pack-refs with: peeled sorted \n${oid(1)} refs/remotes/origin/a\n${oid(2)} refs/remotes/origin/main\n`,
    );
    expect((await refs.resolve("refs/remotes/origin/main"))?.objectId).toBe(oid(2));
  });

  it("refuses an existing ref, a deletion or a name outside refs/, writing nothing", async () => {
    const { files, refs } = await gitFilesRefs();
    await refs.batch([{ name: "refs/heads/x", new: oid(1) }]);
    expect(
      await refs.batch(
        [
          { name: "refs/heads/x", new: oid(2) },
          { name: "refs/heads/y", new: oid(2) },
        ],
        { initial: true },
      ),
    ).toEqual({ ok: false, rejected: [{ name: "refs/heads/x", reason: "mismatch" }] });
    expect(await refs.batch([{ name: "refs/heads/x", new: null }], { initial: true })).toEqual({
      ok: false,
      rejected: [{ name: "refs/heads/x", reason: "invalid-command" }],
    });
    expect(await refs.batch([{ name: "ORIG_HEAD", new: oid(3) }], { initial: true })).toMatchObject(
      {
        ok: false,
      },
    );
    expect(await files.stats("/.git/packed-refs")).toBeUndefined();
    expect(await files.stats("/.git/ORIG_HEAD")).toBeUndefined();
  });

  it("tells the hook prepared (both versions), the packed store's phases (2.5x), committed (2.43)", async () => {
    const { refs } = await gitFilesRefs();
    const calls: string[] = [];
    refs.setTransactionHook(async (state, updates, context) => {
      calls.push(
        `${state}${context?.packed ? " packed" : ""}${context?.only ? ` ${context.only}` : ""}: ${updates.map((u) => u.name).join(",")}`,
      );
      return true;
    });
    await refs.batch([{ name: "refs/tags/t", new: oid(1) }], { initial: true });
    expect(calls).toEqual([
      "preparing: refs/tags/t",
      "prepared: refs/tags/t",
      "preparing packed 2.56: refs/tags/t",
      "prepared packed 2.56: refs/tags/t",
      "committed 2.43: refs/tags/t",
    ]);
  });
});

describe("loose ref batches (git's files_transaction_finish) [Git files]", () => {
  const oid = (n: number): ObjectId => n.toString(16).padStart(40, "a");
  const text = async (files: FilesApi, path: string) => {
    if ((await files.stats(path))?.kind !== "file") return undefined;
    const chunks: Uint8Array[] = [];
    for await (const c of files.read(path)) chunks.push(c);
    return new TextDecoder().decode(Buffer.concat(chunks));
  };

  /** p, q and gone packed; `loose`'s batch then updates p, creates r and deletes gone. */
  async function packedThree() {
    const { files, refs } = await gitFilesRefs();
    for (const [name, n] of [
      ["refs/heads/p", 1],
      ["refs/heads/q", 2],
      ["refs/heads/gone", 3],
    ] as const) {
      await refs.batch([{ name, new: oid(n) }]);
    }
    await packRefs(files, "/.git", ["refs/heads/p", "refs/heads/q", "refs/heads/gone"], true);
    return { files, refs };
  }

  // statewalker/webrun-vcs#284: git fetch --atomic --prune
  it("writes the updates loose and drops the deletions from packed-refs", async () => {
    const { files, refs } = await packedThree();
    const result = await refs.batch(
      [
        { name: "refs/heads/gone", old: oid(3), new: null },
        { name: "refs/heads/p", old: oid(1), new: oid(4) },
        { name: "refs/heads/r", old: null, new: oid(5) },
      ],
      { loose: true },
    );
    expect(result).toEqual({ ok: true, rejected: [] });
    expect(await text(files, "/.git/refs/heads/p")).toBe(`${oid(4)}\n`);
    expect(await text(files, "/.git/refs/heads/r")).toBe(`${oid(5)}\n`);
    const packed = await text(files, "/.git/packed-refs");
    expect(packed).toContain(`${oid(1)} refs/heads/p\n`); // shadowed by the loose file, as git leaves it
    expect(packed).toContain(`${oid(2)} refs/heads/q\n`);
    expect(packed).not.toContain("refs/heads/gone");
    expect(await refs.has("refs/heads/gone")).toBe(false);
    expect((await refs.resolve("refs/heads/p"))?.objectId).toBe(oid(4));
    expect(await files.stats("/.git/packed-refs.lock")).toBeUndefined();
  });

  it("changes nothing when one update is refused", async () => {
    const { files, refs } = await packedThree();
    const before = await text(files, "/.git/packed-refs");
    const result = await refs.batch(
      [
        { name: "refs/heads/gone", old: oid(3), new: null },
        { name: "refs/heads/p", old: oid(1), new: oid(4) },
        { name: "refs/heads/q", old: oid(9), new: oid(6) },
      ],
      { loose: true },
    );
    expect(result.ok).toBe(false);
    expect(await text(files, "/.git/packed-refs")).toBe(before);
    expect(await files.stats("/.git/refs/heads/p")).toBeUndefined();
    expect(await refs.has("refs/heads/gone")).toBe(true);
  });
});

// statewalker/webrun-vcs#500: git fetch --atomic with a refused update
describe("aborted transactions (git's ref_transaction_abort of an open one) [Git files]", () => {
  const oid = (n: number): ObjectId => n.toString(16).padStart(40, "a");

  it("tells the hook aborted alone, with the commands as given, and writes nothing", async () => {
    const { files, refs } = await gitFilesRefs();
    await refs.batch([{ name: "refs/heads/p", new: oid(1) }]);
    const heard: string[] = [];
    refs.setTransactionHook(async (state, updates) => {
      heard.push(`${state}: ${updates.map((u) => `${u.old} ${u.new} ${u.name}`).join(",")}`);
      return true;
    });
    const result = await refs.batch(
      [
        { name: "refs/heads/p", old: oid(1), new: oid(2) },
        { name: "refs/heads/r", old: null, new: oid(3) },
      ],
      { abortTransaction: true },
    );
    expect(result).toEqual({ ok: false, rejected: [] });
    expect(heard).toEqual([
      `aborted: ${oid(1)} ${oid(2)} refs/heads/p,null ${oid(3)} refs/heads/r`,
    ]);
    expect((await refs.resolve("refs/heads/p"))?.objectId).toBe(oid(1));
    expect(await files.stats("/.git/refs/heads/r")).toBeUndefined();
    heard.length = 0;
    await refs.batch([], { abortTransaction: true });
    expect(heard).toEqual(["aborted: "]);
  });
});
