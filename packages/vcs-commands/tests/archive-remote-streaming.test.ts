/**
 * upload-archive streams (statewalker/webrun-vcs#413): `git archive --remote` of a repository
 * holding a blob far larger than `core.bigFileThreshold`, served in process, its client
 * paused. git's upload-archive passes the writer's output on through a 16 KiB buffer; ours
 * must not hold the archive either, on the server or in the client's `setOutput`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { archiveEnv, openArchiveRepo } from "./archive-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const MiB = 1 << 20;
const BLOB_SIZE = 128 * MiB;

let home = "";
let repo = "";

function git(args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd: repo,
    env: archiveEnv(home),
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeGit("git archive --remote streams the archive (#413)", () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "archive-remote-stream-"));
    repo = join(home, "repo");
    mkdirSync(repo);
    git(["init", "-q"]);
    const pattern = Buffer.from("0123456789abcdef".repeat(4096));
    const big = Buffer.alloc(BLOB_SIZE, pattern);
    writeFileSync(join(repo, "big"), big);
    writeFileSync(join(repo, "small"), "small\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "big"]);
    git(["config", "core.bigFileThreshold", "1m"]);
    rmSync(join(repo, "big"));
  });
  afterAll(() => removeTempDir(home), CLEANUP_TIMEOUT);

  it("holds neither the archive nor its packets while the client waits", async () => {
    const expected = createHash("sha1")
      .update(git(["archive", "-v", "HEAD"]))
      .digest("hex");
    const g = await openArchiveRepo(home, repo);
    let received = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused: () => void = () => {};
    const pausedNow = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const hash = createHash("sha1");
    const baseline = process.memoryUsage().arrayBuffers;
    const call = g
      .archiveRemote()
      .setRemote(".")
      .addArguments("-v", "HEAD")
      .setOutput(async (chunk) => {
        hash.update(chunk);
        received += chunk.length;
        if (received >= MiB && received - chunk.length < MiB) {
          paused();
          await gate;
        }
      })
      .call();
    await pausedNow;
    // a server that runs ahead has made the archive by now (an archive of 128 MiB takes
    // well under this), and holds it
    await tick(1500);
    const held = process.memoryUsage().arrayBuffers - baseline;
    release();
    const result = await call;
    expect(result.exitCode).toBe(0);
    expect(result.archive.length).toBe(0);
    expect(result.stderr).toBe("remote: big        \nremote: small        \n");
    expect(received).toBeGreaterThan(BLOB_SIZE);
    expect(hash.digest("hex")).toBe(expected);
    // queues of a few MiB and their garbage, never the 128 MiB archive
    expect(held).toBeLessThan(48 * MiB);
  }, 120_000);
});
