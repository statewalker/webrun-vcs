/**
 * createSymlinkFilesApi: simulated symbolic links honour the PosixFilesApi contract over any
 * FilesApi; createMountedFilesApi / createSubtreeFilesApi compose with it.
 */
import { describe, expect, it } from "vitest";

import {
  BeyondSymlinkError,
  createInMemoryFilesApi,
  createMountedFilesApi,
  createSubtreeFilesApi,
  createSymlinkFilesApi,
  SYMLINK_TABLE_PATH,
} from "../../src/files/index.js";

const enc = new TextEncoder();

async function names(
  files: { list(p: string, o?: { recursive?: boolean }): AsyncIterable<{ path: string }> },
  path: string,
  recursive = false,
) {
  const out: string[] = [];
  for await (const e of files.list(path, { recursive })) out.push(e.path);
  return out;
}

describe("createSymlinkFilesApi", () => {
  it("keeps links in a hidden side table that survives a new wrapper", async () => {
    const base = createInMemoryFilesApi();
    const files = createSymlinkFilesApi(base);
    await files.symlink?.(new Uint8Array([0x61, 0xff]), "/dir/ln");
    expect(await names(files, "/", true)).toEqual(["/dir", "/dir/ln"]);
    expect(await base.exists(SYMLINK_TABLE_PATH)).toBe(true);
    const again = createSymlinkFilesApi(base);
    expect((await again.lstat?.("/dir/ln"))?.kind).toBe("symlink");
    expect([...((await again.readlink?.("/dir/ln")) ?? [])]).toEqual([0x61, 0xff]);
    await expect(files.read(SYMLINK_TABLE_PATH)[Symbol.asyncIterator]().next()).rejects.toThrow(
      /Reserved/,
    );
  });

  it("never turns written content into a link", async () => {
    const files = createSymlinkFilesApi(createInMemoryFilesApi());
    await files.write("/f", [enc.encode(JSON.stringify({ links: { "/f": "eA==" } }))]);
    expect((await files.lstat?.("/f"))?.kind).toBe("file");
  });

  it("refuses paths beneath a link, replaces a link on write, unlinks on remove", async () => {
    const files = createSymlinkFilesApi(createInMemoryFilesApi());
    await files.write("/out/secret", [enc.encode("s")]);
    await files.symlink?.(enc.encode("../out"), "/d");
    for (const op of [
      () => files.write("/d/x", [enc.encode("x")]),
      () => files.mkdir("/d/sub"),
      () => files.lstat?.("/d/secret"),
      () => files.remove("/d/secret"),
      () => files.stats("/d/secret"),
    ]) {
      await expect(op()).rejects.toBeInstanceOf(BeyondSymlinkError);
    }
    expect(await files.exists("/d/secret")).toBe(false);
    expect(await names(files, "/d")).toEqual([]);
    await files.write("/d", [enc.encode("file")]);
    expect((await files.lstat?.("/d"))?.kind).toBe("file");
    await files.symlink?.(enc.encode("gone"), "/ln");
    expect(await files.remove("/ln")).toBe(true);
    expect(await files.lstat?.("/ln")).toBeUndefined();
  });

  it("carries links through move and copy, and forgets them with their directory", async () => {
    const files = createSymlinkFilesApi(createInMemoryFilesApi());
    await files.symlink?.(enc.encode("t"), "/a/ln");
    await files.copy("/a", "/b");
    await files.move("/a", "/c");
    expect((await files.lstat?.("/b/ln"))?.kind).toBe("symlink");
    expect((await files.lstat?.("/c/ln"))?.kind).toBe("symlink");
    expect(await files.lstat?.("/a/ln")).toBeUndefined();
    await files.remove("/b");
    await files.write("/b/ln", [enc.encode("f")]);
    expect((await files.lstat?.("/b/ln"))?.kind).toBe("file");
  });

  it("keeps permission bits set with chmod and refuses chmod on a link", async () => {
    const files = createSymlinkFilesApi(createInMemoryFilesApi());
    await files.write("/run", [enc.encode("x")]);
    await files.chmod?.("/run", 0o755);
    expect((await files.lstat?.("/run"))?.mode).toBe(0o755);
    await files.symlink?.(enc.encode("run"), "/ln");
    await expect(files.chmod?.("/ln", 0o777)).rejects.toThrow(/symbolic link/);
  });

  it("simulates case and Unicode folding", async () => {
    const files = createSymlinkFilesApi(createInMemoryFilesApi(), {
      ignoreCase: true,
      precomposeUnicode: true,
    });
    await files.write("/Dir/README", [enc.encode("1")]);
    await files.write("/dir/readme", [enc.encode("2")]);
    expect(await names(files, "/", true)).toEqual(["/Dir", "/Dir/README"]);
    await files.write("/ä", [enc.encode("a")]);
    expect(await files.exists("/ä")).toBe(true);
  });

  it("composes with mounted and sub-rooted FilesApis", async () => {
    const outer = createInMemoryFilesApi();
    const inner = createInMemoryFilesApi();
    const files = createSymlinkFilesApi(createMountedFilesApi(outer, { "/repo": inner }));
    await files.symlink?.(enc.encode("../x"), "/repo/ln");
    expect(await inner.exists("/ln")).toBe(true);
    await expect(files.write("/repo/ln/evil", [enc.encode("x")])).rejects.toBeInstanceOf(
      BeyondSymlinkError,
    );
    const sub = createSubtreeFilesApi(files, "/repo");
    expect((await sub.lstat?.("/ln"))?.kind).toBe("symlink");
    await expect(sub.write("/ln/evil", [enc.encode("x")])).rejects.toBeInstanceOf(
      BeyondSymlinkError,
    );
    expect(await names(sub, "/")).toEqual(["/ln"]);
  });
});
