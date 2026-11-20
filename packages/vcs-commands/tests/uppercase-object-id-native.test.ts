/**
 * Object ids in upper case, against native git, which reads hexadecimal ids in either case
 * (`get_oid_hex`) and writes them lowercase: a loose ref holding an uppercase id is a valid
 * ref to `branch -m`, `commit` and `pack-refs --all`, and an uppercase id given to the
 * commands names its object (a tag, a commit's parent).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

async function ours(dir: string): Promise<Git> {
  return openOurs(dir, createNodeGitHostEnvironment({ env: testEnv(root) }));
}

/** Two repositories with the same commits (`one`, then `two` on main; `side` at one). */
function twins(): [string, string] {
  const dirs: [string, string] = [join(root, `n${counter}`), join(root, `o${counter}`)];
  counter++;
  for (const dir of dirs) {
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    putFile(dir, "a.txt", "a\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-qm", "one");
    git(dir, "branch", "side");
    putFile(dir, "b.txt", "b\n");
    git(dir, "add", "b.txt");
    git(dir, "commit", "-qm", "two");
  }
  return dirs;
}

/** Writes `refs/heads/<name>` loose, holding `id` in upper case. */
function upperLooseRef(dir: string, name: string, id: string): void {
  writeFileSync(join(dir, ".git/refs/heads", name), `${id.toUpperCase()}\n`);
}

const refs = (dir: string) => git(dir, "for-each-ref", "--format=%(refname) %(objectname)");

describeGit("object ids in upper case: as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "upper-id-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("branch -m of a loose ref holding an uppercase id", async () => {
    const [n, o] = twins();
    for (const dir of [n, o]) upperLooseRef(dir, "side", git(dir, "rev-parse", "side").trim());
    git(n, "branch", "-m", "side", "renamed");
    await (await ours(o)).branchRename().setOldName("side").setNewName("renamed").call();
    expect(refs(o)).toBe(refs(n));
    expect(readFileSync(join(o, ".git/refs/heads/renamed"), "utf8")).toBe(
      readFileSync(join(n, ".git/refs/heads/renamed"), "utf8"),
    );
  });

  it("commit on a branch whose loose ref holds an uppercase id", async () => {
    const [n, o] = twins();
    for (const dir of [n, o]) {
      upperLooseRef(dir, "main", git(dir, "rev-parse", "main").trim());
      putFile(dir, "c.txt", "c\n");
      git(dir, "add", "c.txt");
    }
    git(n, "commit", "-qm", "three");
    await (await ours(o)).commit().setMessage("three").call();
    expect(refs(o)).toBe(refs(n));
    expect(git(o, "rev-parse", "HEAD~1")).toBe(git(n, "rev-parse", "HEAD~1"));
  });

  it("pack-refs --all packs a loose ref holding an uppercase id", async () => {
    const [n, o] = twins();
    for (const dir of [n, o]) upperLooseRef(dir, "side", git(dir, "rev-parse", "side").trim());
    git(n, "pack-refs", "--all");
    await (await ours(o)).packRefs().setAll(true).call();
    // the entries (git writes the peeled traits in the header, ours "sorted" alone)
    const packed = (dir: string) =>
      readFileSync(join(dir, ".git/packed-refs"), "utf8")
        .split("\n")
        .filter((l) => !l.startsWith("#"));
    expect(packed(o)).toEqual(packed(n));
    expect(packed(o)).toContain(`${git(o, "rev-parse", "side").trim()} refs/heads/side`);
    expect(refs(o)).toBe(refs(n));
  });

  it("tag of an uppercase full id, lightweight and annotated", async () => {
    const [n, o] = twins();
    const id = git(n, "rev-parse", "side").trim().toUpperCase();
    git(n, "tag", "light", id);
    git(n, "tag", "-a", "-m", "annotated", "heavy", id);
    const g = await ours(o);
    await g.tag().setName("light").setObjectId(id).call();
    await g.tag().setName("heavy").setMessage("annotated").setObjectId(id).call();
    expect(refs(o)).toBe(refs(n));
    expect(git(o, "cat-file", "-p", "heavy")).toBe(git(n, "cat-file", "-p", "heavy"));
    expect(gitRun(root, o, ["fsck", "--no-progress", "--strict"]).stderr).toBe("");
  });

  it("a commit's parent given as an uppercase full id", async () => {
    const [n, o] = twins();
    const parent = git(n, "rev-parse", "side").trim();
    const tree = git(n, "rev-parse", "HEAD^{tree}").trim();
    const native = git(n, "commit-tree", "-p", parent.toUpperCase(), "-m", "p", tree).trim();
    const result = await (await ours(o))
      .commit()
      .setMessage("p")
      .setParentIds(parent.toUpperCase())
      .setAllowEmpty(true)
      .call();
    const parentLine = (dir: string, id: string) =>
      git(dir, "cat-file", "-p", id)
        .split("\n")
        .filter((l) => l.startsWith("parent "));
    expect(parentLine(o, result.id)).toEqual(parentLine(n, native));
    expect(gitRun(root, o, ["fsck", "--no-progress", "--strict"]).stderr).toBe("");
  });
});
