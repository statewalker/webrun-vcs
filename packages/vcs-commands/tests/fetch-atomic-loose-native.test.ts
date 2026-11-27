/**
 * Where an atomic fetch writes its refs, against native git (statewalker/webrun-vcs#284):
 * git's files backend commits a transaction by renaming each ref's lock over its loose file
 * (`files_transaction_finish`) and touches packed-refs only to drop the refs it deletes, so
 * `git fetch --atomic` updating several refs leaves them loose, in 2.43 and 2.5x alike. Each
 * case clones one repository twice (both clones' refs in packed-refs), fetches with native
 * git in one and our `FetchCommand` in the other, then compares the loose ref files and the
 * packed-refs bytes.
 *
 * Sources: t5510-fetch.sh (`--atomic`).
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FetchCommand, Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** The native git's version, as our compatibility */
const compatibility: "2.43" | "2.56" = (() => {
  if (!nativeGitAvailable()) return "2.56";
  const m = /git version (\d+)\.(\d+)/.exec(gitOut("/", "/", ["--version"]));
  return m && (Number(m[1]) > 2 || Number(m[2]) >= 50) ? "2.56" : "2.43";
})();

async function ours(name: string): Promise<Git> {
  return openOurs(root, createNodeGitHostEnvironment({ env: testEnv(root) }), undefined, name);
}

/** Every loose ref file below `.git/refs`, `<path> <content>`, sorted. */
function looseRefs(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(root, dir, ".git", rel);
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const path = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path);
      else out.push(`${path} ${readFileSync(join(root, dir, ".git", path), "latin1")}`);
    }
  };
  walk("refs");
  return out.sort();
}

const packedRefs = (dir: string) => {
  const path = join(root, dir, ".git/packed-refs");
  return existsSync(path) ? readFileSync(path, "latin1") : null;
};

/** `src` after its changes, `preseed.git` its mirror before them. */
function setupUpstream(): void {
  const src = join(root, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  putFile(src, "a.txt", "a\n");
  git(src, "add", "a.txt");
  git(src, "commit", "-qm", "base");
  git(src, "branch", "one");
  git(src, "branch", "two");
  git(src, "branch", "gone");
  git(root, "clone", "-q", "--mirror", src, join(root, "preseed.git"));
  putFile(src, "b.txt", "b\n");
  git(src, "add", "b.txt");
  git(src, "commit", "-qm", "next");
  git(src, "branch", "-f", "one");
  git(src, "branch", "-f", "two");
  git(src, "branch", "three");
  git(src, "branch", "-D", "gone");
  git(src, "tag", "-a", "-m", "v2", "v2");
}

/** Two clones of `preseed.git` (native `n<k>`, ours `o<k>`), `origin` then at `../src`. */
function twins(): [string, string] {
  const names: [string, string] = [`n${counter}`, `o${counter}`];
  counter++;
  for (const name of names) {
    git(root, "clone", "-q", join(root, "preseed.git"), name);
    git(join(root, name), "remote", "set-url", "origin", "../src");
  }
  return names;
}

async function expectAtomicTwins(
  args: string[],
  configure: (fetch: FetchCommand) => FetchCommand,
): Promise<void> {
  const [n, o] = twins();
  // the clones start alike: every ref packed
  expect(looseRefs(o)).toEqual(looseRefs(n));
  expect(packedRefs(o)).toBe(packedRefs(n));
  const native = gitRun(root, join(root, n), ["fetch", "--atomic", ...args]);
  expect(native.status, native.stderr).toBe(0);
  await configure((await ours(o)).fetch().setCompatibility(compatibility).setAtomic(true)).call();
  expect(looseRefs(o), "loose refs").toEqual(looseRefs(n));
  expect(packedRefs(o), "packed-refs").toBe(packedRefs(n));
}

describeGit("git fetch --atomic: refs written loose, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fetch-atomic-loose-"));
    setupUpstream();
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it('t5510-fetch.sh: "fetch --atomic works with multiple branches"', async () => {
    await expectAtomicTwins(["origin"], (f) => f.setRemote("origin"));
  });

  it('t5510-fetch.sh: "fetch --atomic works with mixed branches and tags"', async () => {
    await expectAtomicTwins(
      ["origin", "refs/heads/*:refs/remotes/origin/*", "v2:refs/tags/v2"],
      (f) =>
        f.setRemote("origin").setRefSpecs("refs/heads/*:refs/remotes/origin/*", "v2:refs/tags/v2"),
    );
  });

  // the stale ref leaves packed-refs, the updates go loose
  it('t5510-fetch.sh: "fetch --atomic prunes references"', async () => {
    await expectAtomicTwins(["--prune", "origin"], (f) =>
      f.setRemote("origin").setRemoveDeletedRefs(true),
    );
  });
});
