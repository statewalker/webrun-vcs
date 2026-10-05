import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceRemotes } from "../src/index.js";
import { publish } from "../src/index.js";
import { drain, FakeGitRemote, FakeRepository, sha256, tree } from "./helpers.js";

function setup(dirty: boolean) {
  const repo = new FakeRepository();
  repo.dirty = dirty;
  const gitRemote = new FakeGitRemote(repo);
  const ws: Workspace = { workingTree: tree({ "/a.txt": "one" }), repository: repo };
  const remotes: WorkspaceRemotes = {
    fileRemotes: new Map([["origin", tree()]]),
    historyRemotes: new Map([["origin", gitRemote]]),
  };
  return { repo, gitRemote, ws, remotes };
}

describe("publish — policy flags honored independently", () => {
  it("commitOnlyWhenChanged skips the commit when nothing changed", async () => {
    const { repo, ws, remotes } = setup(false);
    const events = await drain(
      publish(
        ws,
        remotes,
        { commitAfterSync: true, commitOnlyWhenChanged: true, pushAfterCommit: true },
        {
          hashContent: sha256,
        },
      ),
    );
    expect(repo.commitCalls).toBe(0);
    expect(events.some((e) => e.type === "skipped" && e.step === "commit")).toBe(true);
    // No commit ⇒ nothing to push.
    expect(events.some((e) => e.type === "push")).toBe(false);
  });

  it("commitOnlyWhenChanged still commits when there are changes", async () => {
    const { repo, ws, remotes } = setup(true);
    await drain(
      publish(
        ws,
        remotes,
        { commitAfterSync: true, commitOnlyWhenChanged: true },
        { hashContent: sha256 },
      ),
    );
    expect(repo.commitCalls).toBe(1);
  });

  it("pushAfterCommit:false commits but skips the push", async () => {
    const { repo, gitRemote, ws, remotes } = setup(true);
    const events = await drain(
      publish(
        ws,
        remotes,
        { commitAfterSync: true, pushAfterCommit: false },
        { hashContent: sha256 },
      ),
    );
    expect(repo.commitCalls).toBe(1);
    expect(gitRemote.pushCalls.length).toBe(0);
    expect(events.some((e) => e.type === "push")).toBe(false);
  });

  it("commitAfterSync:false skips both commit and push (sync only)", async () => {
    const { repo, gitRemote, ws, remotes } = setup(true);
    await drain(publish(ws, remotes, { pushAfterCommit: true }, { hashContent: sha256 }));
    expect(repo.commitCalls).toBe(0);
    expect(gitRemote.pushCalls.length).toBe(0);
  });
});
