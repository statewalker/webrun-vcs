/**
 * Path-level three-way merge semantics of RebaseCommand.
 *
 * Every fixture builds a real base commit with real file content: the
 * `createInitializedGit()` initial commit carries the well-known EMPTY tree,
 * which a content-addressed store answers for without ever having received it,
 * so assertions anchored on it pass vacuously.
 *
 * Shape of each fixture:
 *
 *     base (real files)
 *      |\
 *      | \
 *    onto  feature   <- HEAD is on `feature`; we rebase it onto `onto`
 *
 * so `replayCommit` sees base = feature's parent tree, ours = feature's tree,
 * theirs = onto's tree, and the per-path merge loop actually runs (the loop is
 * short-circuited whenever two of the three trees are identical).
 */

import type { History, ObjectId } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import { RebaseStatus } from "../src/index.js";
import {
  addFile,
  backends,
  createCommit,
  createInitializedGitFromFactory,
  removeFile,
} from "./test-helper.js";

const TREE_MODE = 0o040000;

/** Read a tree recursively into a flat `path -> content` map. */
async function readTreeFiles(
  repository: History,
  treeId: ObjectId,
  prefix = "",
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = await repository.trees.load(treeId);
  if (!entries) return out;

  for await (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if ((entry.mode & TREE_MODE) === TREE_MODE) {
      for (const [p, c] of await readTreeFiles(repository, entry.id, path)) {
        out.set(p, c);
      }
    } else {
      const blob = await repository.blobs.load(entry.id);
      const chunks: Uint8Array[] = [];
      if (blob) {
        for await (const chunk of blob) chunks.push(chunk);
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const joined = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        joined.set(chunk, at);
        at += chunk.length;
      }
      out.set(path, new TextDecoder().decode(joined));
    }
  }
  return out;
}

/** Read a tree recursively into a flat `path -> mode` map. */
async function readTreeModes(
  repository: History,
  treeId: ObjectId,
  prefix = "",
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const entries = await repository.trees.load(treeId);
  if (!entries) return out;

  for await (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if ((entry.mode & TREE_MODE) === TREE_MODE) {
      for (const [p, m] of await readTreeModes(repository, entry.id, path)) out.set(p, m);
    } else {
      out.set(path, entry.mode);
    }
  }
  return out;
}

/** Stage `path` with the given content and an explicit file mode. */
async function addFileWithMode(
  wc: WorkingCopy,
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  const data = new TextEncoder().encode(content);
  const objectId = await wc.history.blobs.store([data]);
  const editor = wc.checkout.staging.createEditor();
  editor.add({
    path,
    apply: () => ({ path, mode, objectId, stage: 0, size: data.length, mtime: Date.now() }),
  });
  await editor.finish();
}

/** Read the flat file map of a commit. */
async function readCommitFiles(
  repository: History,
  commitId: ObjectId,
): Promise<Map<string, string>> {
  const commit = await repository.commits.load(commitId);
  if (!commit) throw new Error(`commit not found: ${commitId}`);
  return readTreeFiles(repository, commit.tree);
}

