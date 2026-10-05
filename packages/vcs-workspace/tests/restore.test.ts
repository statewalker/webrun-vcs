import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceCheckpoint } from "../src/index.js";
import { restore } from "../src/index.js";
import { drain, FakeRepository, tree } from "./helpers.js";

const CP: WorkspaceCheckpoint = {
  id: "cp1",
  workingTreeManifest: "wt-manifest",
  commit: "commit-7",
  fileRemotes: { origin: "wt-manifest" },
  historyRemotes: { origin: "commit-7" },
  createdAt: "2026-07-28T00:00:00Z",
};

describe("restore — drive back to a recorded correspondence", () => {
  it("checks the working tree out to the checkpoint's commit", async () => {
    const repo = new FakeRepository();
    const ws: Workspace = { workingTree: tree(), repository: repo };
    const events = await drain(restore(ws, CP));
    expect(repo.checkoutCalls).toEqual(["commit-7"]); // reads the commit from the record alone
    expect(events.some((e) => e.type === "commit" && e.commit === "commit-7")).toBe(true);
    expect(events.at(-1)?.type).toBe("checkpoint");
  });

  it("without a repository there is nothing to check out", async () => {
    const ws: Workspace = { workingTree: tree() };
    const events = await drain(restore(ws, CP));
    expect(events.some((e) => e.type === "skipped" && e.step === "checkout")).toBe(true);
  });
});
