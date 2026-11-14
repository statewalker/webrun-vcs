/**
 * Every rewrite of packed-refs takes packed-refs.lock, as git does: a held lock
 * makes it wait and then fail without a change, a concurrent ref batch is never
 * lost, and pack-refs keeps a loose ref updated between packing and pruning.
 */
import { createInMemoryFilesApi, type FilesApi, type ObjectId } from "@statewalker/vcs-core";
import { readText } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import {
  addPackedRef,
  createRefsStructure,
  FileRefStore,
  packRefs,
  removePackedRef,
  writePackedRefs,
} from "../../src/refs/index.js";

const oid = (n: number): ObjectId => n.toString(16).padStart(40, "a");
const PACKED = "/.git/packed-refs";
const LOCK = "/.git/packed-refs.lock";

async function repo(): Promise<FilesApi> {
  const files = createInMemoryFilesApi();
  await files.mkdir("/.git");
  await createRefsStructure(files, "/.git");
  return files;
}

const text = async (files: FilesApi, path: string) =>
  (await files.exists(path)) ? readText(files, path) : undefined;

function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((r) => {
    open = r;
  });
  let reached: () => void = () => {};
  const hit = new Promise<void>((r) => {
    reached = r;
  });
  return { open, opened, hit, reached };
}

/**
 * A view of `base` that pauses once: after `read` of `readPath` has read the file, or right after a
 * `write`/`move` lands on `afterWrite`. Other calls go straight through.
 */
