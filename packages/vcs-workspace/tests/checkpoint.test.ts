import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceRemotes } from "../src/index.js";
import { checkpoint, publish } from "../src/index.js";
import { drain, FakeRepository, sha256, tree } from "./helpers.js";

describe("checkpoint() — standalone correspondence snapshot", () => {
  it("records the working-tree manifest, HEAD commit, and each file remote's manifest", async () => {
    const repo = new FakeRepository();
    await repo.commit({}); // establish a HEAD (commit-1)

    const working = tree({ "/a.txt": "one" });
    const fileRemote = tree({ "/a.txt": "one" }); // in sync with working
    const ws: Workspace = { workingTree: working, repository: repo };
    const remotes: WorkspaceRemotes = {
      fileRemotes: new Map([["origin", fileRemote]]),
      historyRemotes: new Map(),
    };

    const cp = await checkpoint(ws, remotes, { hashContent: sha256, now: "2026-07-28T00:00:00Z" });
    expect(cp.commit).toBe("commit-1");
    expect(cp.createdAt).toBe("2026-07-28T00:00:00Z");
    // Working tree and remote hold identical content ⇒ identical manifest.
    expect(cp.fileRemotes.origin).toBe(cp.workingTreeManifest);
  });

  it("a checkpoint from a fresh publish round-trips the same manifest for identical content", async () => {
    const working = tree({ "/a.txt": "one" });
    const ws: Workspace = { workingTree: working };
    const remotes: WorkspaceRemotes = {
      fileRemotes: new Map([["origin", tree()]]),
      historyRemotes: new Map(),
    };
    const events = await drain(publish(ws, remotes, {}, { hashContent: sha256 }));
    const cp = events.find((e) => e.type === "checkpoint");
    if (cp?.type !== "checkpoint") throw new Error("no checkpoint");
    // Recomputing the working-tree manifest yields the same id (deterministic).
    const cp2 = await checkpoint(ws, remotes, { hashContent: sha256 });
    expect(cp2.workingTreeManifest).toBe(cp.checkpoint.workingTreeManifest);
  });
});
