import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, describe, expect, it } from "vitest";
import { createFilesLfsStore, sha256Hex } from "../src/index.js";
import { collect, prng } from "./helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function listAll(files: FilesApi, path: string): Promise<string[]> {
  const out: string[] = [];
  if (!(await files.exists(path))) return out;
  for await (const e of files.list(path, { recursive: true }))
    if (e.kind === "file") out.push(e.path);
  return out;
}

describe.each([
  ["MemFilesApi", () => new MemFilesApi() as FilesApi],
  [
    "NodeFilesApi",
    () => {
      const d = mkdtempSync(join(tmpdir(), "lfs-store-"));
      dirs.push(d);
      return createNodeFilesApi({ rootDir: d });
    },
  ],
])("createFilesLfsStore on %s", (_name, makeFiles) => {
  it("stores objects at lfs/objects/aa/bb/<oid> under the root, verified", async () => {
    const files = makeFiles();
    const store = createFilesLfsStore(files, ".git");
    const bytes = prng(70_000, 1);
    const oid = await sha256Hex(bytes);
    const res = await store.put(chunked(bytes, 4096), { oid, size: bytes.length });
    expect(res).toEqual({ ok: true, size: bytes.length });
    expect(
      (await files.stats(`.git/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`))?.kind,
    ).toBe("file");
    expect(await store.size(oid)).toBe(bytes.length);
    expect(await collect(store.read(oid))).toEqual(bytes);
    expect(await collect(store.read(oid, { offset: 69_000 }))).toEqual(bytes.subarray(69_000));
    expect(await collect(store.read(oid, { offset: 5, length: 10 }))).toEqual(
      bytes.subarray(5, 15),
    );
    // nothing left behind in the temporary directory
    expect(await listAll(files, ".git/lfs/tmp")).toEqual([]);
  });

  it("a mismatch (hash or size) leaves nothing visible and no temporary file", async () => {
    const files = makeFiles();
    const store = createFilesLfsStore(files);
    const bytes = prng(5000, 2);
    const oid = await sha256Hex(bytes);
    expect(await store.put(bytes, { oid: "f".repeat(64) })).toEqual({
      ok: false,
      reason: "sha256 mismatch",
    });
    expect(await store.put(bytes, { oid, size: 4000 })).toEqual({
      ok: false,
      reason: "size mismatch",
    });
    expect(await store.put(bytes, { oid, size: 6000 })).toEqual({
      ok: false,
      reason: "size mismatch",
    });
    expect(await store.put(bytes, { oid }, { maxSize: 100 })).toEqual({
      ok: false,
      reason: "too large",
    });
    expect(await store.size(oid)).toBeUndefined();
    expect(await store.size("f".repeat(64))).toBeUndefined();
    expect(await listAll(files, "lfs")).toEqual([]);
  });

  it("keeps partial downloads at lfs/incomplete/<oid>.part, appends, completes verified", async () => {
    const files = makeFiles();
    const store = createFilesLfsStore(files);
    const bytes = prng(9000, 3);
    const ptr = { oid: await sha256Hex(bytes), size: bytes.length };
    const partial = store.partial;
    if (!partial) throw new Error("the files store keeps partials");
    expect(await partial.size(ptr.oid)).toBe(0);
    expect(await partial.append(ptr.oid, [bytes.subarray(0, 3000)])).toBe(3000);
    expect((await files.stats(`lfs/incomplete/${ptr.oid}.part`))?.kind).toBe("file");
    // a source that fails part way keeps what arrived
    async function* failing() {
      yield bytes.slice(3000, 5000);
      throw new TypeError("connection reset");
    }
    await expect(partial.append(ptr.oid, failing())).rejects.toThrow("connection reset");
    expect(await partial.size(ptr.oid)).toBe(5000);
    expect(await partial.append(ptr.oid, [bytes.subarray(5000)])).toBe(9000);
    expect(await partial.complete(ptr)).toEqual({ ok: true, size: ptr.size });
    expect(await partial.size(ptr.oid)).toBe(0);
    expect(await collect(store.read(ptr.oid))).toEqual(bytes);
  });

  it("a partial that does not verify is dropped", async () => {
    const files = makeFiles();
    const store = createFilesLfsStore(files);
    const bytes = prng(1000, 4);
    const ptr = { oid: await sha256Hex(bytes), size: bytes.length };
    await store.partial?.append(ptr.oid, [prng(1000, 5)]);
    expect(await store.partial?.complete(ptr)).toEqual({ ok: false, reason: "sha256 mismatch" });
    expect(await store.partial?.size(ptr.oid)).toBe(0);
    expect(await store.size(ptr.oid)).toBeUndefined();
  });

  it("refuses invalid oids rather than escaping the layout", async () => {
    const store = createFilesLfsStore(makeFiles());
    expect(await store.size("../../etc/passwd")).toBeUndefined();
    expect(await store.put(new Uint8Array(1), { oid: "../x" })).toEqual({
      ok: false,
      reason: "sha256 mismatch",
    });
  });
});

describe("the files store shares objects with a .git directory on disk", () => {
  it("writes the exact bytes at git-lfs's path", async () => {
    const d = mkdtempSync(join(tmpdir(), "lfs-layout-"));
    dirs.push(d);
    const store = createFilesLfsStore(createNodeFilesApi({ rootDir: d }), ".git");
    const bytes = prng(1234, 6);
    const oid = await sha256Hex(bytes);
    await store.put(bytes, { oid, size: bytes.length });
    const path = join(d, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
    expect(Buffer.from(readFileSync(path)).equals(Buffer.from(bytes))).toBe(true);
    expect(readdirSync(join(d, ".git", "lfs", "tmp"))).toEqual([]);
  });
});

function* chunked(bytes: Uint8Array, size: number): Generator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
