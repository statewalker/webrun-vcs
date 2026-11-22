/**
 * git's ownership check of a local remote, against native git: a push refuses a repository
 * another user owns (receive-pack's `enter_repo`), a local clone refuses to copy one
 * (clone.c's `copy_or_link_directory`, 2.45.1+), while 2.48+'s upload-pack serves it
 * whatever its owner (ls-remote, fetch, clone --no-local). Ownership differences come from
 * `GIT_TEST_ASSUME_DIFFERENT_OWNER` (ours: `GitHostEnvironment.assumeDifferentOwner`), so
 * this runs as any user. The sandbox's 2.43 (a distribution build with the 2.45.1 fixes)
 * also refuses in upload-pack, which ours does not: those twins run on 2.5x only.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;
const version = nativeGitAvailable() ? execFileSync("git", ["--version"]).toString() : "";
const is25x = Number(/2\.(\d+)/.exec(version)?.[1] ?? "0") >= 48;

const DIFFERENT = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };

let root: string;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

const dubious = (path: string) =>
  `fatal: detected dubious ownership in repository at '${path}'\n` +
  "To add an exception for this directory, call:\n\n" +
  `\tgit config --global --add safe.directory ${path}\n`;
const COULD_NOT_READ =
  "fatal: Could not read from remote repository.\n\n" +
  "Please make sure you have the correct access rights\nand the repository exists.\n";

/** Our working copy at `dir` (inside root), seeing every repository as another user's. */
async function ours(dir: string, extra: Record<string, string> = DIFFERENT) {
  return openOurs(
    root,
    createNodeGitHostEnvironment({ env: testEnv(root, extra) }),
    undefined,
    dir.slice(root.length + 1),
    true,
  );
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return `${(error as Error).message}\n`;
  }
  return "";
}

describeGit("a local remote another user owns, as native git", () => {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ownership-native-")));
    const src = join(root, "src");
    git(root, "init", "-q", "-b", "main", src);
    git(src, "commit", "-q", "--allow-empty", "-m", "one");
    git(root, "clone", "-q", "--bare", "src", "bare.git");
    git(root, "init", "-q", "-b", "main", "pusher");
    git(join(root, "pusher"), "commit", "-q", "--allow-empty", "-m", "two");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("push: receive-pack refuses the repository", async () => {
    const pusher = join(root, "pusher");
    // GIT_DIR keeps the pusher's own repository out of the check
    const native = gitRun(root, root, ["push", join(root, "bare.git"), "main:refs/heads/x"], {
      ...DIFFERENT,
      GIT_DIR: join(pusher, ".git"),
    });
    expect(native.status).toBe(128);
    expect(native.stderr).toBe(`${dubious(join(root, "bare.git"))}${COULD_NOT_READ}`);
    const g = await ours(pusher);
    const ourError = await failure(() =>
      g.push().setRemote(join(root, "bare.git")).setRefSpecs("main:refs/heads/x").call(),
    );
    expect(ourError).toBe(native.stderr);
    expect(git(join(root, "bare.git"), "for-each-ref", "--format=%(refname)")).toBe(
      "refs/heads/main\n",
    );
  });

  it("push: safe.directory lets it through", async () => {
    const pusher = join(root, "pusher");
    const allow = {
      ...DIFFERENT,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: join(root, "bare.git"),
    };
    const g = await ours(pusher, allow);
    const result = await g
      .push()
      .setRemote(join(root, "bare.git"))
      .setRefSpecs("main:refs/heads/ours")
      .call();
    expect(result.remoteUpdates.map((u) => u.status)).toEqual(["ok"]);
  });

  it("clone: the local copy refuses the source", async () => {
    const dir = join(root, "clones");
    mkdirSync(dir, { recursive: true });
    const expected = dubious(join(root, "src", ".git"));
    const native = gitRun(root, dir, ["clone", "-q", join(root, "src"), "n"], DIFFERENT);
    expect(native.status).toBe(128);
    // 2.43's upload-pack refuses first (with the "Could not read" lines)
    expect(native.stderr.startsWith(expected)).toBe(true);
    if (is25x) expect(native.stderr).toBe(expected);
    const o = join(dir, "o");
    git(root, "init", "-q", "-b", "main", o);
    const g = await ours(o);
    expect(await failure(() => g.clone().setURI(join(root, "src")).call())).toBe(expected);
  });

  it.runIf(is25x)(
    "ls-remote and clone --no-local: upload-pack serves any owner (2.48+)",
    async () => {
      const dir = join(root, "clones");
      mkdirSync(dir, { recursive: true });
      const native = gitRun(root, dir, ["ls-remote", join(root, "src")], DIFFERENT);
      expect(native.status).toBe(0);
      const o = join(dir, "o2");
      git(root, "init", "-q", "-b", "main", o);
      const refs = await (await ours(o)).lsRemote().setRemote(join(root, "src")).call();
      const listed = (text: string) => text.split("\n").filter((l) => l && !l.endsWith("\tHEAD"));
      expect(
        refs.refs.map((r) => `${r.objectId}\t${r.name}`).filter((l) => !l.endsWith("\tHEAD")),
      ).toEqual(listed(native.stdout));
      const n = gitRun(
        root,
        dir,
        ["clone", "-q", "--no-local", join(root, "src"), "n2"],
        DIFFERENT,
      );
      expect(n.status).toBe(0);
      const o3 = join(dir, "o3");
      git(root, "init", "-q", "-b", "main", o3);
      await (await ours(o3)).clone().setURI(join(root, "src")).setLocal(false).call();
      expect(git(o3, "rev-parse", "HEAD")).toBe(git(join(dir, "n2"), "rev-parse", "HEAD"));
    },
  );
});
