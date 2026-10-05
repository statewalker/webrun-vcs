import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceRemotes } from "../src/index.js";
import { update } from "../src/index.js";
import { drain, sha256, tree } from "./helpers.js";

async function paths(files: import("../src/index.js").FilesApi): Promise<string[]> {
  const out: string[] = [];
  for await (const info of files.list("/", { recursive: true })) {
    if (info.kind === "file") out.push(info.path);
  }
  return out.sort();
}

describe("update — remote → local pull", () => {
  it("copies remote changes into the working tree and keeps local-only files", async () => {
    const working = tree({ "/local-only.txt": "keep" });
    const fileRemote = tree({ "/from-remote.txt": "new" });
    const ws: Workspace = { workingTree: working };
    const remotes: WorkspaceRemotes = {
      fileRemotes: new Map([["origin", fileRemote]]),
      historyRemotes: new Map(),
    };

    const events = await drain(update(ws, remotes, {}, { hashContent: sha256 }));

    // Remote file pulled in; local-only file preserved (copy, not mirror).
    expect(await paths(working)).toEqual(["/from-remote.txt", "/local-only.txt"]);
    expect(await paths(fileRemote)).toEqual(["/from-remote.txt"]); // remote untouched
    expect(events[0].type).toBe("scan");
    expect(events.some((e) => e.type === "transfer" && e.path === "/from-remote.txt")).toBe(true);
    expect(events.at(-1)?.type).toBe("checkpoint");
  });
});
