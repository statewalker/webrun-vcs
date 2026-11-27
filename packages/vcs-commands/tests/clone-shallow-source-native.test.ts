/**
 * A clone of a shallow repository writes the shallow commits the server sends as fetch-pack's
 * update_shallow does for `args->cloning`: every one the pack brought, in the order sent and
 * once per line (setup_alternate_shallow appends its `extra` array unsorted and unmerged). A
 * v2 server answers with get_shallow_commits' list, which names a commit once per want that
 * reaches it (a branch and an annotated tag) and in its own order; a v0 server advertises its
 * shallow file, sorted (statewalker/webrun-vcs#326). Native git's clone and ours (both
 * `--no-local`) must leave the same `.git/shallow` bytes.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cloneStateOf, ourClone } from "./clone-options-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** `git -c protocol.version=<v>` as `GIT_CONFIG_*` variables (after the test environment's two). */
const protocol = (version: number): Record<string, string> => ({
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_2: "protocol.version",
  GIT_CONFIG_VALUE_2: String(version),
});

async function twinClone(source: string, version: number) {
  const k = counter++;
  const n = join(root, `n${k}`);
  const o = join(root, `o${k}`);
  const extraEnv = protocol(version);
  expect(gitRun(root, root, ["clone", "-q", "--no-local", source, n], extraEnv).status).toBe(0);
  await ourClone(root, o, (c) => c.setURI(source).setLocal(false), { extraEnv });
  const shallow = (dir: string) => readFileSync(join(dir, ".git", "shallow"), "utf8");
  expect(shallow(o)).toBe(shallow(n));
  expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));
  return shallow(n);
}

describeGit("clone of a shallow repository: the shallow file as native git writes it", () => {
  let tagged: string;
  let branches: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clone-shallow-source-native-"));
    const src = join(root, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    for (const i of [1, 2, 3]) {
      putFile(src, "f", `${i}\n`);
      git(src, "add", "f");
      git(src, "commit", "-qm", `c${i}`);
    }
    git(src, "tag", "-a", "v1", "-m", "v1");
    git(src, "tag", "light");
    // a shallow source whose one shallow commit main, `light` and the tag v1 reach
    tagged = join(root, "tagged.git");
    git(root, "clone", "-q", "--bare", "--depth=1", "--no-local", src, tagged);
    git(tagged, "fetch", "-q", "--depth=1", "origin", "refs/tags/*:refs/tags/*");

    // several shallow commits, one of them reached by a branch and an annotated tag
    for (const b of ["b1", "b2", "b3", "b4"]) {
      git(src, "checkout", "-q", "-b", b, "main~1");
      putFile(src, "g", `${b}\n`);
      git(src, "add", "g");
      git(src, "commit", "-qm", b);
    }
    git(src, "checkout", "-q", "main");
    git(src, "tag", "-a", "t2", "-m", "t2", "b2");
    branches = join(root, "branches.git");
    git(
      root,
      "clone",
      "-q",
      "--bare",
      "--depth=1",
      "--no-single-branch",
      "--no-local",
      src,
      branches,
    );
    git(branches, "fetch", "-q", "--depth=1", "origin", "refs/tags/*:refs/tags/*");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("a shallow commit a branch and an annotated tag reach (protocol v2: listed twice)", async () => {
    const shallow = await twinClone(tagged, 2);
    const id = git(tagged, "rev-parse", "main").trim();
    expect(shallow).toBe(`${id}\n${id}\n`);
  });

  it("a shallow commit a branch and an annotated tag reach (protocol v0: listed once)", async () => {
    const id = git(tagged, "rev-parse", "main").trim();
    expect(await twinClone(tagged, 0)).toBe(`${id}\n`);
  });

  it("several shallow commits: v2 keeps the server's order and duplicates", async () => {
    const shallow = await twinClone(branches, 2);
    expect(shallow.split("\n").filter(Boolean)).toHaveLength(7);
  });

  it("several shallow commits: v0 writes the advertised (sorted) list", async () => {
    const shallow = await twinClone(branches, 0);
    expect(shallow).toBe(readFileSync(join(branches, "shallow"), "utf8"));
  });
});
