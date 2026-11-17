/**
 * PosixNodeFilesApi: chmod, symlink, lstat and readlink over a real directory, contained to
 * the root and never following a symbolic link.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BeyondSymlinkError } from "@statewalker/vcs-utils/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNodeFilesApi, PosixNodeFilesApi } from "../src/files/index.js";
import { replaceFile, writeBatched } from "../src/files/replace-file.js";

const enc = new TextEncoder();

describe("PosixNodeFilesApi", () => {
  let base: string;
  let root: string;
  let files: PosixNodeFilesApi;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "posix-files-"));
    root = join(base, "root");
    mkdirSync(root);
    files = new PosixNodeFilesApi({ rootDir: root });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("is what createNodeFilesApi returns, with every POSIX operation", () => {
    const api = createNodeFilesApi({ rootDir: root });
    expect(api).toBeInstanceOf(PosixNodeFilesApi);
    for (const op of ["chmod", "symlink", "lstat", "readlink"] as const) {
      expect(typeof api[op]).toBe("function");
    }
  });

  it("chmod sets the permission bits, lstat reads them back", async () => {
    writeFileSync(join(root, "run.sh"), "#!/bin/sh\n");
    await files.chmod("/run.sh", 0o755);
    expect(statSync(join(root, "run.sh")).mode & 0o777).toBe(0o755);
    const stats = await files.lstat("/run.sh");
    expect(stats?.kind).toBe("file");
    expect(stats?.mode).toBe(0o755);
    expect(stats?.size).toBe(10);
    expect(stats?.ctime).toBeGreaterThan(0);
  });

  it("never chmods through a symbolic link", async () => {
    writeFileSync(join(base, "outside.txt"), "x");
    symlinkSync("../outside.txt", join(root, "link"));
    const before = statSync(join(base, "outside.txt")).mode;
    await expect(files.chmod("/link", 0o777)).rejects.toThrow(/symbolic link/);
    expect(statSync(join(base, "outside.txt")).mode).toBe(before);
  });

  it("symlink and readlink round-trip the target as bytes, not followed by lstat", async () => {
    // not UTF-8: a TextDecoder would turn 0xff into U+FFFD
    const target = new Uint8Array([0x74, 0xff, 0x2e, 0x74, 0x78, 0x74]);
    await files.symlink(target, "/dir/link");
    expect(lstatSync(join(root, "dir/link")).isSymbolicLink()).toBe(true);
    expect([...((await files.readlink("/dir/link")) ?? [])]).toEqual([...target]);
    expect([...readlinkSync(join(root, "dir/link"), { encoding: "buffer" })]).toEqual([...target]);
    const stats = await files.lstat("/dir/link");
    expect(stats?.kind).toBe("symlink");
    expect(stats?.size).toBe(target.length);
    expect(await files.readlink("/missing")).toBeUndefined();
  });

  it("removes a dangling link itself; lists and finds it", async () => {
    symlinkSync("nowhere", join(root, "dangling"));
    expect(await files.exists("/dangling")).toBe(true);
    const names: string[] = [];
    for await (const entry of files.list("/")) names.push(entry.name);
    expect(names).toEqual(["dangling"]);
    expect(await files.remove("/dangling")).toBe(true);
    expect(() => lstatSync(join(root, "dangling"))).toThrow();
  });

  it("removes a link to a directory, not the directory", async () => {
    mkdirSync(join(base, "outdir"));
    writeFileSync(join(base, "outdir/secret.txt"), "s");
    symlinkSync("../outdir", join(root, "d"));
    expect(await files.remove("/d")).toBe(true);
    expect(statSync(join(base, "outdir/secret.txt")).isFile()).toBe(true);
  });

  it("refuses to work beneath a symbolic link", async () => {
    mkdirSync(join(base, "outdir"));
    symlinkSync("../outdir", join(root, "d"));
    writeFileSync(join(base, "outdir/f"), "f");
    await expect(files.symlink(enc.encode("x"), "/d/link")).rejects.toThrow(/symbolic link/);
    await expect(files.chmod("/d/f", 0o777)).rejects.toThrow(/symbolic link/);
    await expect(files.readlink("/d/f")).rejects.toThrow(/symbolic link/);
    // beneath a link a path is neither present nor absent
    await expect(files.lstat("/d/f")).rejects.toBeInstanceOf(BeyondSymlinkError);
  });

  it("stays inside the root", async () => {
    await expect(files.chmod("/../x", 0o644)).rejects.toThrow(/\.\./);
    await expect(files.symlink(enc.encode("x"), "/a/../../x")).rejects.toThrow();
  });
});

describe("PosixNodeFilesApi never follows a link, in every operation", () => {
  let base: string;
  let root: string;
  let files: PosixNodeFilesApi;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "posix-files2-"));
    root = join(base, "root");
    mkdirSync(root);
    mkdirSync(join(base, "outdir"));
    writeFileSync(join(base, "outdir/secret"), "SECRET\n");
    writeFileSync(join(base, "outside.txt"), "original\n");
    symlinkSync("../outdir", join(root, "d"));
    symlinkSync("../outside.txt", join(root, "x"));
    files = new PosixNodeFilesApi({ rootDir: root });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const beyond = (promise: Promise<unknown>) =>
    expect(promise).rejects.toBeInstanceOf(BeyondSymlinkError);

  it("write replaces a link at the path, never writing into its target", async () => {
    await files.write("/x", [enc.encode("PWNED\n")]);
    expect(readFileSync(join(base, "outside.txt"), "utf8")).toBe("original\n");
    expect(lstatSync(join(root, "x")).isFile()).toBe(true);
    expect(readFileSync(join(root, "x"), "utf8")).toBe("PWNED\n");
  });

  it("write keeps a regular file's permission bits", async () => {
    writeFileSync(join(root, "run.sh"), "1");
    chmodSync(join(root, "run.sh"), 0o750);
    await files.write("/run.sh", [enc.encode("2")]);
    expect(statSync(join(root, "run.sh")).mode & 0o777).toBe(0o750);
  });

  it("refuses every operation beneath a link", async () => {
    await beyond(files.write("/d/evil", [enc.encode("x")]));
    await beyond(files.createExclusive("/d/evil.lock", [enc.encode("x")]));
    await beyond(files.mkdir("/d/sub"));
    await beyond(files.remove("/d/secret"));
    await beyond(files.stats("/d/secret"));
    await beyond(files.lstat("/d/secret"));
    await beyond(collectAll(files.read("/d/secret")));
    await beyond(collectAll(files.list("/d/sub")));
    // the link itself is no directory to list
    expect(await collectAll(files.list("/d"))).toEqual([]);
    await beyond(files.move("/d/secret", "/stolen"));
    await beyond(files.copy("/d/secret", "/stolen"));
    await beyond(files.move("/x", "/d/moved"));
    expect(await files.exists("/d/secret")).toBe(false);
    expect(readdirSync(join(base, "outdir"))).toEqual(["secret"]);
    expect(readFileSync(join(base, "outdir/secret"), "utf8")).toBe("SECRET\n");
  });

  it("stats, reads and lists a link as a link; recursive lists never descend into one", async () => {
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real/f.txt"), "f\n");
    symlinkSync("..", join(root, "real/loop"));
    expect(await files.stats("/x")).toMatchObject({ kind: "file", size: "../outside.txt".length });
    expect(await collectAll(files.read("/x"))).toEqual([]);
    const paths: string[] = [];
    for await (const info of files.list("/", { recursive: true })) {
      paths.push(`${info.path} ${info.kind}`);
    }
    expect(paths).toEqual([
      "/d file",
      "/real directory",
      "/real/f.txt file",
      "/real/loop file",
      "/x file",
    ]);
  });

  it("copies and moves a link as a link", async () => {
    expect(await files.copy("/x", "/y")).toBe(true);
    expect(lstatSync(join(root, "y")).isSymbolicLink()).toBe(true);
    expect(await files.move("/y", "/z")).toBe(true);
    expect(lstatSync(join(root, "z")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(base, "outside.txt"), "utf8")).toBe("original\n");
  });

  it("refuses a backslash on Windows, where it is a separator", async () => {
    const win = new PosixNodeFilesApi({ rootDir: root, platform: "win32" });
    await expect(win.write("/d\\evil", [enc.encode("x")])).rejects.toThrow(/'\\'/);
    await expect(win.lstat("/a\\b")).rejects.toThrow(/'\\'/);
    // elsewhere it is part of a file name
    const posix = new PosixNodeFilesApi({ rootDir: root, platform: "linux" });
    await posix.write("/a\\b", [enc.encode("x")]);
    expect(readFileSync(join(root, "a\\b"), "utf8")).toBe("x");
  });
});

async function collectAll<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

describe("PosixNodeFilesApi writes as NodeFilesApi (replaceFile, writeBatched)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "posix-write-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("retries a Windows rename refused while the file is open", async () => {
    writeFileSync(join(root, "tmp"), "new");
    writeFileSync(join(root, "target"), "old");
    let calls = 0;
    await replaceFile(join(root, "tmp"), join(root, "target"), {
      platform: "win32",
      retryDelayMs: 1,
      rename: async (from, to) => {
        if (++calls < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        renameSync(from, to);
      },
    });
    expect(calls).toBe(3);
    expect(readFileSync(join(root, "target"), "utf8")).toBe("new");
  });

  it("copies in place over a mount point (EBUSY/EXDEV), never through a link", async () => {
    writeFileSync(join(root, "tmp"), "new content");
    writeFileSync(join(root, "target"), "old");
    const exdev = async () => {
      throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    };
    await replaceFile(join(root, "tmp"), join(root, "target"), { rename: exdev });
    expect(readFileSync(join(root, "target"), "utf8")).toBe("new content");
    writeFileSync(join(root, "tmp2"), "x");
    writeFileSync(join(root, "victim"), "keep");
    symlinkSync("victim", join(root, "linked"));
    await expect(
      replaceFile(join(root, "tmp2"), join(root, "linked"), { rename: exdev }),
    ).rejects.toThrow();
    expect(readFileSync(join(root, "victim"), "utf8")).toBe("keep");
  });

  it("repeats a short write until every byte is written", async () => {
    const written: number[] = [];
    const handle = {
      write: async (bytes: Uint8Array, offset: number, length: number) => {
        const n = Math.min(3, length);
        for (let i = 0; i < n; i++) written.push(bytes[offset + i]);
        return { bytesWritten: n };
      },
    } as unknown as Parameters<typeof writeBatched>[0];
    await writeBatched(handle, [enc.encode("hello "), enc.encode("world")]);
    expect(new TextDecoder().decode(new Uint8Array(written))).toBe("hello world");
  });

  it("never carries setuid, setgid or sticky bits", async () => {
    const files = new PosixNodeFilesApi({ rootDir: root });
    writeFileSync(join(root, "f"), "x");
    await files.chmod("/f", 0o4755);
    expect(statSync(join(root, "f")).mode & 0o7777).toBe(0o755);
    chmodSync(join(root, "f"), 0o2750);
    await files.write("/f", [enc.encode("y")]);
    expect(statSync(join(root, "f")).mode & 0o7777).toBe(0o750);
  });

  it.skipIf(process.platform === "win32")("reads a FIFO as nothing, without blocking", async () => {
    execFileSync("mkfifo", [join(root, "pipe")]);
    const files = new PosixNodeFilesApi({ rootDir: root });
    const chunks: Uint8Array[] = [];
    for await (const chunk of files.read("/pipe")) chunks.push(chunk);
    expect(chunks).toEqual([]);
    expect((await files.lstat("/pipe"))?.kind).toBe("other");
  });
});

describe("PosixNodeFilesApi caches nothing across calls; a batch view only within a batch", () => {
  let base: string;
  let root: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "posix-cache-"));
    root = join(base, "root");
    mkdirSync(root);
    mkdirSync(join(base, "outside"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("sees a directory swapped for a link outside since its last call", async () => {
    const files = new PosixNodeFilesApi({ rootDir: root });
    await files.write("/a/x", [enc.encode("x")]);
    rmSync(join(root, "a"), { recursive: true });
    symlinkSync("../outside", join(root, "a"));
    await expect(files.write("/a/y", [enc.encode("y")])).rejects.toBeInstanceOf(BeyondSymlinkError);
    await expect(files.chmod("/a/y", 0o777)).rejects.toBeInstanceOf(BeyondSymlinkError);
    expect(readdirSync(join(base, "outside"))).toEqual([]);
  });

  it("a batch view recovers from a directory removed behind it", async () => {
    const view = new PosixNodeFilesApi({ rootDir: root }).withLstatCache();
    await view.write("/a/b/x", [enc.encode("x")]);
    rmSync(join(root, "a"), { recursive: true });
    await view.write("/a/b/y", [enc.encode("y")]);
    expect(readFileSync(join(root, "a/b/y"), "utf8")).toBe("y");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "chmods a file it cannot read",
    async () => {
      const files = new PosixNodeFilesApi({ rootDir: root });
      writeFileSync(join(root, "w"), "x");
      chmodSync(join(root, "w"), 0o200);
      await files.chmod("/w", 0o644);
      expect(statSync(join(root, "w")).mode & 0o777).toBe(0o644);
    },
  );

  it("appends in place, creating the file and its directories, never through a link", async () => {
    const files = new PosixNodeFilesApi({ rootDir: root });
    await files.append("/logs/refs/x", [enc.encode("a\n")]);
    const ino = statSync(join(root, "logs/refs/x")).ino;
    await files.append("/logs/refs/x", [enc.encode("b\n"), enc.encode("c\n")]);
    expect(readFileSync(join(root, "logs/refs/x"), "utf8")).toBe("a\nb\nc\n");
    // the same file grew (O_APPEND), no new one renamed over it
    expect(statSync(join(root, "logs/refs/x")).ino).toBe(ino);
    mkdirSync(join(root, "dir"));
    await expect(files.append("/dir", [enc.encode("x")])).rejects.toMatchObject({
      code: "EISDIR",
    });
    if (process.platform !== "win32") {
      writeFileSync(join(base, "outside-file"), "o");
      symlinkSync(join(base, "outside-file"), join(root, "ln"));
      await expect(files.append("/ln", [enc.encode("x")])).rejects.toThrow();
      symlinkSync(join(base), join(root, "lndir"));
      await expect(files.append("/lndir/outside-file", [enc.encode("x")])).rejects.toThrow(
        BeyondSymlinkError,
      );
      expect(readFileSync(join(base, "outside-file"), "utf8")).toBe("o");
    }
  });

  it("reads small files and ranges whole (synchronously), larger ones in 64 KiB chunks", async () => {
    const files = new PosixNodeFilesApi({ rootDir: root });
    const small = new Uint8Array(1000).map((_, i) => i & 255);
    const big = new Uint8Array(200_000).map((_, i) => (i * 7) & 255);
    writeFileSync(join(root, "small"), small);
    writeFileSync(join(root, "big"), big);
    const chunksOf = async (path: string, o?: { start?: number; length?: number }) => {
      const out: Uint8Array[] = [];
      for await (const c of files.read(path, o)) out.push(c);
      return out;
    };
    const smallChunks = await chunksOf("/small");
    expect(smallChunks.length).toBe(1);
    expect(Buffer.from(smallChunks[0] as Uint8Array).equals(Buffer.from(small))).toBe(true);
    // a 64 KiB range of a large file (a pack window): one chunk
    const window = await chunksOf("/big", { start: 65536, length: 65536 });
    expect(window.length).toBe(1);
    expect(
      Buffer.from(window[0] as Uint8Array).equals(Buffer.from(big.subarray(65536, 131072))),
    ).toBe(true);
    // past the end, and empty ranges
    expect(await chunksOf("/small", { start: 990, length: 100 })).toHaveLength(1);
    expect(await chunksOf("/small", { start: 2000 })).toHaveLength(0);
    expect(await chunksOf("/small", { start: 10, length: 0 })).toHaveLength(0);
    const whole = await chunksOf("/big");
    expect(whole.length).toBe(4);
    expect(whole.reduce((n, c) => n + c.length, 0)).toBe(big.length);
    // a link is never followed, a missing file reads as nothing
    if (process.platform !== "win32") {
      symlinkSync(join(root, "small"), join(root, "link"));
      expect(await chunksOf("/link")).toHaveLength(0);
    }
    expect(await chunksOf("/missing")).toHaveLength(0);
  });

  it("names that are no valid UTF-8 are their bytes on disk (decodeGitPath's escapes)", async () => {
    if (process.platform !== "linux") return;
    const files = new PosixNodeFilesApi({ rootDir: root });
    // latin-1 caf\xe9.txt in a directory d\xff, as git paths carry them
    const dir = "d\udcff";
    const name = "caf\udce9.txt";
    await files.write(`/${dir}/${name}`, [enc.encode("latin-1\n")]);
    const onDisk = (p: string) =>
      Buffer.from(
        join(root, p).replace(/[\udc80-\udcff]/g, (c) =>
          String.fromCharCode(c.charCodeAt(0) - 0xdc00),
        ),
        "latin1",
      );
    expect(readdirSync(Buffer.from(root), { encoding: "buffer" })).toEqual([
      Buffer.from([0x64, 0xff]),
    ]);
    expect(readFileSync(onDisk(`${dir}/${name}`), "utf8")).toBe("latin-1\n");
    const listed = [];
    for await (const info of files.list("/", { recursive: true })) listed.push(info.path);
    expect(listed).toEqual([`/${dir}`, `/${dir}/${name}`]);
    expect((await files.stats(`/${dir}/${name}`))?.kind).toBe("file");
    const chunks = await collectAll(files.read(`/${dir}/${name}`));
    expect(Buffer.concat(chunks).toString("utf8")).toBe("latin-1\n");
    await files.chmod(`/${dir}/${name}`, 0o755);
    expect(statSync(onDisk(`${dir}/${name}`)).mode & 0o777).toBe(0o755);
    await files.symlink(enc.encode(name), `/${dir}/l\udce9nk`);
    expect((await files.lstat(`/${dir}/l\udce9nk`))?.kind).toBe("symlink");
    expect(await files.copy(`/${dir}`, "/c\udcf6py")).toBe(true);
    expect(readFileSync(onDisk(`c\udcf6py/${name}`), "utf8")).toBe("latin-1\n");
    expect(statSync(onDisk(`c\udcf6py/${name}`)).mode & 0o777).toBe(0o755);
    expect(lstatSync(onDisk("c\udcf6py/l\udce9nk")).isSymbolicLink()).toBe(true);
    expect(await files.move(`/${dir}/${name}`, `/${dir}/n\udce9w`)).toBe(true);
    expect(readFileSync(onDisk(`${dir}/n\udce9w`), "utf8")).toBe("latin-1\n");
    expect(await files.remove(`/${dir}`)).toBe(true);
    expect(await files.exists(`/${dir}`)).toBe(false);
  });

  it("copies a plainly named directory whose children are no valid UTF-8", async () => {
    if (process.platform !== "linux") return;
    const files = new PosixNodeFilesApi({ rootDir: root });
    mkdirSync(join(root, "src"));
    writeFileSync(Buffer.concat([Buffer.from(join(root, "src/caf")), Buffer.from([0xe9])]), "x");
    expect(await files.copy("/src", "/dst")).toBe(true);
    expect(readdirSync(Buffer.from(join(root, "dst")), { encoding: "buffer" })).toEqual([
      Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    ]);
  });

  it("copy never writes through a link at the destination", async () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "posix-copy-outside-"));
    try {
      const files = new PosixNodeFilesApi({ rootDir: root });
      writeFileSync(join(outside, "victim"), "keep");
      await files.write("/file", [enc.encode("new")]);
      // a file copied onto a link replaces the link
      symlinkSync(join(outside, "victim"), join(root, "dst"));
      expect(await files.copy("/file", "/dst")).toBe(true);
      expect(lstatSync(join(root, "dst")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(root, "dst"), "utf8")).toBe("new");
      expect(readFileSync(join(outside, "victim"), "utf8")).toBe("keep");
      // a directory is never merged into a link to a directory
      await files.write("/dir/child", [enc.encode("c")]);
      symlinkSync(outside, join(root, "dirlink"));
      expect(await files.copy("/dir", "/dirlink")).toBe(false);
      expect(readdirSync(outside)).toEqual(["victim"]);
      // directory modes are kept
      chmodSync(join(root, "dir"), 0o750);
      expect(await files.copy("/dir", "/dir2")).toBe(true);
      expect(statSync(join(root, "dir2")).mode & 0o777).toBe(0o750);
      expect(readFileSync(join(root, "dir2/child"), "utf8")).toBe("c");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
