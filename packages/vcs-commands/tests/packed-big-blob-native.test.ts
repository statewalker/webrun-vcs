/**
 * Packed blobs above the pack reader's 1 GiB `maxObjectSize` (statewalker/webrun-vcs#477):
 * native `git add` packs a file above core.bigFileThreshold (`index_stream` →
 * `stream_to_pack`), and git streams such a blob back (`open_istream`) in `cat-file`,
 * `archive` and checkout. Ours reads its size from the entry header and streams its content;
 * only what must be held (delta bases and results) stays limited. Native git decides every
 * expected result: sizes, types, bytes and the checked-out file.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { catFileArgs, catFileTwin } from "./cat-file-native-support.js";
import { compatibilityOf, Shell } from "./describe-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** Just above the reader's limit: a 1 GiB delta base or result would be refused. */
const SIZE = 2 ** 30 + 2 ** 20;
const MARKS = [0, 12345, 2 ** 30 - 1, SIZE - 1];

/** The SHA-1 of what `git <args>` writes on stdout in `dir`, read as it comes. */
async function nativeDigest(shell: Shell, dir: string, args: string[]): Promise<string> {
  const child = spawn("git", args, { cwd: dir, env: { ...nativeGitEnv(shell.home), TZ: "UTC" } });
  const hash = createHash("sha1");
  for await (const chunk of child.stdout) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

describeGit("packed blobs above 1 GiB, native (statewalker/webrun-vcs#477)", () => {
  let root = "";
  let shell: Shell;
  let repo = "";
  let blob = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "packed-big-blob-"));
    shell = new Shell(root);
    repo = join(root, "repo");
    shell.ok(root, "init", "-q", "-b", "main", repo);
    // a sparse file of zeros with a few marks, packed by `git add` (above core.bigFileThreshold)
    const path = join(repo, "big");
    const fd = openSync(path, "w");
    for (const at of MARKS) writeSync(fd, Buffer.from([0x5a]), 0, 1, at);
    closeSync(fd);
    shell.ok(repo, "add", "big");
    shell.tick();
    shell.ok(repo, "commit", "-q", "-m", "big");
    blob = shell.ok(repo, "rev-parse", "HEAD:big").trim();
    // the blob is in a pack, not loose
    expect(shell.ok(repo, "count-objects", "-v")).toMatch(/^in-pack: [1-9]/m);
    expect(shell.git(repo, ["cat-file", "-e", blob]).status).toBe(0);
  }, 300_000);
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it('t1006-cat-file.sh: "Type of $type is correct", "Size of $type is correct" of a packed blob above 1 GiB', async () => {
    for (const argv of [["-t", blob], ["-s", blob], ["-e", blob], ["--batch-check"]]) {
      const input = argv[0] === "--batch-check" ? `${blob}\n` : undefined;
      const twin = await catFileTwin(shell, repo, argv, input);
      expect({ ...twin.ours, stdout: twin.ours.stdout.toString() }).toEqual({
        ...twin.native,
        stdout: twin.native.stdout.toString(),
      });
    }
  });

  it('t1006-cat-file.sh: "Content of $type is correct" of a packed blob above 1 GiB, streamed', async () => {
    const native = await nativeDigest(shell, repo, ["cat-file", "blob", blob]);
    const git = await openOurs(repo);
    const hash = createHash("sha1");
    let largest = 0;
    const r = await catFileArgs(git, ["blob", blob], undefined, compatibilityOf(shell))
      .setStdout((chunk) => {
        hash.update(chunk);
        largest = Math.max(largest, chunk.length);
      })
      .call();
    expect(r.exitCode).toBe(0);
    expect(hash.digest("hex")).toBe(native);
    // streamed: never handed over whole
    expect(largest).toBeLessThan(SIZE);
  }, 300_000);

  it('t5000-tar-tree.sh: "generate tar with huge size" of a packed blob above 1 GiB', async () => {
    const args = ["--mtime=2002-02-02T02:02:02-0200", "--format=tar", "HEAD"];
    const native = await nativeDigest(shell, repo, ["archive", ...args]);
    const git = await openOurs(repo);
    const cmd = git
      .archive()
      .setLocalTimezone(() => 0)
      .setMtime("2002-02-02T02:02:02-0200")
      .setFormat("tar")
      .setTree("HEAD");
    const hash = createHash("sha1");
    for await (const chunk of cmd.callStream()) hash.update(chunk);
    expect(hash.digest("hex")).toBe(native);
  }, 300_000);

  it("checkout of a packed blob above 1 GiB writes the file native git wrote", async () => {
    const path = join(repo, "big");
    rmSync(path);
    const git = await openOurs(repo);
    await git.checkout().addPath("big").call();
    expect(statSync(path).size).toBe(SIZE);
    // native git hashes the file ours wrote to the blob it packed
    expect(shell.ok(repo, "hash-object", "big").trim()).toBe(blob);
    expect(shell.ok(repo, "status", "--porcelain")).toBe("");
  }, 300_000);
});
