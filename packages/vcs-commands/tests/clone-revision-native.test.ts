/**
 * `git clone --revision` (git 2.49+) against native git (t5621-clone-revision): the history of
 * one ref or commit id fetched, HEAD detached at its commit, no ref written, no
 * `remote.origin.fetch`. Under git 2.43 the option is unknown, and ours refuses it as 2.43
 * does under 2.43 compatibility.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cloneStateOf,
  ourClone,
  ourCloneFails,
  stderrLines,
} from "./clone-options-native-support.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;
const it25 = nativeIs25x ? it : it.skip;
const it243 = nativeIs25x ? it.skip : it;

let root: string;
let src: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args).trim();

function twins(): [string, string] {
  const k = counter++;
  return [join(root, `n${k}`), join(root, `o${k}`)];
}

/** Native git's clone and ours with the same arguments, the repositories compared. */
async function same(
  args: string[],
  configure: Parameters<typeof ourClone>[2],
  bare = false,
): Promise<string> {
  const [n, o] = twins();
  const theirs = gitRun(root, root, ["clone", "-q", ...args, src, n]);
  expect(theirs.status, theirs.stderr).toBe(0);
  await ourClone(root, o, (c) => configure(c.setURI(src)), { bare });
  expect(cloneStateOf(root, o, bare)).toEqual(cloneStateOf(root, n, bare));
  return o;
}

/** Native git's failure and ours: the same lines and exit code. */
async function bothFail(args: string[], configure: Parameters<typeof ourClone>[2]) {
  const [n, o] = twins();
  const theirs = gitRun(root, root, ["clone", "-q", ...args, src, n]);
  expect(theirs.status).not.toBe(0);
  const ours = await ourCloneFails(root, o, (c) => configure(c.setURI(src)));
  expect(ours.message).toBe(stderrLines(theirs.stderr));
  expect(ours.exitCode).toBe(theirs.status);
}

describeGit("git clone --revision, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clone-revision-native-"));
    src = join(root, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    const commit = (message: string, content: string) => {
      putFile(src, "README", content);
      git(src, "add", "README");
      git(src, "commit", "-qm", message);
    };
    commit("initial commit", "Hello");
    commit("second commit", "Hello world");
    git(src, "tag", "-a", "v1.0", "-m", "second commit");
    commit("third commit", "Hello world!");
    git(src, "switch", "-q", "-c", "feature", "v1.0");
    commit("feature commit", "Hello world!");
    git(src, "switch", "-q", "main");
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it25('t5621-clone-revision.sh: "clone with --revision being a branch"', async () => {
    const o = await same(["--revision=refs/heads/feature"], (c) =>
      c.setRevision("refs/heads/feature"),
    );
    expect(git(o, "rev-parse", "HEAD")).toBe(git(src, "rev-parse", "refs/heads/feature"));
    expect(git(o, "for-each-ref", "refs")).toBe("");
    // and through a local copy of the objects as through a fetch
    await same(["--no-local", "--revision=refs/heads/feature"], (c) =>
      c.setLocal(false).setRevision("refs/heads/feature"),
    );
    // a name looked up as fetch looks up a refspec's source
    await same(["--revision=feature"], (c) => c.setRevision("feature"));
  });

  it25('t5621-clone-revision.sh: "clone with --depth and --revision being a branch"', async () => {
    const o = await same(["--no-local", "--depth=1", "--revision=refs/heads/feature"], (c) =>
      c.setLocal(false).setDepth(1).setRevision("refs/heads/feature"),
    );
    expect(git(o, "rev-list", "HEAD").split("\n").length).toBe(1);
  });

  it25('t5621-clone-revision.sh: "clone with --revision being a tag"', async () => {
    const [n, o] = twins();
    const theirs = gitRun(root, root, ["clone", "-q", "--revision=refs/tags/v1.0", src, n]);
    expect(theirs.status).toBe(0);
    const result = await ourClone(root, o, (c) => c.setURI(src).setRevision("refs/tags/v1.0"));
    expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));
    expect(git(o, "rev-parse", "HEAD")).toBe(git(src, "rev-parse", "refs/tags/v1.0^{}"));
    expect((result.messages ?? []).join("")).toBe(
      theirs.stderr
        .split("\n")
        .filter((l) => l.startsWith("warning: "))
        .map((l) => `${l}\n`)
        .join(""),
    );
  });

  it25('t5621-clone-revision.sh: "clone with --revision being HEAD"', async () => {
    await same(["--revision=HEAD"], (c) => c.setRevision("HEAD"));
  });

  it25('t5621-clone-revision.sh: "clone with --revision being a raw commit hash"', async () => {
    const oid = git(src, "rev-parse", "refs/heads/feature");
    await same([`--revision=${oid}`], (c) => c.setRevision(oid));
    await same(["--no-local", `--revision=${oid}`], (c) => c.setLocal(false).setRevision(oid));
  });

  it25('t5621-clone-revision.sh: "clone with --revision and --bare"', async () => {
    await same(
      ["--revision=refs/heads/main", "--bare"],
      (c) => c.setRevision("refs/heads/main").setBare(true),
      true,
    );
  });

  it25('t5621-clone-revision.sh: "clone with --revision and protocol v0"', async () => {
    const [n, o] = twins();
    const v0 = {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "protocol.version",
      GIT_CONFIG_VALUE_2: "0",
    };
    const args = ["clone", "-q", "--no-local", "--revision=refs/heads/main", src, n];
    expect(gitRun(root, root, args, v0).status).toBe(0);
    await ourClone(root, o, (c) => c.setURI(src).setLocal(false).setRevision("refs/heads/main"), {
      extraEnv: v0,
    });
    expect(cloneStateOf(root, o)).toEqual(cloneStateOf(root, n));
  });

  it25(
    't5621-clone-revision.sh: "clone with --revision being a short raw commit hash"',
    async () => {
      const oid = git(src, "rev-parse", "--short", "refs/heads/feature");
      await bothFail([`--revision=${oid}`], (c) => c.setRevision(oid));
    },
  );

  it25('t5621-clone-revision.sh: "clone with --revision being a tree hash"', async () => {
    const oid = git(src, "rev-parse", "refs/heads/feature^{tree}");
    await bothFail([`--revision=${oid}`], (c) => c.setRevision(oid));
  });

  it25(
    't5621-clone-revision.sh: "clone with --revision being the parent of a ref fails"',
    async () => {
      await bothFail(["--revision=refs/heads/main^"], (c) => c.setRevision("refs/heads/main^"));
    },
  );

  it25('t5621-clone-revision.sh: "clone with --revision and --branch fails"', async () => {
    await bothFail(["--revision=refs/heads/main", "--branch=main"], (c) =>
      c.setRevision("refs/heads/main").setBranch("main"),
    );
  });

  it25('t5621-clone-revision.sh: "clone with --revision and --mirror fails"', async () => {
    await bothFail(["--revision=refs/heads/main", "--mirror"], (c) =>
      c.setRevision("refs/heads/main").setMirror(true),
    );
  });

  it243("t5621-clone-revision.sh: git 2.43 knows no --revision", async () => {
    const [n, o] = twins();
    const theirs = gitRun(root, root, ["clone", "-q", "--revision=refs/heads/main", src, n]);
    expect(theirs.status).toBe(129);
    const ours = await ourCloneFails(root, o, (c) => c.setURI(src).setRevision("refs/heads/main"));
    expect(ours.message).toBe(theirs.stderr.split("\n")[0]);
    expect(ours.exitCode).toBe(129);
  });
});
