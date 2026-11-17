/**
 * git's `core.deltaBaseCacheLimit` sizes the delta base cache of the backend's pack set.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackFile } from "@statewalker/vcs-core";
import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend, readDeltaBaseCacheLimit } from "../../src/index.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "A U Thor",
  GIT_COMMITTER_EMAIL: "author@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, { cwd, input, env: GIT_ENV, encoding: "utf8" }).trim();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("readDeltaBaseCacheLimit", () => {
  it("reads sizes as git_parse_ulong: units, hex and octal; undefined when unset or bad", async () => {
    const files = createInMemoryFilesApi();
    const limitOf = async (value: string | undefined) => {
      const core = value === undefined ? "" : `\tdeltaBaseCacheLimit = ${value}\n`;
      await files.write(".git/config", [
        new TextEncoder().encode(`[core]\n\tbare = false\n${core}`),
      ]);
      return readDeltaBaseCacheLimit(files, ".git");
    };
    expect(await limitOf("96m")).toBe(96 * 2 ** 20);
    expect(await limitOf("512k")).toBe(512 * 1024);
    expect(await limitOf("1G")).toBe(2 ** 30);
    expect(await limitOf("0x400")).toBe(1024);
    expect(await limitOf("017")).toBe(15);
    expect(await limitOf("123456")).toBe(123456);
    expect(await limitOf(undefined)).toBeUndefined();
    expect(await limitOf("lots")).toBeUndefined();
    expect(await limitOf("-5")).toBeUndefined();
  });

  it("sizes the backend's base cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-base-cache-limit-"));
    dirs.push(dir);
    git(dir, ["init", "-q", "--initial-branch=main"]);
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}\n`).join("");
    const ids = [0, 1, 2].map((v) => git(dir, ["hash-object", "-w", "--stdin"], `${lines}v${v}\n`));
    const tree = git(dir, ["mktree"], ids.map((id, i) => `100644 blob ${id}\tf${i}\n`).join(""));
    git(dir, ["update-ref", "refs/heads/main", git(dir, ["commit-tree", tree, "-m", "three"])]);
    git(dir, ["repack", "-adfq"]);
    const peakAfterReads = async () => {
      const { objects, packs } = await createGitFilesBackend({
        files: createNodeFilesApi({ rootDir: dir }),
      });
      for (const id of ids) expect((await objects.get(id))?.size).toBe(lines.length + 3);
      const [pack] = (await packs.packs()) as PackFile[];
      return pack?.stats.peakCachedBytes;
    };
    // the default (96 MiB) keeps the bases of the two deltas' chains
    expect(await peakAfterReads()).toBeGreaterThan(0);
    // a budget below any object keeps only the most recent base, alone, as git's (and in a
    // buffer of its own: the default budget carves bases from 64 KiB slabs)
    git(dir, ["config", "core.deltaBaseCacheLimit", "16"]);
    expect(await peakAfterReads()).toBe(lines.length + 3);
  });
});
