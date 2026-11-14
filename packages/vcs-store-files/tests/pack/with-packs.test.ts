/**
 * The git-files backend reads packed objects through `withPacks` and writes
 * loose objects git accepts.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend } from "../../src/index.js";

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
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "with-packs-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "--initial-branch=main"]);
  return dir;
}
const text = async (s: AsyncIterable<Uint8Array>) => {
  let out = "";
  for await (const c of s) out += new TextDecoder().decode(c, { stream: true });
  return out;
};

describe("createGitFilesBackend over packs (withPacks)", () => {
  it("reads a repository whose objects are all packed", async () => {
    const dir = repo();
    const blob = git(dir, ["hash-object", "-w", "--stdin"], "packed content\n");
    const tree = git(dir, ["mktree"], `100644 blob ${blob}\tf.txt\n`);
    const commit = git(dir, ["commit-tree", tree, "-m", "packed"]);
    git(dir, ["update-ref", "refs/heads/main", commit]);
    git(dir, ["gc", "-q", "--prune=now"]);
    const loose = readdirSync(join(dir, ".git/objects")).filter((d) => /^[0-9a-f]{2}$/.test(d));
    expect(loose).toEqual([]); // everything is in the pack

    const { history, objects } = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: dir }),
    });
    expect((await history.commits.load(commit))?.message).toBe("packed\n");
    expect(await text((await history.blobs.load(blob)) ?? [])).toBe("packed content\n");
    expect(await objects.has(blob)).toBe(true);
    expect(await objects.has("0".repeat(40))).toBe(false);
    const obj = await objects.get(blob, { verify: true });
    expect(obj).toMatchObject({ type: "blob", size: 15 });
    expect(await text(obj?.content ?? [])).toBe("packed content\n");
    expect(await text(objects.getRaw(blob))).toBe("blob 15\0packed content\n");
    const listed: string[] = [];
    for await (const id of objects.list()) listed.push(id);
    expect(listed.sort()).toEqual([blob, tree, commit].sort());
  });

  it("does not write a loose copy of an object received while already packed", async () => {
    const dir = repo();
    const blob = git(dir, ["hash-object", "-w", "--stdin"], "x\n");
    git(dir, ["pack-objects", "-q", ".git/objects/pack/pack"], `${blob}\n`);
    git(dir, ["prune-packed"]);
    expect(readdirSync(join(dir, ".git/objects")).filter((d) => /^[0-9a-f]{2}$/.test(d))).toEqual(
      [],
    );
    const { objects } = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: dir }),
    });
    await objects.putRaw(blob, [new TextEncoder().encode("blob 2\0x\n")]);
    expect(readdirSync(join(dir, ".git/objects")).filter((d) => /^[0-9a-f]{2}$/.test(d))).toEqual(
      [],
    );
  });

  it("writes objects git accepts (fsck --full --strict)", async () => {
    const dir = repo();
    const { history } = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: dir }),
    });
    const content = new TextEncoder().encode("hello\n");
    const blob = await history.blobs.store([content], content.length);
    const tree = await history.trees.store([{ mode: 0o100644, name: "hello.txt", id: blob }]);
    const who = {
      name: "A U Thor",
      email: "author@example.com",
      timestamp: 1700000000,
      tzOffset: "+0000",
    };
    const commit = await history.commits.store({
      tree,
      parents: [],
      author: who,
      committer: who,
      message: "initial\n",
    });
    expect(commit).toBe("91e296066e54b1080fcd3bee892880098880dbb1");
    git(dir, ["update-ref", "refs/heads/main", commit]);
    git(dir, ["fsck", "--full", "--strict"]);
    expect(git(dir, ["cat-file", "-p", `${commit}:hello.txt`])).toBe("hello");
  });
});
