/**
 * PosixNodeFilesApi's batched stat path: `lstatMany` answers as `lstat` path by path (a
 * path beneath a link or with nothing there as undefined), `listKinds` lists a directory
 * with each entry's kind from `readdir` (no stat), never following a link; and paths that
 * are not plain (`.`, `..`, `//`) still resolve inside the root.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PosixNodeFilesApi } from "../src/files/index.js";

describe("PosixNodeFilesApi lstatMany and listKinds", () => {
  let base: string;
  let root: string;
  let files: PosixNodeFilesApi;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "posix-stat-batch-"));
    root = join(base, "root");
    mkdirSync(join(root, "d/sub"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "d/b.txt"), "bb");
    writeFileSync(join(root, "d/sub/c.sh"), "ccc");
    chmodSync(join(root, "d/sub/c.sh"), 0o755);
    symlinkSync("d", join(root, "link"));
    symlinkSync("nowhere", join(root, "d/dangling"));
    files = new PosixNodeFilesApi({ rootDir: root });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("lstatMany answers as lstat does, in order", async () => {
    const paths = ["/a.txt", "/d/b.txt", "/d/sub/c.sh", "/link", "/d/dangling", "/d", "/missing"];
    const many = await files.lstatMany(paths);
    const one = await Promise.all(paths.map((p) => files.lstat(p)));
    expect(many).toEqual(one);
    expect(many.map((s) => s?.kind)).toEqual([
      "file",
      "file",
      "file",
      "symlink",
      "symlink",
      "directory",
      undefined,
    ]);
    expect((many[2]?.mode ?? 0) & 0o777).toBe(0o755);
    expect(many[1]?.size).toBe(2);
  });

  it("a path beneath a link is undefined in lstatMany (lstat throws there)", async () => {
    await expect(files.lstat("/link/b.txt")).rejects.toThrow();
    expect(await files.lstatMany(["/link/b.txt", "/a.txt"])).toEqual([
      undefined,
      await files.lstat("/a.txt"),
    ]);
    // a batch view (which caches verified directories) answers alike
    const batch = files.withLstatCache();
    expect(await batch.lstatMany(["/d/b.txt", "/link/b.txt", "/d/sub/c.sh"])).toEqual([
      await files.lstat("/d/b.txt"),
      undefined,
      await files.lstat("/d/sub/c.sh"),
    ]);
  });

  it("paths that are not plain resolve as before, never outside the root", async () => {
    expect(await files.lstat("d/./b.txt")).toEqual(await files.lstat("/d/b.txt"));
    expect(await files.lstat("//d//b.txt")).toEqual(await files.lstat("/d/b.txt"));
    await expect(files.lstat("/d/../../x")).rejects.toThrow();
    expect((await files.lstat("/"))?.kind).toBe("directory");
  });

  it("listKinds gives each entry's kind without following links", async () => {
    const sorted = (list: { name: string; kind?: string }[]) =>
      [...list].sort((x, y) => (x.name < y.name ? -1 : 1));
    expect(sorted(await files.listKinds("/"))).toEqual([
      { name: "a.txt", kind: "file" },
      { name: "d", kind: "directory" },
      { name: "link", kind: "symlink" },
    ]);
    expect(sorted(await files.listKinds("/d"))).toEqual([
      { name: "b.txt", kind: "file" },
      { name: "dangling", kind: "symlink" },
      { name: "sub", kind: "directory" },
    ]);
    // a link to a directory is not listed through, a file or a missing path lists nothing
    expect(await files.listKinds("/link")).toEqual([]);
    expect(await files.listKinds("/a.txt")).toEqual([]);
    expect(await files.listKinds("/missing")).toEqual([]);
    await expect(files.listKinds("/link/sub")).rejects.toThrow();
  });

  it("listKinds keeps a name that is no UTF-8 as list does", async () => {
    const name = Buffer.from([0x66, 0xff, 0x2e, 0x74]); // f\xff.t
    writeFileSync(Buffer.concat([Buffer.from(`${root}/d/`), name]), "x");
    const listed = (await files.listKinds("/d")).map((e) => e.name);
    const viaList: string[] = [];
    for await (const info of files.list("/d")) viaList.push(info.name);
    expect(listed.sort()).toEqual(viaList.sort());
    const odd = listed.find((n) => n.startsWith("f") && n.endsWith(".t")) as string;
    expect((await files.lstatMany([`/d/${odd}`]))[0]?.size).toBe(1);
  });
});
