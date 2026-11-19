/**
 * An unreadable directory (EACCES) fails `list` as it fails `listKinds`: its content is
 * unknown, so no caller takes it for an empty directory. A missing directory lists nothing.
 * The tests may run as root (which reads any directory), so readdir is made to fail for a
 * directory named `locked`, as it does for an unprivileged user over `chmod 000`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const denied = (path: unknown) =>
  Object.assign(new Error(`EACCES: permission denied, scandir '${String(path)}'`), {
    code: "EACCES",
  });
const isLocked = (path: unknown) => /[\\/]locked$/.test(String(path));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = ((path: unknown, ...rest: unknown[]) => {
    if (isLocked(path)) return Promise.reject(denied(path));
    return (actual.readdir as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readdir;
  return { ...actual, readdir, default: { ...actual, readdir } };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readdirSync = ((path: unknown, ...rest: unknown[]) => {
    if (isLocked(path)) throw denied(path);
    return (actual.readdirSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readdirSync;
  return { ...actual, readdirSync, default: { ...actual, readdirSync } };
});

const { createNodeFilesApi } = await import("../src/files/index.js");

describe("PosixNodeFilesApi over an unreadable directory", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "posix-unreadable-"));
    mkdirSync(join(root, "d/locked"), { recursive: true });
    writeFileSync(join(root, "d/locked/secret"), "s");
    writeFileSync(join(root, "d/free"), "f");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const names = async (iterable: AsyncIterable<{ path: string }>) => {
    const out: string[] = [];
    for await (const e of iterable) out.push(e.path);
    return out;
  };

  it("list throws EACCES, as listKinds does", async () => {
    const files = createNodeFilesApi({ rootDir: root });
    await expect(names(files.list("/d/locked"))).rejects.toMatchObject({ code: "EACCES" });
    await expect(files.listKinds?.("/d/locked")).rejects.toMatchObject({ code: "EACCES" });
  });

  it("a recursive listing fails when it reaches the unreadable directory", async () => {
    const files = createNodeFilesApi({ rootDir: root });
    await expect(names(files.list("/d", { recursive: true }))).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(await names(files.list("/d"))).toEqual(["/d/free", "/d/locked"]);
  });

  it("a missing directory or a file lists nothing", async () => {
    const files = createNodeFilesApi({ rootDir: root });
    expect(await names(files.list("/nope"))).toEqual([]);
    expect(await names(files.list("/d/free"))).toEqual([]);
  });
});
