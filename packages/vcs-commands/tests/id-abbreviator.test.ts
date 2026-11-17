/**
 * Abbreviated ids count the objects once per command: `approximateCount` lists every object
 * on key-value, SQL and memory stores, so a command printing several ids (merge's
 * `Updating a..b`, rebase's todo backup) must not pay for a scan per id.
 */
import { createMemoryHistory, type GitObjects, type History } from "@statewalker/vcs-core";
import { MemoryStagingStore } from "@statewalker/vcs-store-mem";
import { MemoryCheckout, MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { describe, expect, it } from "vitest";

import { createIdAbbreviator } from "../src/commands/core-config.js";
import { Git, MergeStatus } from "../src/index.js";
import { createMockWorktree } from "./mock-worktree-store.js";
import { testAuthor } from "./test-helper.js";

/** A memory working copy whose object store counts its full scans. */
async function countingRepository() {
  const history: History = createMemoryHistory();
  await history.initialize();
  const objects = history.objects as GitObjects;
  const scans = { count: 0, list: 0 };
  const approximateCount = objects.approximateCount?.bind(objects);
  if (approximateCount) {
    objects.approximateCount = () => {
      scans.count++;
      return approximateCount();
    };
  }
  const list = objects.list.bind(objects);
  objects.list = () => {
    scans.list++;
    return list();
  };
  const workingCopy = new MemoryWorkingCopy({
    history,
    checkout: new MemoryCheckout({ staging: new MemoryStagingStore() }),
    worktree: createMockWorktree(),
  });
  const tree = await history.trees.store([]);
  const commit = (message: string, parents: string[]) =>
    history.commits.store({
      tree,
      parents,
      author: testAuthor(),
      committer: testAuthor(),
      message,
    });
  const c1 = await commit("c1", []);
  const c2 = await commit("c2", [c1]);
  const c3 = await commit("c3", [c2]);
  await history.refs.set("refs/heads/main", c1);
  await history.refs.set("refs/heads/feat", c3);
  await history.refs.setSymbolic("HEAD", "refs/heads/main");
  await workingCopy.checkout.staging.readTree(history.trees, tree);
  return { workingCopy, scans, ids: [c1, c2, c3] };
}

describe("abbreviated ids, one object count per command", () => {
  it("an abbreviator counts the objects once for any number of ids", async () => {
    const { workingCopy, scans, ids } = await countingRepository();
    const abbrev = createIdAbbreviator(workingCopy);
    const shown: string[] = [];
    for (const id of ids) shown.push(await abbrev.abbreviate(id));
    await abbrev.lengths(ids);
    expect(shown).toEqual(ids.map((id) => id.slice(0, 7)));
    expect(scans.count + scans.list).toBe(1);
  });

  it("a fast-forward merge prints `Updating a..b` with one scan", async () => {
    const { workingCopy, scans, ids } = await countingRepository();
    const result = await Git.fromWorkingCopy(workingCopy).merge().include("feat").call();
    expect(result.status).toBe(MergeStatus.FAST_FORWARD);
    expect(result.output?.[0]).toBe(`Updating ${ids[0]?.slice(0, 7)}..${ids[2]?.slice(0, 7)}`);
    expect(scans.count + scans.list).toBe(1);
  });
});
