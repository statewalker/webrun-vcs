import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceRemotes } from "../src/index.js";
import { publish } from "../src/index.js";
import { drain, FakeGitRemote, FakeRepository, sha256, tree } from "./helpers.js";

const FULL = { commitAfterSync: true, pushAfterCommit: true } as const;

describe("publish — resumable", () => {
  it("interrupt after commit before push, then resume at push with no duplicate commit", async () => {
    const repo = new FakeRepository();
    const gitRemote = new FakeGitRemote(repo);
    gitRemote.failNext = 1; // first push throws

    const ws: Workspace = { workingTree: tree({ "/a.txt": "one" }), repository: repo };
    const remotes: WorkspaceRemotes = {
      fileRemotes: new Map([["origin", tree()]]),
      historyRemotes: new Map([["origin", gitRemote]]),
    };

    // First run: sync + commit succeed, push fails → progress checkpoint recorded.
    const first = await drain(publish(ws, remotes, FULL, { hashContent: sha256 }));
    expect(repo.commitCalls).toBe(1);
    expect(first.some((e) => e.type === "failed" && e.step === "push:origin")).toBe(true);
    const cp1 = first.find((e) => e.type === "checkpoint");
    if (cp1?.type !== "checkpoint") throw new Error("no checkpoint");
    expect(cp1.checkpoint.commit).toBe("commit-1");
    expect(cp1.checkpoint.historyRemotes.origin).toBeUndefined(); // push not done

    // Second run resumes from the checkpoint: no new commit, push retried + succeeds.
    const second = await drain(
      publish(ws, remotes, FULL, { hashContent: sha256, resume: cp1.checkpoint }),
    );
    expect(repo.commitCalls).toBe(1); // NOT re-committed
    expect(second.some((e) => e.type === "commit")).toBe(false);
    expect(second.some((e) => e.type === "skipped" && e.step === "sync:origin")).toBe(true);
    const cp2 = second.find((e) => e.type === "checkpoint");
    if (cp2?.type !== "checkpoint") throw new Error("no checkpoint");
    expect(cp2.checkpoint.commit).toBe("commit-1");
    expect(cp2.checkpoint.historyRemotes.origin).toBe("commit-1"); // now pushed
    expect(gitRemote.pushed).toBe("commit-1");
  });
});
