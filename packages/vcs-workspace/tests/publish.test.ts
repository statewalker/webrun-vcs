import { describe, expect, it } from "vitest";
import type { SyncVersioningPolicy, Workspace, WorkspaceRemotes } from "../src/index.js";
import { publish } from "../src/index.js";
import {
  drain,
  FakeGitRemote,
  FakeRepository,
  fingerprint,
  memContentStore,
  putObject,
  sha256,
  tree,
} from "./helpers.js";

const FULL: SyncVersioningPolicy = {
  commitAfterSync: true,
  pushAfterCommit: true,
};

describe("publish — happy path", () => {
  it("syncs working→fileRemote, commits, uploads large objects, pushes, and records the correspondence", async () => {
    const repo = new FakeRepository();
    const localObjects = memContentStore();
    const remoteObjects = memContentStore();
    const objId = await putObject(localObjects, "a-large-object-payload");

    const working = tree({ "/a.txt": "one", "/b.txt": "two" });
    const fileRemote = tree();
    const gitRemote = new FakeGitRemote(repo, remoteObjects);

    const ws: Workspace = { workingTree: working, repository: repo, largeObjects: localObjects };
    const remotes: WorkspaceRemotes = {
      fileRemotes: new Map([["origin", fileRemote]]),
      historyRemotes: new Map([["origin", gitRemote]]),
    };

    const events = await drain(
      publish(ws, remotes, FULL, {
        hashContent: sha256,
        largeObjects: [objId],
        now: "2026-07-28T00:00:00Z",
      }),
    );

    // Axis A: files landed on the remote.
    expect(await fingerprint(fileRemote)).toEqual(await fingerprint(working));
    // Axis B: exactly one commit + one push.
    expect(repo.commitCalls).toBe(1);
    expect(gitRemote.pushCalls.length).toBe(1);
    // Large object uploaded (and now present on the remote store).
    expect(await remoteObjects.has(objId)).toBe(true);
    // Checkpoint ties the manifest ↔ commit and records the remotes.
    const cp = events.find((e) => e.type === "checkpoint");
    if (cp?.type !== "checkpoint") throw new Error("no checkpoint");
    expect(cp.checkpoint.commit).toBe("commit-1");
    expect(cp.checkpoint.historyRemotes.origin).toBe("commit-1");
    expect(cp.checkpoint.fileRemotes.origin).toBe(cp.checkpoint.workingTreeManifest);
    expect(cp.checkpoint.createdAt).toBe("2026-07-28T00:00:00Z");
  });

  it("emits the step events in order: scan → transfer* → commit → upload → push → checkpoint", async () => {
    const repo = new FakeRepository();
    const localObjects = memContentStore();
    const objId = await putObject(localObjects, "payload");
    const gitRemote = new FakeGitRemote(repo, memContentStore());

    const ws: Workspace = {
      workingTree: tree({ "/a.txt": "one" }),
      repository: repo,
      largeObjects: localObjects,
    };
    const remotes: WorkspaceRemotes = {
      fileRemotes: new Map([["origin", tree()]]),
      historyRemotes: new Map([["origin", gitRemote]]),
    };

    const events = await drain(
      publish(ws, remotes, FULL, { hashContent: sha256, largeObjects: [objId] }),
    );
    const order = events.map((e) => e.type);
    expect(order[0]).toBe("scan");
    expect(order).toContain("transfer");
    expect(order.indexOf("commit")).toBeGreaterThan(order.indexOf("scan"));
    expect(order.indexOf("upload")).toBeGreaterThan(order.indexOf("commit"));
    expect(order.indexOf("push")).toBeGreaterThan(order.indexOf("upload"));
    expect(order.at(-1)).toBe("checkpoint");
  });
});

describe("publish — correspondence", () => {
  it("answers 'which commit == the synced file state' from the checkpoint alone", async () => {
    const repo = new FakeRepository();
    const working = tree({ "/x.txt": "hello" });
    const ws: Workspace = { workingTree: working, repository: repo };
    const remotes: WorkspaceRemotes = {
      fileRemotes: new Map([["origin", tree()]]),
      historyRemotes: new Map(),
    };
    const events = await drain(
      publish(ws, remotes, { commitAfterSync: true }, { hashContent: sha256 }),
    );
    const cp = events.find((e) => e.type === "checkpoint");
    if (cp?.type !== "checkpoint") throw new Error("no checkpoint");
    // Both halves of the correspondence are in the record — no git read needed.
    expect(cp.checkpoint.commit).toBe("commit-1");
    expect(cp.checkpoint.workingTreeManifest).toBeTruthy();
    // The manifest is the file-state identity, independent of the commit id.
    expect(cp.checkpoint.workingTreeManifest).not.toBe(cp.checkpoint.commit);
  });
});
