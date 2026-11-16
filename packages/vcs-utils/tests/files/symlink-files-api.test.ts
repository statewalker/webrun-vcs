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
  isReservedFilesName,
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

describe("createSymlinkFilesApi consistency and confinement", () => {
  it("keeps the links of two wrappers of one base", async () => {
    const base = createInMemoryFilesApi();
    const a = createSymlinkFilesApi(base);
    const b = createSymlinkFilesApi(base);
    await Promise.all([a.symlink?.(enc.encode("1"), "/one"), b.symlink?.(enc.encode("2"), "/two")]);
    const fresh = createSymlinkFilesApi(base);
    expect((await fresh.lstat?.("/one"))?.kind).toBe("symlink");
    expect((await fresh.lstat?.("/two"))?.kind).toBe("symlink");
  });

  it("reads half-written links consistently: never a file as a link", async () => {
    const base = createInMemoryFilesApi();
    const files = createSymlinkFilesApi(base);
    await files.symlink?.(enc.encode("t"), "/ln");
    // the placeholder gone (an interrupted remove): the entry is stale, the path absent
    await base.remove("/ln");
    expect(await files.lstat?.("/ln")).toBeUndefined();
    // a placeholder given content behind the wrapper's back: a file, not a link
    await files.symlink?.(enc.encode("t"), "/ln2");
    await base.write("/ln2", [enc.encode("content")]);
    expect((await files.lstat?.("/ln2"))?.kind).toBe("file");
  });

  it("forgets what the target held when moving or copying onto it", async () => {
    const files = createSymlinkFilesApi(createInMemoryFilesApi());
    await files.symlink?.(enc.encode("old"), "/t");
    await files.write("/f", [enc.encode("")]);
    await files.chmod?.("/f", 0o755);
    expect(await files.move("/f", "/t")).toBe(true);
    expect((await files.lstat?.("/t"))?.kind).toBe("file");
    expect((await files.lstat?.("/t"))?.mode).toBe(0o755);
    await files.symlink?.(enc.encode("x"), "/dir/ln");
    await files.write("/src", [enc.encode("")]);
    await files.remove("/dir");
    await files.mkdir("/dir");
    expect(await files.copy("/src", "/dir/ln")).toBe(true);
    expect((await files.lstat?.("/dir/ln"))?.kind).toBe("file");
  });

  it("refuses '..' and the reserved table in any spelling", async () => {
    const base = createInMemoryFilesApi({ "/secret": "s", "/repo/a": "a" });
    const files = createSymlinkFilesApi(base);
    await expect(files.lstat?.("/repo/../secret")).rejects.toThrow(/\.\./);
    for (const name of ["/.WEBRUN-SYMLINKS.JSON", "/.Webrun-Symlinks.json"]) {
      await expect(files.write(name, [enc.encode("{}")])).rejects.toThrow(/Reserved/);
    }
    expect(isReservedFilesName(".WebRun-Symlinks.JSON")).toBe(true);
    const sub = createSubtreeFilesApi(base, "/repo");
    await expect(sub.read("/../../secret")[Symbol.asyncIterator]().next()).rejects.toThrow(/\.\./);
    expect(() => createSubtreeFilesApi(base, "/repo/../")).toThrow(/\.\./);
    const mounted = createMountedFilesApi(base, { "/m": createInMemoryFilesApi() });
    await expect(mounted.stats("/m/../secret")).rejects.toThrow(/\.\./);
  });

  it("forwards openLinkTarget only when asked", async () => {
    const inner = Object.assign(createInMemoryFilesApi(), {
      openLinkTarget: async () => createInMemoryFilesApi(),
    });
    expect(await createSubtreeFilesApi(inner, "/").openLinkTarget?.("/x")).toBeUndefined();
    expect(await createMountedFilesApi(inner, {}).openLinkTarget?.("/x")).toBeUndefined();
    const forwarding = createSubtreeFilesApi(inner, "/", { forwardOpenLinkTarget: true });
    expect(await forwarding.openLinkTarget?.("/x")).toBeDefined();
  });
});

