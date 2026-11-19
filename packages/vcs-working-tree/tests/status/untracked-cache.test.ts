/**
 * The untracked cache (`UNTR`): git's EWAH bitmaps and extension bytes, the invalidation of
 * directories by index edits, and the scan that uses and updates the cache, over a simulated
 * worktree whose directory stats the tests move on as a real filesystem would.
 */
import type { DirectoryEntry, LinkStats } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import {
  DIR_HIDE_EMPTY_DIRECTORIES,
  DIR_SHOW_OTHER_DIRECTORIES,
  EMPTY_BLOB_OID,
  Ewah,
  encodeUntrackedCache,
  excludeFileOid,
  IndexPathLookup,
  invalidateUntrackedPath,
  lookupUntracked,
  newUntrackedCache,
  parseUntrackedCache,
  scanUntracked,
  type UntrackedCache,
  type UntrackedScanHost,
  untrackedCacheIdent,
  untrackedCacheIdentIs,
} from "../../src/status/index.js";

const hex = (bytes: number[]) => Buffer.from(bytes).toString("hex");

describe("EWAH bitmaps as git writes them", () => {
  const bitmap = (bits: number[]) => {
    const e = new Ewah();
    for (const b of bits) e.set(b);
    const out: number[] = [];
    e.serialize(out);
    return out;
  };

  it("an empty bitmap: bit size 0, one empty marker word, the marker at 0", () => {
    expect(hex(bitmap([]))).toBe(`00000000` + `00000001` + `0000000000000000` + `00000000`);
  });

  it("bit 0: one literal word after its marker", () => {
    expect(hex(bitmap([0]))).toBe(
      `00000001` + `00000002` + `0000000200000000` + `0000000000000001` + `00000000`,
    );
  });

  it("a word of ones becomes a run; reading gives the bits back", () => {
    const all = Array.from({ length: 64 }, (_, i) => i);
    expect(hex(bitmap(all))).toBe(`00000040` + `00000001` + `0000000000000003` + `00000000`);
    for (const bits of [[1, 2, 63, 64, 200, 201, 1000], all, [5], [130, 4000]]) {
      const bytes = Uint8Array.from(bitmap(bits));
      const read = Ewah.read(bytes, 0, bytes.length);
      expect(read?.next).toBe(bytes.length);
      expect([...(read?.bitmap.bits() ?? [])]).toEqual(bits);
    }
  });

  it("refuses bits set out of order", () => {
    const e = new Ewah();
    e.set(3);
    expect(() => e.set(1)).toThrow("increasing");
  });
});

