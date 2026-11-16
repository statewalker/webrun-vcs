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
});
