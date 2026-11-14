/**
 * The object kernel over git's loose-object directory: the shared contract on
 * an in-memory and a real file system, and interop with native git.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitObjects } from "@statewalker/vcs-core";
import { createGitObjectsTests } from "@statewalker/vcs-testing";
import { createInMemoryFilesApi } from "@statewalker/vcs-utils/files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { filesStagingStore } from "../../../src/storage/loose/index.js";

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
};
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, { cwd, input, env: GIT_ENV, encoding: "utf8" }).trim();

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function gitRepo(): { dir: string; files: ReturnType<typeof createNodeFilesApi> } {
  const dir = tempDir("loose-git-");
  git(dir, ["init", "-q", "--initial-branch=main"]);
  return { dir, files: createNodeFilesApi({ rootDir: dir }) };
}

createGitObjectsTests("Files (in memory)", async () => {
  const store = filesStagingStore(createInMemoryFilesApi(), "/repo/.git/objects");
  return { objects: createGitObjects(store), store };
});

createGitObjectsTests("Files (Node)", async () => {
  const dir = tempDir("loose-node-");
  const store = filesStagingStore(createNodeFilesApi({ rootDir: dir }), ".git/objects");
  return { objects: createGitObjects(store), store };
});

const enc = new TextEncoder();
const text = async (s: AsyncIterable<Uint8Array>) => {
  let out = "";
  for await (const c of s) out += new TextDecoder().decode(c, { stream: true });
  return out;
};

describe("loose objects and native git", () => {
  it("git reads what the kernel writes (cat-file, fsck)", async () => {
    const { dir, files } = gitRepo();
    const objects = createGitObjects(filesStagingStore(files, ".git/objects"));
    const blob = await objects.put("blob", 6, [enc.encode("hello\n")]);
    const treeBody = new Uint8Array([
      ...enc.encode("100644 hello.txt\0"),
      ...(blob.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)),
    ]);
    const tree = await objects.put("tree", treeBody.length, [treeBody]);
    const commitBody = enc.encode(
      `tree ${tree}\nauthor A U Thor <author@example.com> 1700000000 +0000\n` +
        "committer A U Thor <author@example.com> 1700000000 +0000\n\ninitial\n",
    );
    const commit = await objects.put("commit", commitBody.length, [commitBody]);
    expect(commit).toBe("91e296066e54b1080fcd3bee892880098880dbb1");
    expect(git(dir, ["cat-file", "-p", blob])).toBe("hello");
    expect(git(dir, ["cat-file", "-t", commit])).toBe("commit");
    git(dir, ["update-ref", "refs/heads/main", commit]);
    git(dir, ["fsck", "--full", "--strict"]);
  });

  it("reads objects git wrote at every compression level, byte for byte", async () => {
    for (const level of ["0", "1", "9"]) {
      const { dir, files } = gitRepo();
      git(dir, ["config", "core.compression", level]);
      writeFileSync(join(dir, "big.txt"), "line of text\n".repeat(5000));
      const id = git(dir, ["hash-object", "-w", "big.txt"]);
      const objects = createGitObjects(filesStagingStore(files, ".git/objects"));
      const obj = await objects.get(id, { verify: true });
      expect(obj?.size, level).toBe(65000);
      expect(await text(obj?.content ?? []), level).toBe("line of text\n".repeat(5000));
    }
  });

  it("lists only object ids in a real .git/objects (not pack/, info/ or temporaries)", async () => {
    const { dir, files } = gitRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-q", "-m", "one"]);
    git(dir, ["repack", "-q"]); // a pack in objects/pack, keeping the loose objects
    writeFileSync(join(dir, ".git/objects/tmp_obj_crash"), "partial");
    const loose = git(dir, ["count-objects", "-v"]);
    expect(loose).toMatch(/in-pack: [1-9]/);
    const expected = readdirSync(join(dir, ".git/objects"))
      .filter((d) => /^[0-9a-f]{2}$/.test(d))
      .flatMap((d) => readdirSync(join(dir, ".git/objects", d)).map((f) => d + f))
      .sort();
    const objects = createGitObjects(filesStagingStore(files, ".git/objects"));
    const listed: string[] = [];
    for await (const id of objects.list()) listed.push(id);
    expect(listed).toEqual(expected);
    expect(listed.length).toBe(3); // blob, tree, commit
  });

  it("sweepStaged removes only stale temporaries", async () => {
    const { dir, files } = gitRepo();
    const store = filesStagingStore(files, ".git/objects");
    const objects = createGitObjects(store);
    const id = await objects.put("blob", 2, [enc.encode("a\n")]);
    const old = join(dir, ".git/objects/tmp_obj_old");
    const oldInFanout = join(dir, ".git/objects", id.slice(0, 2), "tmp_obj_old2");
    const fresh = join(dir, ".git/objects/tmp_obj_fresh");
    for (const p of [old, oldInFanout, fresh]) writeFileSync(p, "partial");
    const hourAgo = new Date(Date.now() - 3600_000);
    utimesSync(old, hourAgo, hourAgo);
    utimesSync(oldInFanout, hourAgo, hourAgo);
    expect(await store.sweepStaged(60_000)).toBe(2);
    expect(readdirSync(join(dir, ".git/objects")).filter((n) => n.startsWith("tmp_obj_"))).toEqual([
      "tmp_obj_fresh",
    ]);
    expect(await objects.has(id)).toBe(true);
  });

  it("a failed put leaves no temporary behind", async () => {
    const { dir, files } = gitRepo();
    const objects = createGitObjects(filesStagingStore(files, ".git/objects"));
    await expect(objects.put("blob", 10, [enc.encode("short")])).rejects.toMatchObject({
      name: "SizeMismatchError",
    });
    expect(readdirSync(join(dir, ".git/objects")).filter((n) => n.startsWith("tmp_obj_"))).toEqual(
      [],
    );
  });
});
