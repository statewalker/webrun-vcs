/**
 * P4.36: PosixNodeFilesApi's touch (utime of the entry itself), its exclusive create of small
 * and large files, and a batch view that keeps what it verified across file moves.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adjustSharedPerm,
  BeyondSymlinkError,
  createMountedFilesApi,
  parseSharedRepository,
  withSharedPerm,
} from "@statewalker/vcs-utils/files";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PosixNodeFilesApi } from "../src/files/index.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const enc = new TextEncoder();

describe("PosixNodeFilesApi writes (P4.36)", () => {
  let root: string;
  let files: PosixNodeFilesApi;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "posix-write-"));
    files = new PosixNodeFilesApi({ rootDir: root });
  });
  afterEach(() => removeTempDir(root), CLEANUP_TIMEOUT);

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
  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

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

/** Whether this process can give a regular file setuid, setgid and sticky bits (root can). */
function highBitsStick(dir: string): boolean {
  const probe = join(dir, "probe");
  writeFileSync(probe, "");
  chmodSync(probe, 0o7600);
  const ok = (statSync(probe).mode & 0o7777) === 0o7600;
  unlinkSync(probe);
  return ok;
}

describe("PosixNodeFilesApi setuid, setgid and sticky bits (statewalker/webrun-vcs#273)", () => {
  let root: string;
  let files: PosixNodeFilesApi;
  let sticks = false;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "posix-high-bits-"));
    files = new PosixNodeFilesApi({ rootDir: root });
    sticks = highBitsStick(root);
  });
  afterEach(() => removeTempDir(root), CLEANUP_TIMEOUT);
  const modeOf = (name: string) => statSync(join(root, name)).mode & 0o7777;

  it("write over a file keeps its setuid, setgid and sticky bits (small and large content)", async (ctx) => {
    if (!sticks) ctx.skip();
    const large = new Uint8Array(1 << 20).fill(0x61);
    for (const [name, mode] of [
      ["sgid", 0o2640],
      ["suid", 0o4600],
      ["sticky", 0o1600],
    ] as const) {
      writeFileSync(join(root, name), "old");
      chmodSync(join(root, name), mode);
      await files.write(`/${name}`, [new TextEncoder().encode("new")]);
      expect(modeOf(name), name).toBe(mode);
      expect(readFileSync(join(root, name), "utf8")).toBe("new");
      await files.write(`/${name}`, [large]);
      expect(modeOf(name), `${name} (large)`).toBe(mode);
      expect(statSync(join(root, name)).size).toBe(large.length);
    }
  });

  it("a new file and a replaced link get no high bits", async (ctx) => {
    if (!sticks) ctx.skip();
    writeFileSync(join(root, "t"), "target");
    chmodSync(join(root, "t"), 0o2640);
    symlinkSync("t", join(root, "l"));
    await files.write("/l", [new TextEncoder().encode("x")]);
    expect(lstatSync(join(root, "l")).isFile()).toBe(true);
    expect(modeOf("l") & 0o7000).toBe(0);
    expect(modeOf("t")).toBe(0o2640);
    await files.write("/n", [new TextEncoder().encode("x")]);
    expect(modeOf("n") & 0o7000).toBe(0);
  });

  it("chmod of a regular file never raises setuid, setgid or sticky bits", async () => {
    for (const mode of [0o4755, 0o2755, 0o1755, 0o7755]) {
      writeFileSync(join(root, "f"), "");
      chmodSync(join(root, "f"), 0o644);
      await files.chmod("/f", mode);
      expect(modeOf("f"), mode.toString(8)).toBe(0o755);
    }
  });

  it("chmod of a regular file drops high bits it already had (only highBitsFrom keeps them)", async (ctx) => {
    if (!sticks) ctx.skip();
    writeFileSync(join(root, "f"), "");
    chmodSync(join(root, "f"), 0o2640);
    await files.chmod("/f", 0o2600);
    expect(modeOf("f")).toBe(0o600);
  });

  it("chmod with highBitsFrom keeps only the high bits that file carries", async (ctx) => {
    if (!sticks) ctx.skip();
    writeFileSync(join(root, "config"), "");
    chmodSync(join(root, "config"), 0o2640);
    writeFileSync(join(root, "config.lock"), "");
    await files.chmod("/config.lock", 0o2640, { highBitsFrom: "/config" });
    expect(modeOf("config.lock")).toBe(0o2640);
    // bits the reference lacks are never raised
    await files.chmod("/config.lock", 0o6640, { highBitsFrom: "/config" });
    expect(modeOf("config.lock")).toBe(0o2640);
    // a reference that is a link, a directory or missing lends nothing
    symlinkSync("config", join(root, "link"));
    mkdirSync(join(root, "dir"));
    chmodSync(join(root, "dir"), 0o2755);
    for (const ref of ["/link", "/dir", "/missing"]) {
      await files.chmod("/config.lock", 0o2640, { highBitsFrom: ref });
      expect(modeOf("config.lock"), ref).toBe(0o640);
    }
  });

  it("shared-repository adjustments and rewrites keep the high bits a file has", async (ctx) => {
    if (!sticks) ctx.skip();
    const group = parseSharedRepository("group");
    writeFileSync(join(root, "config"), "");
    chmodSync(join(root, "config"), 0o2600);
    await adjustSharedPerm(files, "/config", group);
    expect(modeOf("config")).toBe(0o2660);
    const shared = withSharedPerm(files, () => group);
    await shared.write("/config", [new TextEncoder().encode("x")]);
    expect(modeOf("config")).toBe(0o2660);
    writeFileSync(join(root, "config.lock"), "");
    await (shared as PosixNodeFilesApi).chmod("/config.lock", 0o2600, { highBitsFrom: "/config" });
    expect(modeOf("config.lock")).toBe(0o2660);
  });

  it("a mounted FilesApi passes highBitsFrom on within one mount only", async (ctx) => {
    if (!sticks) ctx.skip();
    mkdirSync(join(root, "m"));
    const mounted = createMountedFilesApi(files, {
      "/mnt": new PosixNodeFilesApi({ rootDir: join(root, "m") }),
    });
    for (const dir of [root, join(root, "m")]) {
      writeFileSync(join(dir, "ref"), "");
      chmodSync(join(dir, "ref"), 0o2640);
      writeFileSync(join(dir, "lock"), "");
    }
    await mounted.chmod?.("/mnt/lock", 0o2640, { highBitsFrom: "/mnt/ref" });
    expect(modeOf("m/lock")).toBe(0o2640);
    await mounted.chmod?.("/mnt/lock", 0o2640, { highBitsFrom: "/ref" });
    expect(modeOf("m/lock")).toBe(0o640);
    await mounted.chmod?.("/lock", 0o2640, { highBitsFrom: "/../ref" });
    expect(modeOf("lock")).toBe(0o640);
  });

  it("a directory still takes setgid (shared repositories) but never setuid or sticky", async () => {
    mkdirSync(join(root, "d"));
    await files.chmod("/d", 0o7775);
    expect(modeOf("d")).toBe(0o2775);
  });
});