describe.each(backends)("RebaseCommand three-way merge ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  type Changes = {
    add?: Record<string, string>;
    remove?: string[];
    /** path -> [content, mode]: re-stage a path with an explicit file mode. */
    chmod?: Record<string, [string, number]>;
  };

  /**
   * Build the diamond above.
   *
   * `baseFiles` is committed as a real commit (never the empty initial tree).
   * `onto` and `feature` are each derived from that base by re-reading the
   * base tree into staging and applying `add` / `remove` / `chmod` mutations.
   *
   * Leaves HEAD on the feature branch and returns the two tip commit ids.
   */
  async function buildDiamond(opts: {
    baseFiles: Record<string, string>;
    onto: Changes;
    feature: Changes;
  }) {
    const init = await createInitializedGitFromFactory(factory);
    const { git, workingCopy, repository, initialCommitId } = init;
    cleanup = init.cleanup;

    const baseCommit = await createCommit(workingCopy, "base", opts.baseFiles, [initialCommitId]);
    const baseTree = (await repository.commits.load(baseCommit))?.tree as ObjectId;

    async function branchFrom(message: string, changes: Changes): Promise<ObjectId> {
      // Reset staging to the base tree so each side starts from `base`.
      await workingCopy.checkout.staging.readTree(repository.trees, baseTree);
      for (const path of changes.remove ?? []) {
        await removeFile(workingCopy, path);
      }
      for (const [path, content] of Object.entries(changes.add ?? {})) {
        await addFile(workingCopy, path, content);
      }
      for (const [path, [content, mode]] of Object.entries(changes.chmod ?? {})) {
        await addFileWithMode(workingCopy, path, content, mode);
      }
      return createCommit(workingCopy, message, {}, [baseCommit]);
    }

    const ontoCommit = await branchFrom("onto", opts.onto);
    const featureCommit = await branchFrom("feature", opts.feature);

    // `createCommit` moves HEAD's branch; park `onto` on its own ref and leave
    // HEAD (refs/heads/main) on the feature tip.
    await repository.refs.set("refs/heads/onto", ontoCommit);
    await repository.refs.set("refs/heads/main", featureCommit);

    return { git, repository, baseCommit, ontoCommit, featureCommit };
  }

  it("does not conflict when both sides make the identical change to a path", async () => {
    const { git, repository, ontoCommit } = await buildDiamond({
      baseFiles: { "keep.txt": "keep", "shared.txt": "v1" },
      // Both sides change shared.txt to exactly "v2"; the extra file on each
      // side keeps the two trees distinct so the per-path loop actually runs.
      onto: { add: { "shared.txt": "v2", "onto-only.txt": "o" } },
      feature: { add: { "shared.txt": "v2", "feature-only.txt": "f" } },
    });

    const result = await git.rebase().setUpstream(ontoCommit).call();

    expect(result.conflicts).toBeUndefined();
    expect(result.status).toBe(RebaseStatus.OK);

    const files = await readCommitFiles(repository, result.newHead as ObjectId);
    expect(files.get("shared.txt")).toBe("v2");
    expect(files.get("keep.txt")).toBe("keep");
    expect(files.get("onto-only.txt")).toBe("o");
    expect(files.get("feature-only.txt")).toBe("f");
  });

  it("takes the feature side when only the feature changed a path", async () => {
    const { git, repository, ontoCommit } = await buildDiamond({
      baseFiles: { "keep.txt": "keep", "one-sided.txt": "v1" },
      onto: { add: { "onto-only.txt": "o" } },
      feature: { add: { "one-sided.txt": "v2" } },
    });

    const result = await git.rebase().setUpstream(ontoCommit).call();

    expect(result.conflicts).toBeUndefined();
    expect(result.status).toBe(RebaseStatus.OK);

    const files = await readCommitFiles(repository, result.newHead as ObjectId);
    expect(files.get("one-sided.txt")).toBe("v2");
    expect(files.get("onto-only.txt")).toBe("o");
  });

  it("takes the onto side when only onto changed a path", async () => {
    const { git, repository, ontoCommit } = await buildDiamond({
      baseFiles: { "keep.txt": "keep", "one-sided.txt": "v1" },
      onto: { add: { "one-sided.txt": "v2" } },
      feature: { add: { "feature-only.txt": "f" } },
    });

    const result = await git.rebase().setUpstream(ontoCommit).call();

    expect(result.conflicts).toBeUndefined();
    expect(result.status).toBe(RebaseStatus.OK);

    const files = await readCommitFiles(repository, result.newHead as ObjectId);
    expect(files.get("one-sided.txt")).toBe("v2");
    expect(files.get("feature-only.txt")).toBe("f");
  });

  it("conflicts when both sides change a path differently", async () => {
    const { git, ontoCommit } = await buildDiamond({
      baseFiles: { "keep.txt": "keep", "shared.txt": "v1" },
      onto: { add: { "shared.txt": "onto-version" } },
      feature: { add: { "shared.txt": "feature-version" } },
    });

    const result = await git.rebase().setUpstream(ontoCommit).call();

    expect(result.status).toBe(RebaseStatus.STOPPED);
    expect(result.conflicts).toEqual(["shared.txt"]);
  });

  it("does not conflict on add/add of identical content", async () => {
    const { git, repository, ontoCommit } = await buildDiamond({
      baseFiles: { "keep.txt": "keep" },
      onto: { add: { "added.txt": "same", "onto-only.txt": "o" } },
      feature: { add: { "added.txt": "same", "feature-only.txt": "f" } },
    });

    const result = await git.rebase().setUpstream(ontoCommit).call();

    expect(result.conflicts).toBeUndefined();
    expect(result.status).toBe(RebaseStatus.OK);

    const files = await readCommitFiles(repository, result.newHead as ObjectId);
    expect(files.get("added.txt")).toBe("same");
  });

  it("conflicts on add/add of different content", async () => {
    const { git, ontoCommit } = await buildDiamond({
      baseFiles: { "keep.txt": "keep" },
      onto: { add: { "added.txt": "onto-version" } },
      feature: { add: { "added.txt": "feature-version" } },
    });

    const result = await git.rebase().setUpstream(ontoCommit).call();

    expect(result.status).toBe(RebaseStatus.STOPPED);
    expect(result.conflicts).toEqual(["added.txt"]);
  });

  it("conflicts on delete/modify", async () => {
    const { git, ontoCommit } = await buildDiamond({
      baseFiles: { "keep.txt": "keep", "contested.txt": "v1" },
      onto: { add: { "contested.txt": "v2" } },
      feature: { remove: ["contested.txt"] },
    });

    const result = await git.rebase().setUpstream(ontoCommit).call();

    expect(result.status).toBe(RebaseStatus.STOPPED);
    expect(result.conflicts).toEqual(["contested.txt"]);
  });

  it("keeps a one-sided mode change (same content, exec bit set on the feature)", async () => {
    const { git, repository, ontoCommit } = await buildDiamond({
      baseFiles: { "keep.txt": "keep", "script.sh": "#!/bin/sh" },
      onto: { add: { "onto-only.txt": "o" } },
      // Content is byte-identical to base: the ONLY change is the mode, so a
      // blob-id comparison sees "unchanged" and silently drops it.
      feature: { chmod: { "script.sh": ["#!/bin/sh", FileMode.EXECUTABLE_FILE] } },
    });

    const result = await git.rebase().setUpstream(ontoCommit).call();

    expect(result.conflicts).toBeUndefined();
    expect(result.status).toBe(RebaseStatus.OK);

    const commit = await repository.commits.load(result.newHead as ObjectId);
    const modes = await readTreeModes(repository, commit?.tree as ObjectId);
    expect(modes.get("script.sh")).toBe(FileMode.EXECUTABLE_FILE);
  });

  it("does not conflict when both sides delete the same path", async () => {
    const { git, repository, ontoCommit } = await buildDiamond({
      baseFiles: { "keep.txt": "keep", "doomed.txt": "gone" },
      onto: { remove: ["doomed.txt"], add: { "onto-only.txt": "o" } },
      feature: { remove: ["doomed.txt"], add: { "feature-only.txt": "f" } },
    });

    const result = await git.rebase().setUpstream(ontoCommit).call();

    expect(result.conflicts).toBeUndefined();
    expect(result.status).toBe(RebaseStatus.OK);

    const files = await readCommitFiles(repository, result.newHead as ObjectId);
    expect(files.has("doomed.txt")).toBe(false);
    expect(files.get("keep.txt")).toBe("keep");
    expect(files.get("onto-only.txt")).toBe("o");
    expect(files.get("feature-only.txt")).toBe("f");
  });

  // A path cannot be a file and a directory at once. When one side adds the
  // file `a` and the other adds `a/b`, both take the "only one side changed"
  // branch and land in the merged entry set together; building a tree from
  // that set writes `a` as a file and then overwrites it with the `a/` subtree,
  // so the file's content is gone and the rebase still reports OK. Native git
  // reports `CONFLICT (file/directory)` and never loses the file.
  describe("file/directory collisions", () => {
    it("conflicts when the feature adds the file `a` and onto adds `a/b`", async () => {
      const { git, ontoCommit } = await buildDiamond({
        baseFiles: { "keep.txt": "keep" },
        onto: { add: { "a/b": "directory side" } },
        feature: { add: { a: "file side" } },
      });

      const result = await git.rebase().setUpstream(ontoCommit).call();

      // Before the fix: OK, with a new head whose tree held only `a/b` -
      // "file side" was silently dropped.
      expect(result.status).toBe(RebaseStatus.STOPPED);
      expect(result.conflicts).toEqual(["a"]);
      expect(result.newHead).toBeUndefined();
    });

    it("conflicts when onto adds the file `a` and the feature adds `a/b`", async () => {
      const { git, ontoCommit } = await buildDiamond({
        baseFiles: { "keep.txt": "keep" },
        onto: { add: { a: "file side" } },
        feature: { add: { "a/b": "directory side" } },
      });

      const result = await git.rebase().setUpstream(ontoCommit).call();

      expect(result.status).toBe(RebaseStatus.STOPPED);
      expect(result.conflicts).toEqual(["a"]);
      expect(result.newHead).toBeUndefined();
    });

    it("conflicts when the colliding directory is nested several levels deep", async () => {
      const { git, ontoCommit } = await buildDiamond({
        baseFiles: { "keep.txt": "keep" },
        onto: { add: { "a/b/c/d": "deep" } },
        feature: { add: { a: "file side" } },
      });

      const result = await git.rebase().setUpstream(ontoCommit).call();

      // The collision is between `a` and a path four levels below it; only the
      // topmost component actually collides.
      expect(result.status).toBe(RebaseStatus.STOPPED);
      expect(result.conflicts).toEqual(["a"]);
      expect(result.newHead).toBeUndefined();
    });

    it("reports every colliding path when one merge has several", async () => {
      const { git, ontoCommit } = await buildDiamond({
        baseFiles: { "keep.txt": "keep" },
        onto: { add: { "x/1": "x dir", "y/2": "y dir" } },
        feature: { add: { x: "x file", y: "y file" } },
      });

      const result = await git.rebase().setUpstream(ontoCommit).call();

      expect(result.status).toBe(RebaseStatus.STOPPED);
      expect(result.conflicts).toEqual(["x", "y"]);
      expect(result.newHead).toBeUndefined();
    });

    it("reports collisions contributed by either side in a stable order", async () => {
      const { git, ontoCommit } = await buildDiamond({
        baseFiles: { "keep.txt": "keep" },
        // `d` is a file on onto and a directory on the feature; `m` is the
        // other way round. The merged set therefore reaches the collision
        // check as `d/1, m, d, m/1`, so reporting it in encounter order would
        // give `["m", "d"]`.
        onto: { add: { d: "d file", "m/1": "m dir" } },
        feature: { add: { "d/1": "d dir", m: "m file" } },
      });

      const result = await git.rebase().setUpstream(ontoCommit).call();

      expect(result.status).toBe(RebaseStatus.STOPPED);
      expect(result.conflicts).toEqual(["d", "m"]);
      expect(result.newHead).toBeUndefined();
    });

    it("does not conflict when a file merely shares a name prefix with a directory", async () => {
      const { git, repository, ontoCommit } = await buildDiamond({
        baseFiles: { "keep.txt": "keep" },
        // `ab` starts with the directory name `a` but is not inside `a/`:
        // matching merged paths against directory names by bare `startsWith`
        // would wrongly report `ab` as colliding.
        onto: { add: { "a/b": "inside a" } },
        feature: { add: { ab: "not inside a" } },
      });

      const result = await git.rebase().setUpstream(ontoCommit).call();

      expect(result.conflicts).toBeUndefined();
      expect(result.status).toBe(RebaseStatus.OK);

      const files = await readCommitFiles(repository, result.newHead as ObjectId);
      expect(files.get("ab")).toBe("not inside a");
      expect(files.get("a/b")).toBe("inside a");
    });

    it("does not conflict when a file merely shares a name prefix with another file", async () => {
      const { git, repository, ontoCommit } = await buildDiamond({
        baseFiles: { "keep.txt": "keep" },
        // `ab` starts with the file name `a`, but `a` is not a directory
        // prefix of it: asking only whether some other merged path starts
        // with `a`, without requiring the `/`, would wrongly report `a` as
        // colliding. `c/d` keeps a genuine directory in the merged set.
        onto: { add: { ab: "sibling", "c/d": "in a directory" } },
        feature: { add: { a: "file" } },
      });

      const result = await git.rebase().setUpstream(ontoCommit).call();

      expect(result.conflicts).toBeUndefined();
      expect(result.status).toBe(RebaseStatus.OK);

      const files = await readCommitFiles(repository, result.newHead as ObjectId);
      expect(files.get("a")).toBe("file");
      expect(files.get("ab")).toBe("sibling");
      expect(files.get("c/d")).toBe("in a directory");
    });
  });
});