describe("the UNTR extension", () => {
  const ident = untrackedCacheIdent("/work/repo", "Linux");

  it("a cache without a root ends with a zero count (no trailing NUL of its own)", () => {
    const cache = newUntrackedCache(ident, 0);
    const bytes = encodeUntrackedCache(cache);
    expect(bytes[bytes.length - 1]).toBe(0);
    const back = parseUntrackedCache(bytes);
    expect(back && untrackedCacheIdentIs(back, ident)).toBe(true);
    expect(back?.root).toBeUndefined();
    expect(back?.excludePerDir).toBe(".gitignore");
    expect(
      Buffer.from(encodeUntrackedCache(back as UntrackedCache)).equals(Buffer.from(bytes)),
    ).toBe(true);
  });

  it("round-trips directories, untracked names, bitmaps, stats and exclude ids", () => {
    const cache = newUntrackedCache(ident, DIR_SHOW_OTHER_DIRECTORIES | DIR_HIDE_EMPTY_DIRECTORIES);
    cache.root = {
      name: "",
      untracked: ["z", "nested/"],
      dirs: [],
      valid: true,
      checkOnly: false,
      recurse: true,
      stat: {
        ctimeSec: 1,
        ctimeNsec: 2,
        mtimeSec: 3,
        mtimeNsec: 4,
        dev: 5,
        ino: 6,
        uid: 7,
        gid: 8,
        size: 4096,
      },
      excludeOid: EMPTY_BLOB_OID,
    };
    const a = lookupUntracked(cache, cache.root, "a");
    const b = lookupUntracked(cache, cache.root, "b/");
    expect(cache.root.dirs.map((d) => d.name)).toEqual(["a", "b"]);
    Object.assign(a, { recurse: true, valid: true, checkOnly: true, untracked: ["x", "y"] });
    // not reached by the last scan: not written
    Object.assign(b, { recurse: false });
    const bytes = encodeUntrackedCache(cache);
    const back = parseUntrackedCache(bytes) as UntrackedCache;
    expect(back.dirFlags).toBe(6);
    expect(back.root?.untracked).toEqual(["z", "nested/"]);
    expect(back.root?.stat.size).toBe(4096);
    expect(back.root?.excludeOid).toBe(EMPTY_BLOB_OID);
    expect(back.root?.dirs.map((d) => [d.name, d.valid, d.checkOnly, d.untracked])).toEqual([
      ["a", true, true, ["x", "y"]],
    ]);
    expect(Buffer.from(encodeUntrackedCache(back)).equals(Buffer.from(bytes))).toBe(true);
    // truncated or with a byte too many: no cache, as git reads none
    expect(parseUntrackedCache(bytes.subarray(0, bytes.length - 3))).toBeUndefined();
    expect(parseUntrackedCache(Uint8Array.from([...bytes.subarray(0, -1), 7, 0]))).toBeUndefined();
  });

  it("an invalid directory is written without its names", () => {
    const cache = newUntrackedCache(ident, 0);
    cache.root = { ...emptyDir(""), recurse: true, untracked: ["stale"], valid: false };
    const back = parseUntrackedCache(encodeUntrackedCache(cache));
    expect(back?.root?.untracked).toEqual([]);
    expect(back?.root?.valid).toBe(false);
  });

  it("an exclude file's id is that of its content with a newline added (git hashes its buffer)", async () => {
    expect(await excludeFileOid(new Uint8Array())).toBe(EMPTY_BLOB_OID);
    // `printf '*.o\n\n' | git hash-object --stdin`
    expect(await excludeFileOid(new TextEncoder().encode("*.o\n"))).toBe(
      "874c63cfa699b0cb28ada8b48e0f107ee5716f85",
    );
  });
});

function emptyDir(name: string) {
  return {
    name,
    untracked: [] as string[],
    dirs: [],
    valid: false,
    checkOnly: false,
    recurse: false,
    stat: {
      ctimeSec: 0,
      ctimeNsec: 0,
      mtimeSec: 0,
      mtimeNsec: 0,
      dev: 0,
      ino: 0,
      uid: 0,
      gid: 0,
      size: 0,
    },
    excludeOid: "0".repeat(40),
  };
}

describe("invalidation by index edits (untracked_cache_invalidate_path)", () => {
  const build = (flags: number) => {
    const cache = newUntrackedCache("x", flags);
    cache.root = { ...emptyDir(""), valid: true, recurse: true, untracked: ["r"] };
    const a = lookupUntracked(cache, cache.root, "a");
    Object.assign(a, { valid: true, recurse: true, untracked: ["f"] });
    const b = lookupUntracked(cache, a, "b");
    Object.assign(b, { valid: true, recurse: true, untracked: ["g"] });
    return { cache, root: cache.root, a, b };
  };

  it("-uall caches: only the directory holding the path", () => {
    const { cache, root, a, b } = build(0);
    invalidateUntrackedPath(cache, "a/b/g");
    expect([root.valid, a.valid, b.valid]).toEqual([true, true, false]);
    expect(b.untracked).toEqual([]);
    // a path below a directory the cache never reached: a hidden node, nothing written
    invalidateUntrackedPath(cache, "a/new/deep/file");
    expect(a.valid).toBe(true);
    expect(
      parseUntrackedCache(encodeUntrackedCache(cache))?.root?.dirs[0]?.dirs.map((d) => d.name),
    ).toEqual(["b"]);
  });

  it("caches of `normal` scans: every directory up to the root", () => {
    const { cache, root, a, b } = build(DIR_SHOW_OTHER_DIRECTORIES | DIR_HIDE_EMPTY_DIRECTORIES);
    invalidateUntrackedPath(cache, "a/b/g");
    expect([root.valid, a.valid, b.valid]).toEqual([false, false, false]);
  });
});

