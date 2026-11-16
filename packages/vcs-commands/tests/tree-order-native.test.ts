/**
 * Trees a commit, a merge and a cherry-pick write hold their entries in git's order (a tree
 * compares as its name plus "/"), so their ids are native git's: a directory `a` next to
 * files `a-`, `a.b` and `a0` sorts after `a-` and `a.b` and before `a0`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, gitOk, INTEROP_IDENT, openOurs } from "./merge-native-helpers.js";
import { applyFiles, buildHistory, type History } from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const NAMES = {
  "a/x": "x\n",
  "a-": "dash\n",
  "a.b": "dot\n",
  a0: "zero\n",
  "b-/y": "y\n",
  b: "b\n",
};

describeGit("tree entry order against native git", () => {
  let root: string;
  let n = 0;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tree-order-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const tree = (dir: string, rev = "HEAD") => gitOk(root, dir, "rev-parse", `${rev}^{tree}`).trim();
  const twins = (history: History) => {
    const nd = join(root, `n${n}`);
    const od = join(root, `o${n++}`);
    buildHistory(root, nd, history);
    buildHistory(root, od, history);
    return { nd, od };
  };

  it("a commit of a/x, a-, a.b, a0 writes git's tree", async () => {
    const nd = join(root, `n${n}`);
    const od = join(root, `o${n++}`);
    for (const dir of [nd, od]) {
      gitOk(root, root, "init", "-q", "-b", "main", dir);
      applyFiles(dir, NAMES);
    }
    gitOk(root, nd, "add", "-A");
    gitOk(root, nd, "commit", "-q", "-m", "m");
    const g = await openOurs(od);
    await g.add().addFilepattern(".").call();
    await g.commit().setMessage("m").call();
    expect(tree(od)).toBe(tree(nd));
  });

  it("a merge adding a- and a0 next to the directory a writes git's tree", async () => {
    const { nd, od } = twins({
      base: { "a/x": "x\n", "a.b": "dot\n" },
      main: { "a/x": "x2\n" },
      side: { "a-": "dash\n", a0: "zero\n", "a/y": "y\n" },
    });
    expect(git(root, nd, "merge", "--no-edit", "side").status).toBe(0);
    const g = await openOurs(od);
    const r = await g
      .merge()
      .include("side")
      .setAuthor(INTEROP_IDENT)
      .setCommitter(INTEROP_IDENT)
      .call();
    expect(r.status).toBe("merged");
    expect(tree(od)).toBe(tree(nd));
  });

  it("a cherry-pick adding a- next to the directory a writes git's tree", async () => {
    const { nd, od } = twins({
      base: { "a/x": "x\n", "a.b": "dot\n" },
      main: { "a/x": "x2\n" },
      side: { "a-": "dash\n" },
    });
    expect(git(root, nd, "cherry-pick", "side").status).toBe(0);
    const g = await openOurs(od);
    await g.cherryPick().include("side").setCommitter(INTEROP_IDENT).call();
    expect(tree(od)).toBe(tree(nd));
  });
});
