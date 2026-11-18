/**
 * P4.36: PosixNodeFilesApi's touch (utime of the entry itself), its exclusive create of small
 * and large files, and a batch view that keeps what it verified across file moves.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BeyondSymlinkError } from "@statewalker/vcs-utils/files";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PosixNodeFilesApi } from "../src/files/index.js";

const enc = new TextEncoder();

describe("PosixNodeFilesApi writes (P4.36)", () => {
  let root: string;
  let files: PosixNodeFilesApi;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "posix-write-"));
    files = new PosixNodeFilesApi({ rootDir: root });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("touch sets a file's mtime, keeps its content and inode", async () => {
    writeFileSync(join(root, "a"), "content");
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(join(root, "a"), old, old);
    const ino = statSync(join(root, "a")).ino;
    expect(await files.touch("/a")).toBe(true);
    expect(statSync(join(root, "a")).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    expect(statSync(join(root, "a")).ino).toBe(ino);
    expect(readFileSync(join(root, "a"), "utf8")).toBe("content");
    expect(await files.touch("/a", 1_700_000_000_000)).toBe(true);
    expect(statSync(join(root, "a")).mtimeMs).toBe(1_700_000_000_000);
  });

  it("touch is false for nothing, a directory and a link, and never follows one", async () => {
    writeFileSync(join(root, "t"), "target");
    const set = new Date(1_600_000_000_000);
    utimesSync(join(root, "t"), set, set);
    symlinkSync("t", join(root, "l"));
    mkdirSync(join(root, "d"));
    expect(await files.touch("/missing")).toBe(false);
    expect(await files.touch("/d")).toBe(false);
    expect(await files.touch("/l")).toBe(false);
    expect(statSync(join(root, "t")).mtimeMs).toBe(1_600_000_000_000);
    expect(lstatSync(join(root, "l")).isSymbolicLink()).toBe(true);
    symlinkSync("d", join(root, "ld"));
    await expect(files.touch("/ld/x")).rejects.toThrow(BeyondSymlinkError);
  });

  it("createExclusive writes small and large content whole, and refuses what is there", async () => {
    const small = enc.encode("small");
    const large = new Uint8Array(300_000).map((_, i) => i % 251);
    expect(await files.createExclusive("/s", [small])).toBe(true);
    expect(
      await files.createExclusive(
        "/dir/big",
        (async function* () {
          for (let i = 0; i < large.length; i += 10_000) yield large.subarray(i, i + 10_000);
        })(),
      ),
    ).toBe(true);
    expect(readFileSync(join(root, "s"), "utf8")).toBe("small");
    expect(readFileSync(join(root, "dir/big")).equals(Buffer.from(large))).toBe(true);
    expect(await files.createExclusive("/s", [enc.encode("other")])).toBe(false);
    expect(readFileSync(join(root, "s"), "utf8")).toBe("small");
    // a link at the path is not written through
    symlinkSync("s", join(root, "link"));
    expect(await files.createExclusive("/link", [enc.encode("x")])).toBe(false);
  });

  it("createExclusive does not leave a file when the content fails, and reads none when it exists", async () => {
    await expect(
      files.createExclusive(
        "/fails",
        (async function* () {
          yield new Uint8Array(100_000);
          throw new Error("source broke");
        })(),
      ),
    ).rejects.toThrow("source broke");
    expect(await files.exists("/fails")).toBe(false);
    writeFileSync(join(root, "taken"), "x");
    let read = false;
    const content = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            read = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    expect(await files.createExclusive("/taken", content)).toBe(false);
    expect(read).toBe(false);
  });

  it("a batch view keeps its verified directories across file moves, and recovers when one is gone", async () => {
    const view = files.withLstatCache();
    await view.write("/objects/tmp1", [enc.encode("1")]);
    expect(await view.move("/objects/tmp1", "/objects/ab/one")).toBe(true);
    await view.write("/objects/tmp2", [enc.encode("2")]);
    expect(await view.move("/objects/tmp2", "/objects/ab/two")).toBe(true);
    // the fan-out directory removed behind the view's back: the move fails once, then works
    rmSync(join(root, "objects/ab"), { recursive: true });
    await view.write("/objects/tmp3", [enc.encode("3")]);
    const first = await view.move("/objects/tmp3", "/objects/ab/three");
    if (!first) expect(await view.move("/objects/tmp3", "/objects/ab/three")).toBe(true);
    expect(readFileSync(join(root, "objects/ab/three"), "utf8")).toBe("3");
    // a directory replaced by a link behind its back is still refused once the view forgets
    rmSync(join(root, "objects/ab"), { recursive: true });
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(root, "objects/ab"));
    await view.write("/objects/tmp4", [enc.encode("4")]);
    const fresh = files.withLstatCache();
    await expect(fresh.move("/objects/tmp4", "/objects/ab/four")).rejects.toThrow(
      BeyondSymlinkError,
    );
  });
});

describe("PosixNodeFilesApi batch view with maxAgeMs (review of P4.36)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "posix-lstat-age-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("checks a verified directory again once it is older than maxAgeMs", async () => {
    const view = new PosixNodeFilesApi({ rootDir: root }).withLstatCache({ maxAgeMs: 1000 });
    const start = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(start);
    await view.write("/objects/ab/one", [enc.encode("1")]);
    // the fan-out directory replaced by a link behind the view's back
    rmSync(join(root, "objects/ab"), { recursive: true });
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(root, "objects/ab"));
    // within maxAgeMs it is trusted (followed, as git follows links in objects/)
    vi.spyOn(performance, "now").mockReturnValue(start + 500);
    await view.write("/objects/ab/two", [enc.encode("2")]);
    expect(readFileSync(join(root, "elsewhere/two"), "utf8")).toBe("2");
    // then looked at again, and refused
    vi.spyOn(performance, "now").mockReturnValue(start + 1500);
    await expect(view.write("/objects/ab/three", [enc.encode("3")])).rejects.toThrow(
      BeyondSymlinkError,
    );
  });
});