describe("IndexPathLookup", () => {
  const index = new IndexPathLookup([
    ".gitignore",
    "a.b",
    "a/x",
    "a/y/z",
    "a/y0",
    "a0",
    "b",
    "b",
    "deep/1/2/3",
  ]);

  it("names directly in a directory, subdirectories skipped", () => {
    expect([...index.trackedIn("")]).toEqual([".gitignore", "a.b", "a0", "b"]);
    expect([...index.trackedIn("a")]).toEqual(["x", "y0"]);
    expect([...index.trackedIn("a/y")]).toEqual(["z"]);
    expect([...index.trackedIn("deep")]).toEqual([]);
    expect([...index.trackedIn("none")]).toEqual([]);
  });

  it("whether entries lie below a directory", () => {
    expect(index.hasEntriesBelow("a")).toBe(true);
    expect(index.hasEntriesBelow("deep/1")).toBe(true);
    expect(index.hasEntriesBelow("a0")).toBe(false);
    expect(index.hasEntriesBelow("b")).toBe(false);
  });

  it("sorts paths given out of order", () => {
    expect([...new IndexPathLookup(["b/x", "a/y", "a/x"]).trackedIn("a")]).toEqual(["x", "y"]);
  });
});

/**
 * A simulated worktree: files and directories by path; a directory's mtime moves on when
 * an entry is added or removed in it, as on a real filesystem.
 */
class FakeTree implements UntrackedScanHost {
  readonly worktreePath = "/work/repo";
  files = new Map<string, string>();
  mtimes = new Map<string, number>();
  listed: string[] = [];
  ignoreReads: string[] = [];
  private clock = 1000;

  private dirsOf(path: string): string[] {
    const out: string[] = [];
    let at = path.lastIndexOf("/");
    while (at > 0) {
      out.push(path.slice(0, at));
      at = path.lastIndexOf("/", at - 1);
    }
    out.push("");
    return out;
  }
  private touch(path: string) {
    const slash = path.lastIndexOf("/");
    this.mtimes.set(slash < 0 ? "" : path.slice(0, slash), ++this.clock);
  }
  write(path: string, content = "x") {
    for (const d of this.dirsOf(path)) {
      if (!this.mtimes.has(d)) {
        this.mtimes.set(d, ++this.clock);
        if (d) this.touch(d);
      }
    }
    if (!this.files.has(path)) this.touch(path);
    this.files.set(path, content);
  }
  remove(path: string) {
    this.files.delete(path);
    this.touch(path);
  }
  async listDirectory(dir: string): Promise<DirectoryEntry[]> {
    this.listed.push(dir);
    const prefix = dir ? `${dir}/` : "";
    const names = new Map<string, DirectoryEntry["kind"]>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? "file" : "directory");
    }
    return [...names].map(([name, kind]) => ({ name, kind }));
  }
  async lstat(path: string): Promise<LinkStats | undefined> {
    const mtime = this.mtimes.get(path);
    if (mtime !== undefined) {
      return {
        kind: "directory",
        size: 0,
        statSize: 4096,
        lastModified: mtime * 1000,
        mtimeNs: 0,
        ctime: mtime * 1000,
        ctimeNs: 0,
        ino: 1,
      };
    }
    return this.files.has(path) ? { kind: "file", size: 1, lastModified: 0 } : undefined;
  }
  rules = new Map<string, string[]>();
  async loadIgnoreFile(dir: string) {
    this.ignoreReads.push(dir);
    const content = this.files.get(dir ? `${dir}/.gitignore` : ".gitignore");
    this.rules.set(dir, content ? content.split("\n").filter(Boolean) : []);
    return content === undefined
      ? ({ kind: "missing" } as const)
      : ({
          kind: "file",
          bytes: new TextEncoder().encode(content),
          stat: { kind: "file", size: content.length, lastModified: 0 },
        } as const);
  }
  isExcluded(path: string): boolean {
    const name = path.slice(path.lastIndexOf("/") + 1);
    for (const [dir, patterns] of this.rules) {
      if (dir && !path.startsWith(`${dir}/`)) continue;
      if (patterns.includes(name)) return true;
    }
    return false;
  }
  async isNestedRepository(path: string) {
    return this.files.has(`${path}/.git/HEAD`);
  }
}

