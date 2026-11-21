/**
 * Local remotes from a bare repository, against native git: our working copy of a bare
 * repository (`Git.fromWorktreeAdmin`) fetches, pushes, lists and clones through git's local
 * transport, relative paths read from its git directory as git reads them there, with the
 * remote bare or not. Each case runs native git in one copy of the repositories and ours in
 * the other.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { nativeGitAvailable, noMaintenance } from "./native-git-http-backend.js";
import { gitOut, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/** `<dir>/src` (main, other, tag v1), `<dir>/remote.git` (its bare clone), `<dir>/local.git` (empty, bare). */
function base(dir: string): void {
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  git(src, ["init", "-q", "-b", "main"]);
  putFile(src, "a.txt", "a\n");
  git(src, ["add", "-A"]);
  git(src, ["commit", "-qm", "a"]);
  git(src, ["branch", "other"]);
  git(src, ["tag", "-a", "-m", "t", "v1"]);
  git(dir, ["clone", "-q", "--bare", "src", "remote.git"]);
  git(dir, ["init", "-q", "--bare", "-b", "main", "local.git"]);
  // a native local push reaches them: no background maintenance there
  noMaintenance(join(dir, "remote.git"));
  noMaintenance(join(dir, "local.git"));
}

/** Two copies of `dir`: native's and ours. */
function twins(dir: string): [string, string] {
  return (["native", "ours"] as const).map((suffix) => {
    const copy = `${dir}-${suffix}`;
    rmSync(copy, { recursive: true, force: true });
    execFileSync("cp", ["-a", dir, copy]);
    return copy;
  }) as [string, string];
}

/** Our working copy of the bare repository `<dir>/<name>`. */
async function openBare(dir: string, name: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const environment = createNodeGitHostEnvironment({ env: testEnv(root) });
  const { history } = await createGitFilesBackend({ files, gitDir: name });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: name, history, environment });
  return Git.fromWorktreeAdmin(await worktrees.openAdmin());
}

const refs = (dir: string) => git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]);

describeGit("local remotes from a bare repository: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bare-local-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("ls-remote and fetch from a bare and a non-bare remote", async () => {
    const dir = join(root, "r");
    base(dir);
    for (const remote of ["../remote.git", "../src"]) {
      const [theirs, mine] = twins(dir);
      const ours = await openBare(mine, "local.git");
      const listed = await ours.lsRemote().setRemote(remote).call();
      const native = git(join(theirs, "local.git"), ["ls-remote", remote]);
      expect(
        listed.refs
          .filter((r) => r.name !== "HEAD")
          .map((r) => `${r.objectId}\t${r.name}`)
          .join("\n"),
        `${remote}: ls-remote`,
      ).toBe(
        native
          .split("\n")
          .filter((l) => l && !l.endsWith("\tHEAD") && !l.endsWith("^{}"))
          .join("\n"),
      );

      const spec = "refs/heads/*:refs/heads/*";
      git(join(theirs, "local.git"), ["fetch", "-q", remote, spec]);
      await ours.fetch().setRemote(remote).setRefSpecs(spec).call();
      expect(refs(join(mine, "local.git")), `${remote}: refs`).toBe(
        refs(join(theirs, "local.git")),
      );
      const fetchHead = (d: string) =>
        readFileSync(join(d, "local.git/FETCH_HEAD"), "latin1").replaceAll(d, "<twin>");
      expect(fetchHead(mine), `${remote}: FETCH_HEAD`).toBe(fetchHead(theirs));
    }
  });

  it("push from a bare repository to a bare remote", async () => {
    const dir = join(root, "r");
    base(dir);
    git(join(dir, "local.git"), ["fetch", "-q", "../src", "refs/heads/*:refs/heads/*"]);
    git(join(dir, "local.git"), ["branch", "topic", "main"]);
    const [theirs, mine] = twins(dir);
    git(join(theirs, "local.git"), ["push", "-q", "../remote.git", "topic", ":other"]);
    const ours = await openBare(mine, "local.git");
    await ours.push().setRemote("../remote.git").add("topic").add(":other").call();
    expect(refs(join(mine, "remote.git"))).toBe(refs(join(theirs, "remote.git")));
  });

  it("clone --bare into a bare repository's working copy, from a bare remote", async () => {
    const dir = join(root, "r");
    base(dir);
    const [theirs, mine] = twins(dir);
    git(theirs, ["clone", "-q", "--bare", "remote.git", "clone.git"]);
    git(mine, ["init", "-q", "--bare", "-b", "main", "clone.git"]);
    const ours = await openBare(mine, "clone.git");
    await ours.clone().setURI("../remote.git").setBare(true).call();
    expect(refs(join(mine, "clone.git"))).toBe(refs(join(theirs, "clone.git")));
    expect(git(join(mine, "clone.git"), ["symbolic-ref", "HEAD"])).toBe(
      git(join(theirs, "clone.git"), ["symbolic-ref", "HEAD"]),
    );
  });
});
