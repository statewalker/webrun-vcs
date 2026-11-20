/**
 * The lock timeouts git reads from its config (core.packedRefsTimeout, 1000 ms by default;
 * core.filesRefLockTimeout, 100 ms; negative: forever, 0: one attempt), as the backend reads
 * them for its ref store, and packed-refs.lock taken only by batches that need it.
 */
import { createInMemoryFilesApi, type FilesApi, type ObjectId } from "@statewalker/vcs-core";
import { readText } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";

import { createGitFilesBackend } from "../../src/index.js";

const oid = (n: number): ObjectId => n.toString(16).padStart(40, "a");
const PACKED_LOCK = ".git/packed-refs.lock";

/** A repository whose config sets `core` values, opened again so the backend reads them. */
async function open(core: Record<string, string> = {}) {
  const files = createInMemoryFilesApi();
  await createGitFilesBackend({ files, create: true });
  const lines = Object.entries(core).map(([k, v]) => `\t${k} = ${v}\n`);
  const config = await readText(files, ".git/config");
  await files.write(".git/config", [
    new TextEncoder().encode(`${config}[core]\n${lines.join("")}`),
  ]);
  const { history } = await createGitFilesBackend({ files });
  return { files, refs: history.refs };
}

const hold = (files: FilesApi, path: string) => files.write(path, [new Uint8Array(0)]);

/** Milliseconds `run` takes. */
async function timed<T>(run: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const result = await run();
  return [result, Date.now() - start];
}

describe("core.packedRefsTimeout", () => {
  it("0: a held packed-refs.lock fails a deletion at once", async () => {
    const { files, refs } = await open({ packedRefsTimeout: "0" });
    await refs.set("refs/heads/x", oid(1));
    await hold(files, PACKED_LOCK);
    const [result, ms] = await timed(() => refs.batch([{ name: "refs/heads/x", new: null }]));
    expect(result.ok).toBe(false);
    expect(ms).toBeLessThan(500);
    expect((await refs.resolve("refs/heads/x"))?.objectId).toBe(oid(1));
  });

  it("a timeout longer than the holder keeps the lock: the deletion waits for it", async () => {
    const { files, refs } = await open({ packedRefsTimeout: "2k" });
    await refs.set("refs/heads/x", oid(1));
    await hold(files, PACKED_LOCK);
    setTimeout(() => void files.remove(PACKED_LOCK), 1200);
    // (the default second would have given up)
    const result = await refs.batch([{ name: "refs/heads/x", new: null }]);
    expect(result.ok).toBe(true);
    expect(await refs.has("refs/heads/x")).toBe(false);
  });

  it("negative: waits for the lock however long it is held", async () => {
    const { files, refs } = await open({ packedRefsTimeout: "-1" });
    await refs.set("refs/heads/x", oid(1));
    await hold(files, PACKED_LOCK);
    setTimeout(() => void files.remove(PACKED_LOCK), 1200);
    expect(await refs.remove("refs/heads/x")).toBe(true);
  });
});

describe("core.filesRefLockTimeout", () => {
  it("0: a held ref lock fails at once; a longer timeout waits for it", async () => {
    const { files, refs } = await open({ filesRefLockTimeout: "0" });
    await hold(files, ".git/refs/heads/x.lock");
    const [result, ms] = await timed(() => refs.batch([{ name: "refs/heads/x", new: oid(1) }]));
    expect(result).toEqual({ ok: false, rejected: [{ name: "refs/heads/x", reason: "locked" }] });
    expect(ms).toBeLessThan(500);

    const slow = await open({ filesRefLockTimeout: "1500" });
    await hold(slow.files, ".git/refs/heads/x.lock");
    setTimeout(() => void slow.files.remove(".git/refs/heads/x.lock"), 400);
    expect(await slow.refs.batch([{ name: "refs/heads/x", new: oid(1) }])).toEqual({
      ok: true,
      rejected: [],
    });
    expect((await slow.refs.resolve("refs/heads/x"))?.objectId).toBe(oid(1));
  });
});

describe("packed-refs.lock only for batches that need it", () => {
  it("a batch without deletions commits loose while another writer holds packed-refs.lock", async () => {
    const { files, refs } = await open();
    await refs.set("refs/heads/x", oid(1));
    await hold(files, PACKED_LOCK);
    const [result, ms] = await timed(() =>
      refs.batch([
        { name: "refs/heads/x", old: oid(1), new: oid(2) },
        { name: "refs/heads/y", new: oid(3) },
      ]),
    );
    expect(result).toEqual({ ok: true, rejected: [] });
    // never waited for packed-refs.lock
    expect(ms).toBeLessThan(500);
    expect(await readText(files, ".git/refs/heads/x")).toBe(`${oid(2)}\n`);
    expect(await readText(files, ".git/refs/heads/y")).toBe(`${oid(3)}\n`);
    expect(await files.exists(".git/packed-refs")).toBe(false);
    expect(await files.exists(PACKED_LOCK)).toBe(true);
    expect(await files.exists(".git/refs/heads/x.lock")).toBe(false);
    expect(await files.exists(".git/refs/heads/y.lock")).toBe(false);
  });

  it("a batch that deletes still fails on a held packed-refs.lock, changing nothing", async () => {
    const { files, refs } = await open({ packedRefsTimeout: "0" });
    await refs.set("refs/heads/x", oid(1));
    await hold(files, PACKED_LOCK);
    const result = await refs.batch([
      { name: "refs/heads/x", new: null },
      { name: "refs/heads/y", new: oid(3) },
    ]);
    expect(result).toEqual({ ok: false, rejected: [{ name: "packed-refs", reason: "locked" }] });
    expect((await refs.resolve("refs/heads/x"))?.objectId).toBe(oid(1));
    expect(await refs.has("refs/heads/y")).toBe(false);
  });
});
