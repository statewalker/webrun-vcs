/**
 * The streamed index encoder against native git: an index we write (GitStaging
 * streams `encodeIndexFile` into `FilesApi.write`) lists the same stage entries
 * as git's own and leaves `git status` clean.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // the entries did not change, so git's own TREE extension is kept as it was
    const ours = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
    expect(ours.entries).toHaveLength(2001);
    expect(ours.extensions).toEqual(["TREE"]);
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

describe("GitStaging rewrites git's index through index.lock, keeping what still applies", () => {
  /** A repository whose index holds a resolved conflict (REUC) and the untracked cache (UNTR). */
  function resolvedConflictRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "index-ext-git-"));
    dirs.push(dir);
    git(dir, ["init", "-q", "--initial-branch=main", "."]);
    git(dir, ["config", "core.untrackedCache", "true"]);
    writeFileSync(join(dir, "f.txt"), "base\n");
    writeFileSync(join(dir, "g.txt"), "g\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    git(dir, ["checkout", "-q", "-b", "side"]);
    writeFileSync(join(dir, "f.txt"), "side\n");
    git(dir, ["commit", "-q", "-am", "side"]);
    git(dir, ["checkout", "-q", "main"]);
    writeFileSync(join(dir, "f.txt"), "main\n");
    git(dir, ["commit", "-q", "-am", "main"]);
    try {
      git(dir, ["merge", "-q", "side"]);
    } catch {
      // the expected conflict
    }
    writeFileSync(join(dir, "f.txt"), "resolved\n");
    git(dir, ["add", "f.txt"]);
    git(dir, ["status", "--porcelain", "-uall"]); // writes UNTR
    return dir;
  }

  it("keeps resolve-undo data when the entries change; native git reads the index", async () => {
    const dir = resolvedConflictRepo();
    const undoBefore = git(dir, ["ls-files", "--resolve-undo"]);
    expect(undoBefore.split("\n")).toHaveLength(3);
    const before = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
    expect(before.extensions).toContain("REUC");
    expect(before.extensions).toContain("UNTR");

    writeFileSync(join(dir, "h.txt"), "h\n");
    const hId = git(dir, ["hash-object", "-w", "h.txt"]);
    const staging = createGitStaging(createNodeFilesApi({ rootDir: dir }), ".git/index");
    await staging.read();
    await staging.setEntry({ path: "h.txt", mode: 0o100644, objectId: hId });
    await staging.write();

    expect(existsSync(join(dir, ".git/index.lock"))).toBe(false);
    const after = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
    // the entries changed: the cache-tree and untracked cache go, resolve-undo stays
    expect(after.extensions).toEqual(["REUC"]);
    expect(git(dir, ["ls-files", "--resolve-undo"])).toBe(undoBefore);
    expect(git(dir, ["ls-files", "--stage", "h.txt"])).toBe(`100644 ${hId} 0\th.txt`);
    git(dir, ["status", "--porcelain"]);
    git(dir, ["fsck", "--strict"]);
  });

  it("keeps every extension unchanged when the entries do not change", async () => {
    const dir = resolvedConflictRepo();
    const before = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
    const staging = createGitStaging(createNodeFilesApi({ rootDir: dir }), ".git/index");
    await staging.read();
    await staging.write();
    const after = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
    expect(after.extensions).toEqual(before.extensions.filter((s) => s !== "EOIE" && s !== "IEOT"));
    for (const ext of after.extensionData) {
      const old = before.extensionData.find((e) => e.signature === ext.signature);
      expect(old && Buffer.from(old.data).equals(Buffer.from(ext.data)), ext.signature).toBe(true);
    }
  });

  it("drops the resolve-undo record of a path that is no longer in the index", async () => {
    const dir = resolvedConflictRepo();
    const staging = createGitStaging(createNodeFilesApi({ rootDir: dir }), ".git/index");
    await staging.read();
    await staging.removeEntry("f.txt");
    await staging.write();
    const after = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
    expect(after.extensions).toEqual([]);
    expect(git(dir, ["ls-files", "--resolve-undo"])).toBe("");
  });

  it("refuses to rewrite a split index (required 'link' extension)", async () => {
    const dir = resolvedConflictRepo();
    git(dir, ["update-index", "--split-index"]);
    const before = readFileSync(join(dir, ".git/index"));
    expect((await parseIndexFile(new Uint8Array(before))).extensions).toContain("link");
    const staging = createGitStaging(createNodeFilesApi({ rootDir: dir }), ".git/index");
    await staging.read();
    await expect(staging.write()).rejects.toThrow("required extension 'link'");
    expect(readFileSync(join(dir, ".git/index")).equals(before)).toBe(true);
    expect(existsSync(join(dir, ".git/index.lock"))).toBe(false);
  });

  it("refuses to write while native git holds index.lock", async () => {
    const dir = resolvedConflictRepo();
    const before = readFileSync(join(dir, ".git/index"));
    writeFileSync(join(dir, ".git/index.lock"), "");
    const staging = createGitStaging(createNodeFilesApi({ rootDir: dir }), ".git/index");
    await staging.read();
    await staging.removeEntry("g.txt");
    await expect(staging.write()).rejects.toThrow("index.lock': File exists");
    expect(readFileSync(join(dir, ".git/index")).equals(before)).toBe(true);
    rmSync(join(dir, ".git/index.lock"));
  });
});
