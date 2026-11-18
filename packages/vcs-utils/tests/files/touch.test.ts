/**
 * FilesApi.touch (git's utime of an object it would write again): in memory, and through the
 * composite FilesApis, which pass it on where the storage behind them has it.
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryFilesApi,
  createMountedFilesApi,
  createSymlinkFilesApi,
  type FilesApi,
} from "../../src/files/index.js";

const enc = new TextEncoder();

describe("FilesApi.touch", () => {
  it("in memory: sets a file's time, leaves its content; false for a directory or nothing", async () => {
    const files = createInMemoryFilesApi();
    await files.write("/d/a.txt", [enc.encode("a")]);
    expect(await files.touch?.("/d/a.txt", 1_000)).toBe(true);
    expect((await files.stats("/d/a.txt"))?.lastModified).toBe(1_000);
    const before = Date.now();
    expect(await files.touch?.("d/a.txt")).toBe(true);
    expect((await files.stats("/d/a.txt"))?.lastModified).toBeGreaterThanOrEqual(before);
    const chunks: Uint8Array[] = [];
    for await (const c of files.read("/d/a.txt")) chunks.push(c);
    expect(new TextDecoder().decode(chunks[0])).toBe("a");
    expect(await files.touch?.("/d")).toBe(false);
    expect(await files.touch?.("/missing")).toBe(false);
  });

  it("mounted: the mount's own touch; false where it has none", async () => {
    const inner = createInMemoryFilesApi();
    const plain: FilesApi = createInMemoryFilesApi();
    (plain as { touch?: unknown }).touch = undefined;
    const files = createMountedFilesApi(createInMemoryFilesApi(), {
      "/in": inner,
      "/plain": plain,
    });
    await files.write("/in/x", [enc.encode("x")]);
    await files.write("/plain/y", [enc.encode("y")]);
    expect(await files.touch?.("/in/x", 5_000)).toBe(true);
    expect((await inner.stats("/x"))?.lastModified).toBe(5_000);
    expect(await files.touch?.("/plain/y", 5_000)).toBe(false);
  });

  it("symlinks simulated: a file is touched, a link never followed", async () => {
    const files = createSymlinkFilesApi(createInMemoryFilesApi());
    await files.write("/t.txt", [enc.encode("target")]);
    await files.symlink?.(enc.encode("t.txt"), "/link");
    expect(await files.touch?.("/t.txt", 7_000)).toBe(true);
    expect((await files.stats("/t.txt"))?.lastModified).toBe(7_000);
    expect(await files.touch?.("/link", 9_000)).toBe(false);
    expect((await files.stats("/t.txt"))?.lastModified).toBe(7_000);
  });
});