describe("createMountedFilesApi listings and removals", () => {
  it("lists what is mounted below a directory and refuses to remove a mount point", async () => {
    const outer = createInMemoryFilesApi({ "/a.txt": "a", "/repo/.keep": "" });
    const inner = createInMemoryFilesApi({ "/x/y.txt": "y" });
    const files = createMountedFilesApi(outer, { "/repo/mnt": inner });
    expect(await names(files, "/", true)).toEqual([
      "/a.txt",
      "/repo",
      "/repo/.keep",
      "/repo/mnt",
      "/repo/mnt/x",
      "/repo/mnt/x/y.txt",
    ]);
    expect(await names(files, "/repo")).toEqual(["/repo/.keep", "/repo/mnt"]);
    await expect(files.remove("/repo/mnt")).rejects.toThrow(/mount point/);
    await expect(files.remove("/repo")).rejects.toThrow(/mount point/);
    expect(await inner.exists("/x/y.txt")).toBe(true);
  });
});

describe("createSymlinkFilesApi table writes", () => {
  /** A memory FilesApi counting the writes of the table file. */
  function counting() {
    const base = createInMemoryFilesApi({ "/a.txt": "a" });
    let tableWrites = 0;
    const write = base.write.bind(base);
    base.write = async (path, content) => {
      if (path === SYMLINK_TABLE_PATH) tableWrites++;
      return write(path, content);
    };
    return { base, writes: () => tableWrites };
  }

  it("never creates the table on a base without links, nor rewrites it for nothing", async () => {
    const { base, writes } = counting();
    const files = createSymlinkFilesApi(base);
    await files.write("/b.txt", [enc.encode("b")]);
    await files.remove("/a.txt");
    await files.remove("/missing");
    expect(writes()).toBe(0);
    expect(await base.exists(SYMLINK_TABLE_PATH)).toBe(false);
    await files.symlink?.(enc.encode("t"), "/ln");
    const after = writes();
    await files.remove("/b.txt");
    expect(writes()).toBe(after);
  });

  it("a stale entry never turns a new empty file into a link", async () => {
    const base = createInMemoryFilesApi();
    const files = createSymlinkFilesApi(base);
    await files.symlink?.(enc.encode("t"), "/x");
    await base.remove("/x"); // the placeholder gone: the entry is stale
    expect(await files.createExclusive?.("/x", [])).toBe(true);
    expect((await files.lstat?.("/x"))?.kind).toBe("file");
    await base.remove("/x");
    await files.symlink?.(enc.encode("t"), "/y");
    await base.remove("/y");
    await files.write("/y", []);
    expect((await files.lstat?.("/y"))?.kind).toBe("file");
  });

  it("reserves its table name at its root only", async () => {
    const files = createSymlinkFilesApi(createInMemoryFilesApi());
    expect(files.reservedNames).toEqual([".webrun-symlinks.json"]);
    expect(createSubtreeFilesApi(files, "/repo").reservedNames).toBeUndefined();
    expect(createInMemoryFilesApi() as { reservedNames?: string[] }).not.toHaveProperty(
      "reservedNames",
    );
  });
});

describe("append", () => {
  const text = async (files: { read(p: string): AsyncIterable<Uint8Array> }, path: string) => {
    let out = "";
    for await (const chunk of files.read(path)) out += new TextDecoder().decode(chunk);
    return out;
  };

  it("appends in memory, through links' side table and through mounts", async () => {
    const mem = createInMemoryFilesApi();
    const inner = createInMemoryFilesApi();
    const links = createSymlinkFilesApi(createInMemoryFilesApi());
    const mounted = createMountedFilesApi(createInMemoryFilesApi(), { "/m": inner });
    for (const [files, path] of [
      [mem, "/d/log"],
      [links, "/d/log"],
      [mounted, "/m/d/log"],
    ] as const) {
      await files.append?.(path, [enc.encode("a\n")]);
      await files.append?.(path, [enc.encode("b\n"), enc.encode("c\n")]);
      expect(await text(files, path)).toBe("a\nb\nc\n");
      await files.mkdir("/dir");
      await expect(files.append?.("/dir", [enc.encode("x")])).rejects.toMatchObject({
        code: "EISDIR",
      });
    }
    expect(await text(inner, "/d/log")).toBe("a\nb\nc\n");
  });

  it("refuses to append through a simulated link", async () => {
    const files = createSymlinkFilesApi(createInMemoryFilesApi());
    await files.write("/t", [enc.encode("target")]);
    await files.symlink?.(enc.encode("t"), "/ln");
    await expect(files.append?.("/ln", [enc.encode("x")])).rejects.toMatchObject({
      code: "ELOOP",
    });
    expect(await text(files, "/t")).toBe("target");
  });
});
