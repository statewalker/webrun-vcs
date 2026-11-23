/**
 * git 3.0's changed defaults and removals (`GitHostEnvironment.breakingChanges`) against
 * native git: the initial branch of a new repository (`repo_default_branch_name`),
 * `safe.bareRepository` (`get_allowed_bare_repo`) and `core.commentChar=auto`
 * (`check_auto_comment_char_config`). The git 2.x half runs against the native git on the
 * path; the git 3.0 half against `$GIT3` (`native-git3.ts`), skipped without it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRepository } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitEnv } from "./native-git-http-backend.js";
import { git3Binary, nativeGit3Env } from "./native-git3.js";

const git3 = git3Binary();
const version = execFileSync("git", ["--version"], { encoding: "utf8" });
const [, minor = "0"] = /2\.(\d+)/.exec(version) ?? [];
const native25x = Number(minor) >= 46;

let root = "";
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "git3-defaults-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const fresh = (name: string) => join(root, `${name}-${n++}`);

/** Native git (`bin`) in `cwd`: exit status and stderr lines (no colour, `hint:` lines as git prints them). */
function native(
  bin: string,
  cwd: string,
  args: string[],
  env: Record<string, string>,
): { exit: number; stderr: string[] } {
  const run = spawnSync(bin, args, { cwd, env, encoding: "utf8" });
  return { exit: run.status ?? -1, stderr: run.stderr.split("\n").filter((l) => l !== "") };
}

