import { describe, expect, it } from "vitest";
import { buildSyncOptions } from "../src/index.js";
import { sha256 } from "./helpers.js";

describe("baseline rule — no commit id is ever the files-sync anchor/baseline", () => {
  it("buildSyncOptions carries the injected hashContent and NO anchor / commit-derived baseline", () => {
    const commitId = "commit-deadbeef";
    const syncOpts = buildSyncOptions(sha256, { commitAfterSync: true, pushAfterCommit: true }, {});

    // The file sync uses the file axis' own identity (hashContent), never a commit.
    expect(syncOpts.hashContent).toBe(sha256);
    // No SyncAnchor is seeded, and no commit-derived pairKey is passed.
    expect("anchorStore" in syncOpts).toBe(false);
    expect(syncOpts.pairKey).toBeUndefined();
    // The commit id appears nowhere in the sync options object.
    expect(
      JSON.stringify(Object.values(syncOpts).filter((v) => typeof v === "string")),
    ).not.toContain(commitId);
  });

  it("passes through the policy verify mode but nothing commit-shaped", () => {
    const syncOpts = buildSyncOptions(sha256, { verify: "content-hash" }, {});
    expect(syncOpts.verify).toBe("content-hash");
    expect("anchorStore" in syncOpts).toBe(false);
  });
});
