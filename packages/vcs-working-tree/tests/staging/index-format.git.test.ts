/**
 * The streamed index encoder against native git: an index we write (GitStaging
 * streams `encodeIndexFile` into `FilesApi.write`) lists the same stage entries
 * as git's own and leaves `git status` clean.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryFilesApi, type FilesApi } from "@statewalker/vcs-utils/files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitStaging, parseIndexFile } from "../../src/staging/index.js";

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
  execFileSync("git", args, { cwd, env: GIT_ENV, maxBuffer: 1 << 30 })
    .toString()
    .trim();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A FilesApi that records how many chunks each write received. */
function countingWrites(files: FilesApi): { files: FilesApi; chunks: Map<string, number> } {
  const chunks = new Map<string, number>();
  const wrapped = Object.create(files) as FilesApi;
  wrapped.write = async (path, content) => {
    let n = 0;
    async function* counted() {
      for await (const c of content) {
        n++;
        yield c;
      }
    }
    await files.write(path, counted());
    chunks.set(path, n);
  };
  return { files: wrapped, chunks };
}

describe("GitStaging writes an index native git reads", () => {
  it("git ls-files --stage and git status agree after we rewrite git's index", async () => {
    const dir = mkdtempSync(join(tmpdir(), "index-format-git-"));
    dirs.push(dir);
    git(dir, ["init", "-q", "--initial-branch=main", "."]);
    for (let i = 0; i < 2000; i++) {
      const path = join(dir, `d${i % 5}`, `f-${i}.txt`);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `file ${i}\n`);
    }
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "fixture"]);
    const stageBefore = git(dir, ["ls-files", "--stage"]);

    const { files, chunks } = countingWrites(createNodeFilesApi({ rootDir: dir }));
    const staging = createGitStaging(files, ".git/index");
    await staging.read();
    await staging.write();

    // streamed in several chunks, not one buffer
    expect(chunks.get(".git/index")).toBeGreaterThan(2);
    // git's own TREE extension is not written, so the file differs, but its entries do not
    const ours = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
    expect(ours.entries).toHaveLength(2001);
    expect(ours.extensions).toEqual([]);
    expect(git(dir, ["ls-files", "--stage"])).toBe(stageBefore);
    expect(git(dir, ["status", "--porcelain"])).toBe("");
    git(dir, ["fsck", "--strict"]);
  });

  it("streams a small index too, header to checksum", async () => {
    const { files, chunks } = countingWrites(createInMemoryFilesApi());
    const staging = createGitStaging(files, "index");
    await staging.write();
    expect(chunks.get("index")).toBeGreaterThanOrEqual(2);
    const empty = await parseIndexFile(await collect(files, "index"));
    expect(empty.entries).toEqual([]);
  });
});

async function collect(files: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of files.read(path)) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of parts) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