describe("scanUntracked with the cache", () => {
  const tracked = new Set(["t1", "a/t2", "a/b/t3", "c/t4"]);
  const scan = (tree: FakeTree, cache?: UntrackedCache) => {
    const index = new IndexPathLookup([...tracked].sort());
    return scanUntracked(tree, {
      isTracked: (p) => tracked.has(p),
      trackedIn: (d) => index.trackedIn(d),
      indexDirectory: (d) => (index.hasEntriesBelow(d) ? "directory" : undefined),
      ...(cache ? { cache } : {}),
      indexSeconds: 100_000,
    });
  };
  const tree = () => {
    const t = new FakeTree();
    for (const p of tracked) t.write(p);
    t.write("u1");
    t.write("a/b/u2");
    t.write("new/dir/u3");
    t.write("ign/x");
    t.write(".gitignore", "ign\nskip.me\n");
    t.write("sub/.git/HEAD", "ref");
    return t;
  };

  it("finds what a plain scan finds, then reads no directory while nothing changed", async () => {
    const t = tree();
    const plain = await scan(t);
    expect(plain.paths).toEqual([".gitignore", "a/b/u2", "new/dir/u3", "sub/", "u1"]);
    const cache = newUntrackedCache("x", 0);
    const first = await scan(t, cache);
    expect(first.paths).toEqual(plain.paths);
    expect(cache.dirOpened).toBe(first.directoriesRead);
    // the next scan of an unchanged tree: everything from the cache
    const again = parseUntrackedCache(encodeUntrackedCache(cache)) as UntrackedCache;
    t.listed = [];
    const second = await scan(t, again);
    expect(second.paths).toEqual(plain.paths);
    expect(t.listed).toEqual([]);
    expect(again.dirOpened + again.dirInvalidated + again.gitignoreInvalidated).toBe(0);
  });

  it("reads again only the directories whose stat moved, and never reports stale files", async () => {
    const t = tree();
    const cache = newUntrackedCache("x", 0);
    await scan(t, cache);
    t.write("a/b/u5");
    t.remove("u1");
    t.listed = [];
    const result = await scan(t, cache);
    expect(result.paths).toEqual([".gitignore", "a/b/u2", "a/b/u5", "new/dir/u3", "sub/"]);
    expect(t.listed.sort()).toEqual(["", "a/b"]);
  });

  it("a .gitignore whose content changes invalidates its directory and those below it", async () => {
    const t = tree();
    const cache = newUntrackedCache("x", 0);
    await scan(t, cache);
    // edited in place: no directory stat moves
    t.files.set(".gitignore", "ign\nu2\n");
    t.listed = [];
    const result = await scan(t, cache);
    expect(result.paths).toEqual([".gitignore", "new/dir/u3", "sub/", "u1"]);
    expect(cache.gitignoreInvalidated).toBeGreaterThan(0);
    expect(t.listed).toContain("a/b");
  });
});
