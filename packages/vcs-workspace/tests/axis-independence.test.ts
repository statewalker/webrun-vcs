import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceRemotes } from "../src/index.js";
import { publish } from "../src/index.js";
import { drain, FakeGitRemote, FakeRepository, fingerprint, sha256, tree } from "./helpers.js";

describe("publish — axis independence", () => {
  it("a sync-only run (no repository, no history remotes) mirrors files and records a checkpoint", async () => {
    const working = tree({ "/a.txt": "one", "/b.txt": "two" });
    const fileRemote = tree();
    const ws: Workspace = { workingTree: working }; // NO repository
    const remotes: WorkspaceRemotes = {
      fileRemotes: new Map([["origin", fileRemote]]),
      historyRemotes: new Map(),
    };
    const events = await drain(
      publish(
        ws,
        remotes,
        { commitAfterSync: true, pushAfterCommit: true },
        { hashContent: sha256 },
      ),
    );
    expect(await fingerprint(fileRemote)).toEqual(await fingerprint(working));
    expect(events.some((e) => e.type === "commit")).toBe(false);
    const cp = events.find((e) => e.type === "checkpoint");
    if (cp?.type !== "checkpoint") throw new Error("no checkpoint");
    expect(cp.checkpoint.commit).toBeUndefined();
    expect(cp.checkpoint.fileRemotes.origin).toBe(cp.checkpoint.workingTreeManifest);
  });

  it("a commit-only run (no file remotes) commits and pushes without any file sync", async () => {
    const repo = new FakeRepository();
    const gitRemote = new FakeGitRemote(repo);
    const ws: Workspace = { workingTree: tree({ "/a.txt": "one" }), repository: repo };
    const remotes: WorkspaceRemotes = {
      fileRemotes: new Map(), // NO file remotes
      historyRemotes: new Map([["origin", gitRemote]]),
    };
    const events = await drain(
      publish(
        ws,
        remotes,
        { commitAfterSync: true, pushAfterCommit: true },
        { hashContent: sha256 },
      ),
    );
    expect(events.some((e) => e.type === "scan")).toBe(false); // no file sync happened
    expect(repo.commitCalls).toBe(1);
    expect(gitRemote.pushCalls.length).toBe(1);
  });
});