function gated(
  base: FilesApi,
  g: ReturnType<typeof gate>,
  on: { readPath?: string; afterWrite?: string },
): FilesApi {
  let armed = true;
  const pause = async () => {
    if (!armed) return;
    armed = false;
    g.reached();
    await g.opened;
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "read") {
        return async function* (path: string, ...rest: unknown[]) {
          // the content is read first: the pause comes after the reader has its copy
          const chunks: Uint8Array[] = [];
          // biome-ignore lint/suspicious/noExplicitAny: forwarding the FilesApi call
          for await (const c of (target.read as any).call(target, path, ...rest)) chunks.push(c);
          if (path === on.readPath) await pause();
          yield* chunks;
        };
      }
      if (prop === "write") {
        return async (path: string, ...rest: unknown[]) => {
          // biome-ignore lint/suspicious/noExplicitAny: forwarding the FilesApi call
          const r = await (target.write as any).call(target, path, ...rest);
          if (path === on.afterWrite) await pause();
          return r;
        };
      }
      if (prop === "move") {
        return async (source: string, dest: string) => {
          const r = await target.move(source, dest);
          if (dest === on.afterWrite) await pause();
          return r;
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

describe("packed-refs rewrites take packed-refs.lock", () => {
  it("packRefs waits for a held packed-refs.lock, then fails without changing anything", async () => {
    const files = await repo();
    const refs = new FileRefStore(files, "/.git", { packedLockTimeoutMs: 80 });
    await refs.batch([{ name: "refs/heads/a", new: oid(1) }]);
    await refs.batch([
      { name: "refs/heads/b", new: oid(2) },
      { name: "refs/heads/c", new: oid(3) },
    ]);
    const before = await text(files, PACKED);
    await files.write(LOCK, [new TextEncoder().encode("someone else")]);

    const started = Date.now();
    await expect(refs.packRefs([], { all: true })).rejects.toThrow(/packed-refs\.lock/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(await text(files, PACKED)).toBe(before);
    expect(await text(files, "/.git/refs/heads/a")).toBe(`${oid(1)}\n`);
    expect(await text(files, LOCK)).toBe("someone else"); // not ours to remove
  });

  it("packRefs proceeds once the holder releases packed-refs.lock within the timeout", async () => {
    const files = await repo();
    const refs = new FileRefStore(files, "/.git", { packedLockTimeoutMs: 1000 });
    await refs.batch([{ name: "refs/heads/a", new: oid(1) }]);
    await files.write(LOCK, [new Uint8Array(0)]);
    setTimeout(() => void files.remove(LOCK), 50);
    await refs.packRefs([], { all: true });
    expect(await files.exists("/.git/refs/heads/a")).toBe(false);
    expect(await text(files, PACKED)).toContain(`${oid(1)} refs/heads/a`);
    expect(await files.exists(LOCK)).toBe(false);
  });

  it("writePackedRefs, addPackedRef, removePackedRef and packRefs refuse a held lock", async () => {
    const files = await repo();
    await writePackedRefs(files, "/.git", [{ name: "refs/heads/p", objectId: oid(1) } as never]);
    const before = await text(files, PACKED);
    await files.write("/.git/refs/heads/l", [new TextEncoder().encode(`${oid(5)}\n`)]);
    await files.write(LOCK, [new Uint8Array(0)]);
    const o = { packedLockTimeoutMs: 30 };
    await expect(
      writePackedRefs(
        files,
        "/.git",
        [{ name: "refs/heads/q", objectId: oid(2) } as never],
        true,
        o,
      ),
    ).rejects.toThrow(/packed-refs\.lock/);
    await expect(
      addPackedRef(files, "/.git", { name: "refs/heads/q", objectId: oid(2) } as never, o),
    ).rejects.toThrow(/packed-refs\.lock/);
    await expect(removePackedRef(files, "/.git", "refs/heads/p", o)).rejects.toThrow(
      /packed-refs\.lock/,
    );
    await expect(packRefs(files, "/.git", ["refs/heads/l"], true, o)).rejects.toThrow(
      /packed-refs\.lock/,
    );
    expect(await text(files, PACKED)).toBe(before);
    expect(await files.exists("/.git/refs/heads/l")).toBe(true);
    expect(await files.exists(LOCK)).toBe(true);
  });

  it("writePackedRefs, addPackedRef and removePackedRef leave no lock behind", async () => {
    const files = await repo();
    await writePackedRefs(files, "/.git", [{ name: "refs/heads/p", objectId: oid(1) } as never]);
    await addPackedRef(files, "/.git", { name: "refs/heads/q", objectId: oid(2) } as never);
    expect(await removePackedRef(files, "/.git", "refs/heads/p")).toBe(true);
    expect(await removePackedRef(files, "/.git", "refs/heads/missing")).toBe(false);
    expect(await text(files, PACKED)).toContain(`${oid(2)} refs/heads/q`);
    expect(await text(files, PACKED)).not.toContain("refs/heads/p");
    expect(await removePackedRef(files, "/.git", "refs/heads/q")).toBe(true);
    expect(await files.exists(PACKED)).toBe(false);
    expect(await files.exists(LOCK)).toBe(false);
  });

  it("a multi-ref batch that runs while packRefs is mid-rewrite is not lost", async () => {
    const base = await repo();
    const writer = new FileRefStore(base, "/.git");
    await writer.batch([
      { name: "refs/heads/b", new: oid(2) },
      { name: "refs/heads/c", new: oid(3) },
    ]);
    await writer.batch([{ name: "refs/heads/a", new: oid(1) }]);
    const g = gate();
    const packer = gated(base, g, { readPath: PACKED });

    const pack = packRefs(packer, "/.git", ["refs/heads/a"], true);
    await g.hit; // packRefs has read packed-refs
    const batch = writer.batch([
      { name: "refs/heads/x", old: null, new: oid(7) },
      { name: "refs/heads/y", old: null, new: oid(8) },
    ]);
    await new Promise((r) => setTimeout(r, 30));
    g.open();
    await pack;
    expect(await batch).toEqual({ ok: true, rejected: [] });

    expect((await writer.resolve("refs/heads/a"))?.objectId).toBe(oid(1));
    expect((await writer.resolve("refs/heads/x"))?.objectId).toBe(oid(7));
    expect((await writer.resolve("refs/heads/y"))?.objectId).toBe(oid(8));
    expect((await writer.resolve("refs/heads/b"))?.objectId).toBe(oid(2));
    expect(await base.exists("/.git/refs/heads/a")).toBe(false);
    expect(await base.exists(LOCK)).toBe(false);
  });

  it("a packed ref deleted while packRefs is mid-rewrite stays deleted", async () => {
    const base = await repo();
    const writer = new FileRefStore(base, "/.git");
    await writer.batch([
      { name: "refs/heads/p", new: oid(1) },
      { name: "refs/heads/q", new: oid(2) },
    ]);
    await writer.batch([{ name: "refs/heads/a", new: oid(3) }]);
    const g = gate();
    const packer = gated(base, g, { readPath: PACKED });

    const pack = packRefs(packer, "/.git", ["refs/heads/a"], true);
    await g.hit; // packRefs is reading packed-refs
    const del = writer.batch([{ name: "refs/heads/p", old: oid(1), new: null }]);
    await new Promise((r) => setTimeout(r, 30));
    g.open();
    await pack;
    expect(await del).toEqual({ ok: true, rejected: [] });

    expect(await writer.has("refs/heads/p")).toBe(false);
    expect((await writer.resolve("refs/heads/q"))?.objectId).toBe(oid(2));
    expect((await writer.resolve("refs/heads/a"))?.objectId).toBe(oid(3));
  });

  it("a loose ref updated between packing and pruning stays loose with its new value", async () => {
    const base = await repo();
    const writer = new FileRefStore(base, "/.git");
    await writer.batch([{ name: "refs/heads/a", new: oid(1) }]);
    await writer.batch([{ name: "refs/heads/b", new: oid(2) }]);
    const g = gate();
    const packer = new FileRefStore(gated(base, g, { afterWrite: PACKED }), "/.git");

    const pack = packer.packRefs([], { all: true });
    await g.hit; // packed-refs is written, nothing pruned yet
    expect(await writer.batch([{ name: "refs/heads/a", old: oid(1), new: oid(9) }])).toEqual({
      ok: true,
      rejected: [],
    });
    g.open();
    await pack;

    expect(await text(base, "/.git/refs/heads/a")).toBe(`${oid(9)}\n`);
    expect((await writer.resolve("refs/heads/a"))?.objectId).toBe(oid(9));
    // the untouched ref was pruned as usual
    expect(await base.exists("/.git/refs/heads/b")).toBe(false);
    expect((await writer.resolve("refs/heads/b"))?.objectId).toBe(oid(2));
    expect(await base.exists("/.git/refs/heads/a.lock")).toBe(false);
  });
});

describe("deletes take packed-refs.lock even for a ref that is not packed", () => {
  it("a loose-only ref deleted while packRefs is between reading it and writing packed-refs stays deleted", async () => {
    const base = await repo();
    const writer = new FileRefStore(base, "/.git");
    await writer.batch([{ name: "refs/heads/x", new: oid(1) }]);
    await writer.batch([
      { name: "refs/heads/p", new: oid(2) },
      { name: "refs/heads/q", new: oid(3) },
    ]);
    const g = gate();
    const packer = gated(base, g, { readPath: "/.git/refs/heads/x" });

    const pack = packRefs(packer, "/.git", ["refs/heads/x"], true);
    await g.hit; // packRefs holds packed-refs.lock and has read loose x, packed-refs not written
    const del = writer.batch([{ name: "refs/heads/x", old: oid(1), new: null }]);
    await new Promise((r) => setTimeout(r, 30));
    g.open();
    await pack;
    expect(await del).toEqual({ ok: true, rejected: [] });

    expect(await writer.has("refs/heads/x")).toBe(false);
    expect(await text(base, PACKED)).not.toContain("refs/heads/x");
    expect((await writer.resolve("refs/heads/p"))?.objectId).toBe(oid(2));
    expect(await base.exists("/.git/refs/heads/x")).toBe(false);
    expect(await base.exists(LOCK)).toBe(false);
  });

  it("deleting a loose-only ref waits for a briefly held packed-refs.lock", async () => {
    const files = await repo();
    const refs = new FileRefStore(files, "/.git", { packedLockTimeoutMs: 1000 });
    await refs.batch([{ name: "refs/heads/x", new: oid(1) }]);
    await files.write(LOCK, [new Uint8Array(0)]);
    setTimeout(() => void files.remove(LOCK), 50);
    expect(await refs.batch([{ name: "refs/heads/x", old: oid(1), new: null }])).toEqual({
      ok: true,
      rejected: [],
    });
    expect(await refs.has("refs/heads/x")).toBe(false);
    expect(await files.exists(LOCK)).toBe(false);
  });

  it("deleting a loose-only ref fails without a change while packed-refs.lock stays held", async () => {
    const files = await repo();
    const refs = new FileRefStore(files, "/.git", { packedLockTimeoutMs: 30 });
    await refs.batch([{ name: "refs/heads/x", new: oid(1) }]);
    await files.write(LOCK, [new Uint8Array(0)]);
    expect(await refs.batch([{ name: "refs/heads/x", old: oid(1), new: null }])).toEqual({
      ok: false,
      rejected: [{ name: "packed-refs", reason: "locked" }],
    });
    expect((await refs.resolve("refs/heads/x"))?.objectId).toBe(oid(1));
    expect(await files.exists("/.git/refs/heads/x.lock")).toBe(false);
    expect(await files.exists(LOCK)).toBe(true);
  });
});

describe("FileRefStore.remove rewrites packed-refs before the loose file", () => {
  it("leaves the ref untouched when packed-refs.lock stays held", async () => {
    const files = await repo();
    const refs = new FileRefStore(files, "/.git", { packedLockTimeoutMs: 30 });
    await refs.batch([
      { name: "refs/heads/p", new: oid(1) },
      { name: "refs/heads/q", new: oid(2) },
    ]);
    await refs.batch([{ name: "refs/heads/p", old: oid(1), new: oid(5) }]); // loose over packed
    const before = await text(files, PACKED);
    await files.write(LOCK, [new Uint8Array(0)]);

    await expect(refs.remove("refs/heads/p")).rejects.toThrow(/packed-refs\.lock/);
    expect(await text(files, "/.git/refs/heads/p")).toBe(`${oid(5)}\n`);
    expect((await refs.resolve("refs/heads/p"))?.objectId).toBe(oid(5));
    expect(await text(files, PACKED)).toBe(before);
  });

  it("removes a ref that is both loose and packed", async () => {
    const files = await repo();
    const refs = new FileRefStore(files, "/.git");
    await refs.batch([
      { name: "refs/heads/p", new: oid(1) },
      { name: "refs/heads/q", new: oid(2) },
    ]);
    await refs.batch([{ name: "refs/heads/p", old: oid(1), new: oid(5) }]);
    expect(await refs.remove("refs/heads/p")).toBe(true);
    expect(await refs.has("refs/heads/p")).toBe(false);
    expect((await refs.resolve("refs/heads/q"))?.objectId).toBe(oid(2));
    expect(await refs.remove("refs/heads/p")).toBe(false);
  });
});

describe("packed-refs rewrites keep peel lines under a sorted-only header", () => {
  const TAG = "refs/tags/v1";
  const seed = async () => {
    const files = await repo();
    // as packRefs and ref batches write it: "sorted" only, with a peel line kept
    await files.write(PACKED, [
      new TextEncoder().encode(
        `# pack-refs with: sorted \n${oid(1)} refs/heads/a\n${oid(2)} refs/heads/b\n${oid(3)} ${TAG}\n^${oid(4)}\n`,
      ),
    ]);
    return files;
  };

  it("removePackedRef keeps the peel line", async () => {
    const files = await seed();
    expect(await removePackedRef(files, "/.git", "refs/heads/a")).toBe(true);
    expect(await text(files, PACKED)).toContain(`${oid(3)} ${TAG}\n^${oid(4)}\n`);
  });

  it("addPackedRef keeps the peel line", async () => {
    const files = await seed();
    await addPackedRef(files, "/.git", { name: "refs/heads/c", objectId: oid(5) } as never);
    expect(await text(files, PACKED)).toContain(`${oid(3)} ${TAG}\n^${oid(4)}\n`);
  });

  it("FileRefStore.remove keeps the peel line", async () => {
    const files = await seed();
    const refs = new FileRefStore(files, "/.git");
    expect(await refs.remove("refs/heads/a")).toBe(true);
    expect(await text(files, PACKED)).toContain(`${oid(3)} ${TAG}\n^${oid(4)}\n`);
  });

  it("a remove after packRefs keeps the peel line", async () => {
    const files = await repo();
    await files.write(PACKED, [
      new TextEncoder().encode(
        `# pack-refs with: peeled fully-peeled sorted \n${oid(3)} ${TAG}\n^${oid(4)}\n`,
      ),
    ]);
    const refs = new FileRefStore(files, "/.git");
    await refs.batch([{ name: "refs/heads/a", new: oid(1) }]);
    await refs.batch([{ name: "refs/heads/b", new: oid(2) }]);
    await refs.packRefs([], { all: true });
    await refs.remove("refs/heads/a");
    expect(await text(files, PACKED)).toContain(`${oid(3)} ${TAG}\n^${oid(4)}\n`);
    expect((await refs.get(TAG)) as { peeledObjectId?: string }).toMatchObject({
      peeledObjectId: oid(4),
    });
  });
});

/** Counts the packed-refs.lock files `base` creates, and runs `onRemove` before each remove. */
function watched(
  base: FilesApi,
  hooks: {
    onLock?: () => void;
    onRemove?: (path: string) => Promise<void>;
    afterMove?: (source: string, dest: string) => Promise<void>;
  },
): FilesApi {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "createExclusive" && target.createExclusive) {
        return async (path: string, ...rest: unknown[]) => {
          // biome-ignore lint/suspicious/noExplicitAny: forwarding the FilesApi call
          const r = await (target.createExclusive as any).call(target, path, ...rest);
          if (r && path === LOCK) hooks.onLock?.();
          return r;
        };
      }
      if (prop === "write") {
        return async (path: string, ...rest: unknown[]) => {
          if (path === LOCK && !(await target.exists(path))) hooks.onLock?.();
          // biome-ignore lint/suspicious/noExplicitAny: forwarding the FilesApi call
          return (target.write as any).call(target, path, ...rest);
        };
      }
      if (prop === "remove") {
        return async (path: string) => {
          await hooks.onRemove?.(path);
          return target.remove(path);
        };
      }
      if (prop === "move") {
        return async (source: string, dest: string) => {
          const r = await target.move(source, dest);
          await hooks.afterMove?.(source, dest);
          return r;
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

describe("a packed-refs commit keeps packed-refs.lock until the caller is done", () => {
  it("a delete that races packRefs takes packed-refs.lock once and removes the loose file under it", async () => {
    const base = await repo();
    const writer = new FileRefStore(base, "/.git");
    await writer.batch([{ name: "refs/heads/x", new: oid(1) }]);
    await writer.batch([
      { name: "refs/heads/p", new: oid(2) },
      { name: "refs/heads/q", new: oid(3) },
    ]);
    let locks = 0;
    let lockHeldAtLooseRemoval: boolean | undefined;
    const deleter = new FileRefStore(
      watched(base, {
        onLock: () => locks++,
        onRemove: async (path) => {
          if (path === "/.git/refs/heads/x") lockHeldAtLooseRemoval = await base.exists(LOCK);
        },
      }),
      "/.git",
    );
    const g = gate();
    const packer = gated(base, g, { readPath: "/.git/refs/heads/x" });

    const pack = packRefs(packer, "/.git", ["refs/heads/x"], false);
    await g.hit; // packRefs holds packed-refs.lock and is about to pack x
    const del = deleter.batch([{ name: "refs/heads/x", old: oid(1), new: null }]);
    await new Promise((r) => setTimeout(r, 30));
    g.open();
    await pack;
    expect(await del).toEqual({ ok: true, rejected: [] });

    expect(locks).toBe(1); // one pass: no re-take after the packed-refs rewrite
    expect(lockHeldAtLooseRemoval).toBe(true);
    expect(await writer.has("refs/heads/x")).toBe(false);
    expect(await text(base, PACKED)).not.toContain("refs/heads/x");
    expect(await base.exists(LOCK)).toBe(false);
  });

  it("renames a complete temporary over packed-refs while packed-refs.lock is still held", async () => {
    const base = await repo();
    const writer = new FileRefStore(base, "/.git");
    await writer.batch([
      { name: "refs/heads/p", new: oid(1) },
      { name: "refs/heads/q", new: oid(2) },
    ]);
    const renames: { source: string; lockHeld: boolean; content?: string }[] = [];
    const refs = new FileRefStore(
      watched(base, {
        afterMove: async (source, dest) => {
          if (dest === PACKED) {
            renames.push({
              source,
              lockHeld: await base.exists(LOCK),
              content: await text(base, PACKED),
            });
          }
        },
      }),
      "/.git",
    );
    expect(await refs.batch([{ name: "refs/heads/p", old: oid(1), new: null }])).toEqual({
      ok: true,
      rejected: [],
    });
    await refs.remove("refs/heads/q");
    expect(renames.length).toBeGreaterThan(0);
    for (const r of renames) {
      expect(r.source).toBe("/.git/packed-refs.new");
      expect(r.lockHeld).toBe(true);
      expect(r.content?.startsWith("# pack-refs with:")).toBe(true);
    }
    expect(await base.exists(LOCK)).toBe(false);
    expect(await base.exists("/.git/packed-refs.new")).toBe(false);
  });

  it("a multi-ref batch keeps packed-refs.lock across both phases", async () => {
    const base = await repo();
    const writer = new FileRefStore(base, "/.git");
    await writer.batch([{ name: "refs/heads/a", new: oid(1) }]);
    let locks = 0;
    const refs = new FileRefStore(watched(base, { onLock: () => locks++ }), "/.git");
    expect(
      await refs.batch([
        { name: "refs/heads/a", old: oid(1), new: oid(5) },
        { name: "refs/heads/b", old: null, new: oid(6) },
      ]),
    ).toEqual({ ok: true, rejected: [] });
    expect(locks).toBe(1);
    expect((await writer.resolve("refs/heads/a"))?.objectId).toBe(oid(5));
    expect((await writer.resolve("refs/heads/b"))?.objectId).toBe(oid(6));
    expect(await base.exists("/.git/refs/heads/a")).toBe(false);
  });

  it("a stale packed-refs.new left by a crash neither confuses readers nor blocks a rewrite", async () => {
    const files = await repo();
    const refs = new FileRefStore(files, "/.git");
    await refs.batch([
      { name: "refs/heads/p", new: oid(1) },
      { name: "refs/heads/q", new: oid(2) },
    ]);
    await files.write("/.git/packed-refs.new", [new TextEncoder().encode("garbage\n")]);
    expect((await refs.resolve("refs/heads/p"))?.objectId).toBe(oid(1));
    expect(await refs.remove("refs/heads/p")).toBe(true);
    expect((await refs.resolve("refs/heads/q"))?.objectId).toBe(oid(2));
    expect(await refs.has("refs/heads/p")).toBe(false);
    expect(await files.exists("/.git/packed-refs.new")).toBe(false);
  });
});
