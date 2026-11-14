/**
 * The transport's `fetch` against git-http-backend, with the pack streamed (`onPack`) from the
 * response body, through the sideband demux, into vcs-core's `importPack`: every object git
 * has arrives byte for byte, and the pack is never collected (`packData` stays empty).
 *
 * Skips when git-http-backend is not available.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryHistoryWithOperations } from "@statewalker/vcs-core";
import { fetch as transportFetch } from "@statewalker/vcs-transport";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type GitHttpBackendServer,
  gitHttpBackendAvailable,
  startGitHttpBackendServer,
} from "./helpers/git-http-backend-server.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, maxBuffer: 1 << 28 });

const describeWithGit = gitHttpBackendAvailable() ? describe : describe.skip;

describeWithGit("fetch streams the pack into importPack (git-http-backend)", () => {
  let server: GitHttpBackendServer;
  const dirs: string[] = [];

  beforeAll(async () => {
    server = await startGitHttpBackendServer();
  });
  afterAll(async () => {
    await server.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("imports every object byte for byte, without collecting the pack", async () => {
    const url = await server.createBareRepo("streamed.git");
    const work = mkdtempSync(join(tmpdir(), "streamed-fetch-"));
    dirs.push(work);
    git(work, ["init", "-q", "--initial-branch=main", "."]);
    for (let c = 0; c < 15; c++) {
      writeFileSync(join(work, "a.txt"), `${"line\n".repeat(200)}change ${c}\n`);
      writeFileSync(join(work, `f${c}.txt`), `file ${c}\n`);
      git(work, ["add", "-A"]);
      git(work, ["commit", "-q", "-m", `commit ${c}`]);
    }
    git(work, ["push", "-q", join(server.reposDir, "streamed.git"), "main"]);
    const ids = git(work, ["rev-list", "--objects", "--all"])
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(0, 40));

    const history = createMemoryHistoryWithOperations();
    await history.initialize();
    let imported = 0;
    const result = await transportFetch({
      url,
      onPack: async (pack) => {
        imported = (await history.serialization.importPack(pack)).objectsImported;
      },
    });

    expect(result.packData.length).toBe(0);
    expect(result.bytesReceived).toBeGreaterThan(0);
    expect(imported).toBe(ids.length);
    for (const id of ids) expect(await history.objects?.has(id)).toBe(true);
    const head = git(work, ["rev-parse", "main"]).toString().trim();
    const raw = new Uint8Array(git(work, ["cat-file", "commit", head]));
    const stored = history.objects?.getRaw(head);
    const parts: Uint8Array[] = [];
    for await (const c of stored ?? []) parts.push(c);
    const body = Buffer.concat(parts);
    expect(new Uint8Array(body.subarray(body.indexOf(0) + 1))).toEqual(raw);
  });
});