/** `git -c` values as `GIT_CONFIG_COUNT` entries, after the test environment's own. */
function withConfig(env: Record<string, string>, entries: Array<[string, string]>) {
  const base = Number(env.GIT_CONFIG_COUNT ?? "0");
  const out: Record<string, string> = { ...env, GIT_CONFIG_COUNT: String(base + entries.length) };
  entries.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${base + i}`] = key;
    out[`GIT_CONFIG_VALUE_${base + i}`] = value;
  });
  return out;
}

async function oursInit(
  dir: string,
  env: Record<string, string>,
  breakingChanges: boolean,
  branch?: string,
) {
  mkdirSync(dir, { recursive: true });
  const environment = createNodeGitHostEnvironment({ env, breakingChanges });
  const init = Git.init()
    .setFilesApi(createNodeFilesApi({ rootDir: dir }))
    .setEnvironment(environment);
  if (branch !== undefined) init.setInitialBranch(branch);
  try {
    const result = await init.call();
    const head = execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: dir, env, encoding: "utf8" });
    return { exit: 0, head: head.trim(), stderr: result.hints ?? [] };
  } catch (error) {
    return {
      exit: 128,
      head: "",
      stderr: (error as { lines?: string[] }).lines ?? [String(error)],
    };
  }
}

function nativeInit(bin: string, dir: string, env: Record<string, string>, branch?: string) {
  const out = native(
    bin,
    root,
    ["init", ...(branch !== undefined ? ["-b", branch] : []), dir],
    env,
  );
  const stderr = out.stderr.filter((l) => !l.startsWith("Initialized empty"));
  if (out.exit !== 0) return { exit: out.exit, head: "", stderr };
  const head = execFileSync(bin, ["symbolic-ref", "HEAD"], { cwd: dir, env, encoding: "utf8" });
  return { exit: 0, head: head.trim(), stderr };
}

describe("the initial branch of a new repository (git 2.x)", () => {
  const env = () => nativeGitEnv(root);

  it("is master with git's hint when nothing is configured", async () => {
    const theirs = nativeInit("git", fresh("n"), env());
    const ours = await oursInit(fresh("o"), env(), false);
    expect(ours.head).toBe("refs/heads/master");
    expect(ours.head).toBe(theirs.head);
    // the hint's wording is 2.5x's (2.43 words it otherwise)
    if (native25x) expect(ours.stderr).toEqual(theirs.stderr);
    else
      expect(ours.stderr[0]).toBe(
        "hint: Using 'master' as the name for the initial branch. This default branch name",
      );
  });

  it("is init.defaultBranch from the configuration, without a hint", async () => {
    const e = withConfig(env(), [["init.defaultBranch", "trunk"]]);
    expect(await oursInit(fresh("o"), e, false)).toEqual(nativeInit("git", fresh("n"), e));
  });

  it("prints no hint with advice.defaultBranchName=false (2.5x; 2.43 always prints it)", async () => {
    const e = withConfig(env(), [["advice.defaultBranchName", "false"]]);
    const ours = await oursInit(fresh("o"), e, false);
    expect(ours.stderr).toEqual([]);
    if (native25x) expect(ours).toEqual(nativeInit("git", fresh("n"), e));
  });

  it("refuses an invalid init.defaultBranch or --initial-branch as git", async () => {
    const e = withConfig(env(), [["init.defaultBranch", "a..b"]]);
    expect(await oursInit(fresh("o"), e, false)).toEqual(nativeInit("git", fresh("n"), e));
    expect(await oursInit(fresh("o"), env(), false, "x~y")).toEqual(
      nativeInit("git", fresh("n"), env(), "x~y"),
    );
  });
});

describe("symbolic refs are files, never symlinks (core.preferSymlinkRefs is gone in git 3.0)", () => {
  it("HEAD of a new repository and after a branch switch", async () => {
    const dir = fresh("sym");
    const env = nativeGitEnv(root);
    await oursInit(dir, env, true);
    const g = await openOurs(dir, createNodeGitHostEnvironment({ env, breakingChanges: true }));
    const head = () => lstatSync(join(dir, ".git", "HEAD"));
    expect(head().isFile()).toBe(true);
    expect(readFileSync(join(dir, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    await g.commit().setMessage("c").setAllowEmpty(true).call();
    await g.checkout().setCreateBranch(true).setName("topic").call();
    expect(head().isFile()).toBe(true);
    expect(readFileSync(join(dir, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/topic\n");
  });
});

describe.skipIf(!git3)("git 3.0 defaults and removals ($GIT3)", () => {
  const env = () => nativeGit3Env(root);

  it("the initial branch is main, with git 3.0's hint", async () => {
    const theirs = nativeInit(git3 as string, fresh("n"), env());
    expect(theirs.head).toBe("refs/heads/main");
    expect(await oursInit(fresh("o"), env(), true)).toEqual(theirs);
  });

  it("init.defaultBranch still decides", async () => {
    const e = withConfig(env(), [["init.defaultBranch", "master"]]);
    expect(await oursInit(fresh("o"), e, true)).toEqual(nativeInit(git3 as string, fresh("n"), e));
  });

  describe("safe.bareRepository defaults to explicit", () => {
    let bare = "";
    let repo = "";
    beforeAll(() => {
      bare = fresh("bare.git");
      repo = fresh("repo");
      execFileSync(git3 as string, ["init", "-q", "--bare", bare], { env: env() });
      mkdirSync(join(bare, "sub"));
      execFileSync(git3 as string, ["init", "-q", repo], { env: env() });
    });

    async function ours(cwd: string, e: Record<string, string>) {
      const environment = createNodeGitHostEnvironment({ env: e, breakingChanges: true });
      try {
        await discoverRepository({ files: createNodeFilesApi({ rootDir: "/" }), cwd, environment });
        return { exit: 0, stderr: [] as string[] };
      } catch (error) {
        return { exit: 128, stderr: [(error as Error).message] };
      }
    }

    for (const where of ["bare", "bare/sub", "repo/.git"] as const) {
      it(`discovered from ${where}`, async () => {
        const cwd =
          where === "bare" ? bare : where === "bare/sub" ? join(bare, "sub") : join(repo, ".git");
        const theirs = native(git3 as string, cwd, ["rev-parse", "--git-dir"], env());
        expect(await ours(cwd, env())).toEqual({ exit: theirs.exit, stderr: theirs.stderr });
      });
    }

    it("safe.bareRepository=all restores discovery", async () => {
      const e = withConfig(env(), [["safe.bareRepository", "all"]]);
      const theirs = native(git3 as string, bare, ["rev-parse", "--git-dir"], e);
      expect(theirs.exit).toBe(0);
      expect((await ours(bare, e)).exit).toBe(0);
    });
  });

  describe("core.commentChar=auto is refused by every command", () => {
    const cases: Array<{
      name: string;
      local?: string;
      global?: string;
      commandLine?: Array<[string, string]>;
    }> = [
      { name: "in the repository's config", local: "[core]\n\tcommentChar = auto\n" },
      { name: "commentString", local: "[core]\n\tcommentString = auto\n" },
      {
        name: "twice in one file, and in the global file",
        local: "[core]\n\tcommentChar = auto\n\tcommentChar = auto\n",
        global: "[core]\n\tcommentString = ;\n",
      },
      { name: "set in the global file only", global: "[core]\n\tcommentChar = auto\n" },
      {
        name: "overridden by a later value",
        local: "[core]\n\tcommentChar = auto\n\tcommentChar = %\n",
      },
      { name: "from the command line only", commandLine: [["core.commentChar", "auto"]] },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const dir = fresh("cc");
        // files refs: reading reftable is a later ticket (statewalker-root#228)
        execFileSync(git3 as string, ["init", "-q", "--ref-format=files", dir], { env: env() });
        if (c.local) writeFileSync(join(dir, ".git", "config"), c.local, { flag: "a" });
        let e = env();
        if (c.global) {
          const global = join(dir, "..", `global-${n++}`);
          writeFileSync(global, c.global);
          e = { ...e, GIT_CONFIG_GLOBAL: global };
        }
        if (c.commandLine) e = withConfig(e, c.commandLine);
        const theirs = native(git3 as string, dir, ["status", "--porcelain"], e);
        const g = await openOurs(
          dir,
          createNodeGitHostEnvironment({ env: e, breakingChanges: true }),
        );
        const error = await Promise.resolve()
          .then(() => g.status().call())
          .then(
            () => undefined,
            (err: unknown) => err as { lines?: string[] },
          );
        expect({ exit: error ? 128 : 0, stderr: error?.lines ?? [] }).toEqual(theirs);
      });
    }
  });
});
