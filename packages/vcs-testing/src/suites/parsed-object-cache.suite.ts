/**
 * Conformance suite for the parsed-object caches of `createTrees` and `createCommits`: a tree
 * or commit read once is served from memory, yet never after the store removed it. gc,
 * prune and repack remove objects below the typed stores (a raw store of their own, the
 * object kernel, a pack set), not through `trees.remove` or `commits.remove`.
 */

import {
  type Commit,
  type Commits,
  createCommits,
  createTrees,
  type GitObjects,
  type Trees,
} from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

export interface ParsedObjectCacheTestContext {
  /** The repository's object kernel */
  objects: GitObjects;
  /**
   * Removes object `id` the way gc prunes it: through another handle on the same storage
   * (a second raw store over the same files, keys or rows), never through `objects`.
   */
  removeBehind(id: string): Promise<boolean>;
  cleanup?: () => Promise<void>;
}

export type ParsedObjectCacheTestFactory = () => Promise<ParsedObjectCacheTestContext>;

const enc = new TextEncoder();
const who = { name: "T", email: "t@example.com", timestamp: 1, tzOffset: "+0000" };

/**
 * @example
 * ```typescript
 * createParsedObjectCacheTests("Memory", async () => {
 *   const raw = new MemoryRawStorage();
 *   return { objects: createGitObjects(rawStorageStaging(raw)), removeBehind: (id) => raw.remove(id) };
 * });
 * ```
 */
export function createParsedObjectCacheTests(
  name: string,
  factory: ParsedObjectCacheTestFactory,
): void {
  describe(`parsed object caches [${name}]`, () => {
    let ctx: ParsedObjectCacheTestContext;
    let trees: Trees;
    let commits: Commits;
    let tree: string;
    let commit: string;

    async function collect(id: string) {
      const entries = await trees.load(id);
      if (!entries) return undefined;
      const out = [];
      for await (const e of entries) out.push(e);
      return out;
    }

    beforeEach(async () => {
      ctx = await factory();
      trees = createTrees(ctx.objects);
      commits = createCommits(ctx.objects);
      const blob = await ctx.objects.put("blob", 2, [enc.encode("x\n")]);
      tree = await trees.store([{ name: "x", mode: 0o100644, id: blob }]);
      const c: Commit = { tree, parents: [], author: who, committer: who, message: "m\n" };
      commit = await commits.store(c);
      // both are cached now
      expect(await collect(tree)).toHaveLength(1);
      expect((await commits.load(commit))?.tree).toBe(tree);
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    it("does not serve a tree or commit removed through the object kernel", async () => {
      expect(await ctx.objects.remove(tree)).toBe(true);
      expect(await ctx.objects.remove(commit)).toBe(true);
      expect(await collect(tree)).toBeUndefined();
      expect(await trees.getEntry(tree, "x")).toBeUndefined();
      expect(await commits.load(commit)).toBeUndefined();
      expect(await commits.getTree(commit)).toBeUndefined();
    });

    it("does not serve a tree or commit pruned through another handle on the storage", async () => {
      expect(await ctx.removeBehind(tree)).toBe(true);
      expect(await ctx.removeBehind(commit)).toBe(true);
      expect(await collect(tree)).toBeUndefined();
      expect(await commits.load(commit)).toBeUndefined();
    });

    it("still serves cached objects that stay stored after another removal", async () => {
      const other = await ctx.objects.put("blob", 2, [enc.encode("y\n")]);
      expect(await ctx.removeBehind(other)).toBe(true);
      expect(await collect(tree)).toHaveLength(1);
      expect((await commits.load(commit))?.tree).toBe(tree);
    });

    it("serves a tree written again after its removal", async () => {
      expect(await ctx.removeBehind(tree)).toBe(true);
      expect(await collect(tree)).toBeUndefined();
      const blob = await ctx.objects.put("blob", 2, [enc.encode("x\n")]);
      expect(await trees.store([{ name: "x", mode: 0o100644, id: blob }])).toBe(tree);
      expect(await ctx.objects.has(tree)).toBe(true);
      expect(await collect(tree)).toHaveLength(1);
    });

    it("does not serve a tree read through a quarantine that was discarded", async () => {
      if (!ctx.objects.beginQuarantine) return;
      const q = await ctx.objects.beginQuarantine();
      const qTrees = createTrees(q.objects);
      const blob = await q.objects.put("blob", 2, [enc.encode("q\n")]);
      const qTree = await qTrees.store([{ name: "q", mode: 0o100644, id: blob }]);
      expect(await qTrees.getEntry(qTree, "q")).toBeDefined();
      await q.discard();
      expect(await ctx.objects.has(qTree)).toBe(false);
      expect(await qTrees.getEntry(qTree, "q")).toBeUndefined();
    });
  });
}
