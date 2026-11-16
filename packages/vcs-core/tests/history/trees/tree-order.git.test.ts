/**
 * Tree entry order is git's `base_name_compare`: a tree compares as its name plus "/". A tree
 * `a` and a file `a-` used to compare equal, so the encoding (and the tree id) depended on the
 * order the entries came in. The ids are checked against native `git mktree`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectTreeBytes,
  compareTreeEntries,
  createGitObjects,
  createTrees,
  FileMode,
  MemoryRawStorage,
  rawStorageStaging,
  serializeTree,
  type TreeEntry,
} from "../../../src/index.js";

const BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const file = (name: string): TreeEntry => ({ mode: FileMode.REGULAR_FILE, name, id: BLOB });
const dir = (name: string): TreeEntry => ({ mode: FileMode.TREE, name, id: TREE });

const CASES: Record<string, TreeEntry[]> = {
  "tree a among a-, a.b, a0": [dir("a"), file("a-"), file("a.b"), file("a0")],
  "file a among trees a-, a.b, a0": [file("a"), dir("a-"), dir("a.b"), dir("a0")],
  "tree and file sharing a prefix with '/'-neighbours": [
    dir("x"),
    file("x!"),
    file("x-"),
    file("x."),
    file("x0"),
    dir("x-y"),
    file("xa"),
  ],
  "gitlink a is not a tree": [
    { mode: FileMode.GITLINK, name: "a", id: BLOB },
    file("a-"),
    file("a.b"),
    dir("a0"),
  ],
};

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const typeOf = (mode: number) =>
  mode === FileMode.TREE ? "tree" : mode === FileMode.GITLINK ? "commit" : "blob";

describe("compareTreeEntries", () => {
  it("compares a tree as its name plus '/'", () => {
    expect(compareTreeEntries(dir("a"), file("a-"))).toBeGreaterThan(0);
    expect(compareTreeEntries(dir("a"), file("a.b"))).toBeGreaterThan(0);
    expect(compareTreeEntries(dir("a"), file("a0"))).toBeLessThan(0);
    expect(compareTreeEntries(file("a"), file("a-"))).toBeLessThan(0);
    // a file and a tree of one name are not equal: the file first
    expect(compareTreeEntries(file("a"), dir("a"))).toBeLessThan(0);
    expect(compareTreeEntries(dir("a"), dir("a"))).toBe(0);
  });

  it("compares UTF-8 bytes, not UTF-16 code units", () => {
    // U+FF5E is EF BD 9E; U+1F600 is F0 9F 98 80 (a surrogate pair, 0xD83D first, in UTF-16)
    expect(compareTreeEntries(file("～"), file("\u{1f600}"))).toBeLessThan(0);
  });
});

const describeGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return describe;
  } catch {
    return describe.skip;
  }
})();

describeGit("tree ids in any input order match git mktree", () => {
  let root: string;
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    LANG: "C",
    LC_ALL: "C",
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tree-order-"));
    execFileSync("git", ["init", "-q", root], { env });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function mktree(entries: TreeEntry[]): string {
    const input = entries
      .map((e) => `${e.mode.toString(8).padStart(6, "0")} ${typeOf(e.mode)} ${e.id}\t${e.name}\n`)
      .join("");
    return execFileSync("git", ["mktree", "--missing"], { cwd: root, env, input })
      .toString()
      .trim();
  }

  for (const [name, entries] of Object.entries(CASES)) {
    it(name, async () => {
      const native = mktree(entries);
      const trees = createTrees(createGitObjects(rawStorageStaging(new MemoryRawStorage())));
      const ids = new Set<string>();
      const encodings = new Set<string>();
      for (const order of permutations(entries)) {
        ids.add(await trees.store(order));
        encodings.add(hex(await collectTreeBytes(order)));
        encodings.add(hex(serializeTree(order)));
      }
      expect([...ids]).toEqual([native]);
      expect(encodings.size).toBe(1);
      // and read back in that order
      const names: string[] = [];
      for await (const e of (await trees.load(native)) ?? []) names.push(e.name);
      expect(names).toEqual([...entries].sort(compareTreeEntries).map((e) => e.name));
    });
  }
});
