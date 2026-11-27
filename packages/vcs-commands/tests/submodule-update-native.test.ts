/**
 * `git submodule update` and `git submodule status` against native git
 * (builtin/submodule--helper.c `module_update`, `update_submodule`, `run_update_command`,
 * `module_status`, `status_submodule`): each scenario is built once with native git and
 * copied into twins; every step runs `git submodule ...` in one twin and our command in the
 * other, and compares stdout, stderr, the exit status, the worktrees (submodules' files and
 * gitfiles included), `.git/config`, each `.git/modules/<name>`'s layout, config, HEAD and
 * refs, and the indexes (`ls-files -s`).
 *
 * Inputs come from git's t7406-submodule-update.sh and t7400-submodule-basic.sh (each test
 * names its title there) and JGit's SubmoduleUpdateTest and SubmoduleStatusTest. Local URLs
 * need `protocol.file.allow=always`, as git's tests set it (`git submodule` clones and
 * fetches with GIT_PROTOCOL_FROM_USER=0).
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";
import {
  createDefaultTransports,
  createFetchHandler,
  createRepositoryFacade,
  createTransportRefStore,
  type GitConnectRequest,
  type GitTransportRegistry,
  serveOverDuplex,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDuplexPair, openLocalRemote } from "../src/commands/local-transport.js";
import {
  type Git,
  SubmoduleCommandError,
  type SubmoduleCommandResult,
  strictUrlOrigin,
} from "../src/index.js";
import { serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";
import { testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const versionLine = nativeGitAvailable() ? execFileSync("git", ["--version"]).toString() : "";
const compatibility = gitAtLeast(versionLine, 2, 50) ? "2.56" : "2.43";

/** `-c protocol.file.allow=always`, as git's tests clone local submodules. */
const ALLOW_FILE = { GIT_CONFIG_PARAMETERS: "'protocol.file.allow'='always'" };

/** What a `.git/modules/<name>` holds that both implementations write. */
const MODULE_LAYOUT = new Set(["HEAD", "config", "index", "objects", "refs", "shallow"]);

let root: string;
let caseNo = 0;

interface Twins {
  base: string;
  native: string;
  ours: string;
}

/** Runs a bash script with native git's test environment (fixtures). */
function sh(cwd: string, script: string): string {
  return execFileSync("bash", ["-euc", script], {
    cwd,
    env: { ...testEnv(root), ...ALLOW_FILE },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("latin1");
}

/** A fixture built by `script` in a new directory, copied into a native and an ours twin. */
function twins(script: string): Twins {
  const base = join(root, `case${++caseNo}`);
  const build = join(base, "build");
  execFileSync("mkdir", ["-p", build]);
  sh(build, script);
  const native = join(base, "native");
  const ours = join(base, "ours");
  execFileSync("cp", ["-a", build, native]);
  execFileSync("cp", ["-a", build, ours]);
  return { base, native, ours };
}

/** Native git's stdout in `cwd` (read-only questions about a twin), or its failure. */
function ask(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, env: testEnv(root) });
  return `${r.stdout.toString("latin1")}${r.status ? `[exit ${r.status}]` : ""}`;
}

/** The state compared: worktree files, configs, gitfiles, modules, indexes, HEADs and refs. */
function snapshot(dir: string, twin: string): Record<string, string> {
  const out: Record<string, string> = {};
  const norm = (s: string) => s.split(twin).join("<T>");
  const walkGitDir = (abs: string, rel: string) => {
    const config = join(abs, "config");
    if (existsSync(config)) out[`${rel}/config`] = norm(readFileSync(config, "latin1"));
    const modules = join(abs, "modules");
    if (existsSync(modules)) walkModules(modules, `${rel}/modules`);
  };
  const walkModules = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      if (!lstatSync(p).isDirectory()) continue;
      out[`${rel}/${name}/`] = "dir";
      if (existsSync(join(p, "HEAD"))) {
        const entries = readdirSync(p).filter((e) => MODULE_LAYOUT.has(e));
        out[`${rel}/${name}/ (layout)`] = entries.sort().join(" ");
        out[`${rel}/${name}/HEAD`] = readFileSync(join(p, "HEAD"), "latin1");
        out[`${rel}/${name}/ (refs)`] = norm(
          ask(p, ["for-each-ref", "--format=%(refname) %(objectname) %(upstream)"]),
        );
        walkGitDir(p, `${rel}/${name}`);
      } else walkModules(p, `${rel}/${name}`);
    }
  };
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (name === ".git") {
        if (st.isDirectory()) {
          out[`${r}/`] = "gitdir";
          walkGitDir(p, r);
        } else out[r] = norm(readFileSync(p, "latin1"));
        out[`${r} (ls-files)`] = ask(abs, ["ls-files", "-s"]);
        out[`${r} (HEAD)`] = ask(abs, ["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"]);
      } else if (st.isSymbolicLink()) out[r] = `link -> ${readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[`${r}/`] = "dir";
        walk(p, r);
      } else out[r] = norm(readFileSync(p, "latin1"));
    }
  };
  walk(dir, "");
  return out;
}

/** Our working copy of `<twin>/<dir>`, the FilesApi rooted at the case (fixture paths in reach). */
async function ours(t: Twins, dir: string, env: Record<string, string>): Promise<Git> {
  const environment = createNodeGitHostEnvironment({
    env,
    hookRunner: createNodeHookRunner({ env, compatibility }),
  });
  return openOurs(t.base, environment, undefined, `ours/${dir}`, true);
}

/** Our command's outcome in native git's shape (a death's lines on stderr). */
async function oursRun(
  run: () => Promise<SubmoduleCommandResult>,
): Promise<SubmoduleCommandResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SubmoduleCommandError) {
      return {
        stdout: error.result.stdout,
        stderr: `${error.result.stderr}${error.message}\n`,
        exitCode: error.exitCode,
      };
    }
    throw error;
  }
}

/** One step: `git submodule <args>` and our call. */
type Step = [args: string[], run: (git: Git) => Promise<SubmoduleCommandResult>];

/** `git submodule update <args>` and ours, built by `build`. */
const update = (
  args: string[],
  build: (c: ReturnType<Git["submoduleUpdate"]>) => ReturnType<Git["submoduleUpdate"]> = (c) => c,
): Step => [
  ["update", ...args],
  (g) => build(g.submoduleUpdate().setCompatibility(compatibility)).call(),
];

/** `git submodule status <args>` and ours, built by `build`. */
const status = (
  args: string[],
  build: (c: ReturnType<Git["submoduleStatus"]>) => ReturnType<Git["submoduleStatus"]> = (c) => c,
): Step => [["status", ...args], (g) => build(g.submoduleStatus()).call()];

/** A shell step run in both twins alike (between our steps). */
const both = (script: string): Step => [
  ["!", script],
  async () => ({ stdout: "", stderr: "", exitCode: 0 }),
];

/** Runs each step in both twins (in `dir`), comparing outputs and states. */
async function expectTwins(t: Twins, steps: Step[], dir = "clone"): Promise<void> {
  const env = { ...testEnv(root), ...ALLOW_FILE };
  for (const [args, run] of steps) {
    if (args[0] === "!") {
      sh(join(t.native, dir), args[1] as string);
      sh(join(t.ours, dir), args[1] as string);
      continue;
    }
    const label = `git submodule ${args.join(" ")}`;
    const r = spawnSync("git", ["submodule", ...args], { cwd: join(t.native, dir), env });
    const n: SubmoduleCommandResult = {
      stdout: r.stdout.toString("utf8"),
      stderr: r.stderr.toString("utf8"),
      exitCode: r.status ?? -1,
    };
    const o = await oursRun(async () => run(await ours(t, dir, env)));
    const norm = (x: SubmoduleCommandResult, twin: string) => ({
      stdout: x.stdout.split(twin).join("<T>"),
      stderr: x.stderr.split(twin).join("<T>"),
      exitCode: x.exitCode,
    });
    expect(norm(o, t.ours), label).toEqual(norm(n, t.native));
    expect(snapshot(join(t.ours, dir), t.ours), label).toEqual(
      snapshot(join(t.native, dir), t.native),
    );
  }
}

/**
 * `up` (tag v1, then y, a branch `dev`), `sup` with `up` as submodule `sub`, and `clone`, a
 * clone of `sup` with its submodule not initialized (origin `../sup`: URLs stay in the twin).
 */
const BASIC = `
git init -q -b main up; (cd up; echo x > x; git add x; git commit -qm x; git tag -a -m v1 v1
  echo y > y; git add y; git commit -qm y; git branch dev)
git init -q -b main sup; (cd sup; echo a > a; git add a; git commit -qm a
  git submodule add -q ../up sub; git commit -qm sub)
git clone -q sup clone; git -C clone remote set-url origin ../sup
`;

/**
 * BASIC with `clone`'s submodule initialized and checked out, then `up` and `sup` moved on
 * (`z` in up, sup's gitlink at it) and pulled into `clone`: its submodule is behind.
 */
const BEHIND = `${BASIC}
(cd clone; git submodule -q update --init)
(cd up; echo z > z; git add z; git commit -qm z)
(cd sup/sub; git pull -q origin main); (cd sup; git commit -qam moved)
(cd clone; git pull -q --no-recurse-submodules)
`;

/** BEHIND, the new commit changing `y` too. */
const BEHIND_Y = `${BASIC}
(cd clone; git submodule -q update --init)
(cd up; echo z > z; echo y2 > y; git add z y; git commit -qm z)
(cd sup/sub; git pull -q origin main); (cd sup; git commit -qam moved)
(cd clone; git pull -q --no-recurse-submodules)
`;

/** BEHIND with clone's submodule on its branch main (at y), not detached. */
const BEHIND_ON_MAIN = `${BEHIND}
(cd clone/sub; git checkout -q main)
`;

describeGit(
  "git submodule update and status (t7406-submodule-update, t7400-submodule-basic)",
  () => {
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "submodule-update-"));
    });
    afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

    it('t7406-submodule-update.sh: "submodule update detaching the HEAD " (t7400 "update --init")', async () => {
      const t = twins(BASIC);
      await expectTwins(t, [
        status([]),
        update([]),
        update(["sub"], (c) => c.addPath("sub")),
        update(["--init"], (c) => c.setInit(true)),
        status([]),
        status(["--cached"], (c) => c.setCached(true)),
        both("cd sub; git checkout -q HEAD~1"),
        status([]),
        status(["--cached"], (c) => c.setCached(true)),
        update([]),
        status(["--quiet"], (c) => c.setQuiet(true)),
      ]);
    });

    it('t7400-submodule-basic.sh: "status should fail for unmapped paths", "status should only print one line"', async () => {
      const t = twins(`${BASIC}
(cd clone; git submodule -q update --init; git config -f .gitmodules submodule.sub.path other)
`);
      await expectTwins(t, [status([]), status(["nope"], (c) => c.addPath("nope"))]);
    });

    it('t7400-submodule-basic.sh: "the --cached sha1 should be rev1", "update should checkout rev1"', async () => {
      const t = twins(BEHIND);
      await expectTwins(t, [
        status([]),
        status(["--cached"], (c) => c.setCached(true)),
        update([]),
        status([]),
      ]);
    });

    it('t7406-submodule-update.sh: "submodule update does not fetch already present commits"', async () => {
      const t = twins(`${BEHIND}
(cd clone/sub; git fetch -q)
`);
      await expectTwins(t, [update([])]);
    });

    it('t7406-submodule-update.sh: "submodule update --rebase staying on main"', async () => {
      const t = twins(BEHIND_ON_MAIN);
      await expectTwins(t, [update(["--rebase"], (c) => c.setMode("rebase")), status([])]);
    });

    it('t7406-submodule-update.sh: "submodule update --merge staying on main"', async () => {
      const t = twins(BEHIND_ON_MAIN);
      await expectTwins(t, [update(["--merge"], (c) => c.setMode("merge")), status([])]);
    });

    it('t7406-submodule-update.sh: "submodule update - rebase in .git/config", "submodule update - merge in .git/config"', async () => {
      const t = twins(`${BEHIND_ON_MAIN}
(cd clone/sub; echo w > w; git add w; git commit -qm w)
`);
      await expectTwins(t, [
        both("git config submodule.sub.update rebase"),
        update([]),
        both("git config submodule.sub.update merge; cd sub; git reset -q --hard HEAD~1"),
        update([]),
      ]);
    });

    it('t7406-submodule-update.sh: "submodule update - checkout in .git/config but --rebase given", "submodule update - checkout in .git/config"', async () => {
      const t = twins(BEHIND_ON_MAIN);
      await expectTwins(t, [
        both("git config submodule.sub.update checkout"),
        update(["--rebase"], (c) => c.setMode("rebase")),
        both("cd sub; git checkout -q HEAD~1"),
        update([]),
      ]);
    });

    it('t7406-submodule-update.sh: "submodule update - command in .git/config", "submodule update - command in .git/config catches failure"', async () => {
      const t = twins(BEHIND);
      await expectTwins(t, [
        both("git config submodule.sub.update '!echo run'"),
        update([]),
        both("git config submodule.sub.update '!false'"),
        update([]),
      ]);
    });

    it('t7406-submodule-update.sh: "submodule update - command in .gitmodules is rejected"', async () => {
      const t = twins(`${BEHIND}
(cd clone; git config -f .gitmodules submodule.sub.update '!false')
`);
      await expectTwins(t, [update([])]);
    });

    it('t7406-submodule-update.sh: "submodule update - update=none in .git/config", "submodule update - update=none in .git/config but --checkout given"', async () => {
      const t = twins(BEHIND);
      await expectTwins(t, [
        both("git config submodule.sub.update none"),
        update([]),
        update(["--checkout"], (c) => c.setMode("checkout")),
      ]);
    });

    it('t7406-submodule-update.sh: "submodule update --init skips submodule with update=none"', async () => {
      const t = twins(`${BASIC}
(cd clone; git config -f .gitmodules submodule.sub.update none)
`);
      await expectTwins(t, [update(["--init"], (c) => c.setInit(true)), status([])]);
    });

    it('t7406-submodule-update.sh: "submodule update ignores update=merge config for new submodules", "submodule update --rebase - ignores --rebase for new submodules"', async () => {
      const t = twins(BASIC);
      await expectTwins(t, [
        both("git submodule -q init; git config submodule.sub.update merge"),
        update([]),
        both("git submodule -q deinit -f sub; rm -rf .git/modules/sub; git submodule -q init"),
        update(["--rebase"], (c) => c.setMode("rebase")),
      ]);
    });

    it('t7406-submodule-update.sh: "submodule update should fail due to local changes", "submodule update should throw away changes with --force "', async () => {
      const t = twins(`${BEHIND}
(cd clone/sub; echo local > y)
`);
      await expectTwins(t, [update([]), update(["--force"], (c) => c.setForce(true))]);
    });

    it('t7406-submodule-update.sh: "submodule update --force forcibly checks out submodules"', async () => {
      const t = twins(`${BASIC}
(cd clone; git submodule -q update --init; cd sub; echo dirt > x)
`);
      await expectTwins(t, [update([]), update(["-f"], (c) => c.setForce(true))]);
    });

    it('t7406-submodule-update.sh: "submodule update --remote should fetch upstream changes", "update --remote falls back to using HEAD"', async () => {
      const t = twins(`${BASIC}
(cd clone; git submodule -q update --init)
(cd up; echo r > r; git add r; git commit -qm r)
`);
      await expectTwins(t, [update(["--remote"], (c) => c.setRemote(true)), status([])]);
    });

    it('t7406-submodule-update.sh: "local config should override .gitmodules branch", "submodule update --remote should fetch upstream changes with ."', async () => {
      const t = twins(`${BASIC}
(cd clone; git submodule -q update --init; git config -f .gitmodules submodule.sub.branch main)
(cd up; git checkout -q dev; echo d > d; git add d; git commit -qm d; git checkout -q main)
`);
      await expectTwins(t, [
        both("git config submodule.sub.branch dev"),
        update(["--remote"], (c) => c.setRemote(true)),
        both("git config submodule.sub.branch .; git checkout -q -b dev"),
        update(["--remote", "--merge"], (c) => c.setRemote(true).setMode("merge")),
        both("git checkout -q --detach"),
        update(["--remote"], (c) => c.setRemote(true)),
      ]);
    });

    it('t7406-submodule-update.sh: "submodule update exit immediately in case of merge conflict"', async () => {
      const t = twins(`${BEHIND_ON_MAIN}
(cd clone/sub; echo mine > z; git add z; git commit -qm mine)
`);
      await expectTwins(t, [update(["--merge"], (c) => c.setMode("merge"))]);
    });

    it('t7406-submodule-update.sh: "submodule update with pathspec warns against uninitialized ones", "submodule update without pathspec updates only initialized ones"', async () => {
      const t = twins(`${BASIC}
(cd sup; git submodule add -q ../up other; git commit -qm other)
(cd clone; git pull -q --no-recurse-submodules; git submodule -q init sub)
`);
      await expectTwins(t, [update(["other", "sub"], (c) => c.addPath("other").addPath("sub"))]);
      const t2 = twins(`${BASIC}
(cd sup; git submodule add -q ../up other; git commit -qm other)
(cd clone; git pull -q; git submodule -q init sub)
`);
      await expectTwins(t2, [update([])]);
    });

    it('t7406-submodule-update.sh: "submodule update places git-dir in superprojects git-dir recursive"', async () => {
      const t = twins(`
git init -q -b main deep; (cd deep; echo d > d; git add d; git commit -qm d)
git init -q -b main up; (cd up; echo x > x; git add x; git commit -qm x
  git submodule add -q ../deep deeper; git commit -qm deeper)
git init -q -b main sup; (cd sup; echo a > a; git add a; git commit -qm a
  git submodule add -q ../up sub; git commit -qm sub)
git clone -q sup clone; git -C clone remote set-url origin ../sup
`);
      await expectTwins(t, [
        update(["--init", "--recursive"], (c) => c.setInit(true).setRecursive(true)),
        status(["--recursive"], (c) => c.setRecursive(true)),
        both("cd sub/deeper; git checkout -q --detach; echo e > e; git add e; git commit -qm e"),
        status(["--recursive"], (c) => c.setRecursive(true)),
        status(["--recursive", "--cached"], (c) => c.setRecursive(true).setCached(true)),
        update(["--recursive"], (c) => c.setRecursive(true)),
      ]);
    });

    it('t7406-submodule-update.sh: "submodule update properly revives a moved submodule" (SubmoduleUpdateTest.updateModeCheckoutClonedRestoredSubmodule)', async () => {
      const t = twins(`${BASIC}
(cd clone; git submodule -q update --init)
`);
      await expectTwins(t, [
        both("rm -rf sub; mkdir sub"),
        update([]),
        both("rm -rf sub .git/modules/sub; mkdir sub"),
        update([]),
        status([]),
      ]);
    });

    it('t7406-submodule-update.sh: "submodule update clone shallow submodule"', async () => {
      const t = twins(`${BASIC}
(cd clone; git config -f .gitmodules submodule.sub.shallow true
  git config -f .gitmodules submodule.sub.url "file://$(cd ../up; pwd)")
`);
      await expectTwins(t, [
        update(["--init"], (c) => c.setInit(true)),
        both("git submodule -q deinit -f sub; rm -rf .git/modules/sub"),
        update(["--init", "--no-recommend-shallow"], (c) =>
          c.setInit(true).setRecommendShallow(false),
        ),
        both("git submodule -q deinit -f sub; rm -rf .git/modules/sub"),
        update(["--init", "--no-recommend-shallow", "--depth", "1"], (c) =>
          c.setInit(true).setRecommendShallow(false).setDepth(1),
        ),
      ]);
    });

    it('t7406-submodule-update.sh: "submodule update --quiet passes quietness to merge/rebase"', async () => {
      const t = twins(BEHIND_ON_MAIN);
      await expectTwins(t, [
        update(["--quiet", "--rebase"], (c) => c.setQuiet(true).setMode("rebase")),
        both("cd sub; git reset -q --hard HEAD~1"),
        update(["--quiet", "--merge"], (c) => c.setQuiet(true).setMode("merge")),
      ]);
    });

    it('t7400-submodule-basic.sh: "update should fail when path is used by a file", "update should fail when path is used by a nonempty directory", "update should work when path is an empty dir"', async () => {
      const t = twins(`${BASIC}
(cd clone; git submodule -q init; rmdir sub; echo f > sub)
`);
      await expectTwins(t, [
        update([]),
        both("rm sub; mkdir sub; echo f > sub/f"),
        update([]),
        both("rm -rf sub; mkdir sub"),
        update([]),
      ]);
    });

    it("a failed clone is retried once, then the update aborts (update_clone_task_finished)", async () => {
      const t = twins(`${BASIC}
(cd clone; git config -f .gitmodules submodule.sub.url ../nowhere)
`);
      await expectTwins(t, [update(["--init"], (c) => c.setInit(true)), status([])]);
    });

    it('t7406-submodule-update.sh: "submodule update continues after checkout error"', async () => {
      const t = twins(`${BEHIND}
(cd sup; git submodule add -q ../up second; git commit -qm second)
(cd clone; git pull -q --no-recurse-submodules; git submodule -q update --init second
  echo local > sub/y)
(cd up; echo q > q; git add q; git commit -qm q)
(cd sup/second; git pull -q origin main); (cd sup; git commit -qam second-moved)
(cd clone; git pull -q --no-recurse-submodules)
`);
      await expectTwins(t, [update([]), status([])]);
    });

    it('t7406-submodule-update.sh: "submodule update should fail due to local changes" (an untracked file the target adds)', async () => {
      const t = twins(`${BEHIND}
(cd clone/sub; echo untracked > z)
`);
      await expectTwins(t, [update([]), status([]), update(["--force"], (c) => c.setForce(true))]);
    });

    it('t7406-submodule-update.sh: "submodule update should fail due to local changes" (a tracked file the target changes)', async () => {
      const t = twins(`${BEHIND_Y}
(cd clone/sub; echo local > y)
`);
      await expectTwins(t, [update([]), status([])]);
    });

    it('t7406-submodule-update.sh: "submodule update - merge in .git/config", "submodule update - rebase in .git/config" (refused by local changes)', async () => {
      const t = twins(`${BEHIND_Y}
(cd clone/sub; git checkout -q main; echo local > y)
`);
      await expectTwins(t, [
        update(["--merge"], (c) => c.setMode("merge")),
        update(["--rebase"], (c) => c.setMode("rebase")),
      ]);
    });

    it('t7406-submodule-update.sh: "submodule update can handle symbolic links in pwd" (a symbolic link at the submodule path)', async () => {
      // git 2.43.0 has no validate_submodule_path (it follows the link and updates through it);
      // ours refuses under 2.43 compatibility too, a deliberate divergence for safety
      if (compatibility === "2.43") return;
      const t = twins(`${BEHIND}
(cd clone; mv sub real; ln -s real sub)
`);
      await expectTwins(t, [update([]), status([])]);
      const t2 = twins(`${BASIC}
(cd clone; git submodule -q init; rmdir sub; mkdir real; ln -s real sub)
`);
      await expectTwins(t2, [update([])]);
    });

    it('t7400-submodule-basic.sh: "submodule update aborts on missing gitmodules url"', async () => {
      const t = twins(`${BASIC}
(cd clone; git submodule -q init; git config --unset submodule.sub.url
  git config -f .gitmodules --unset submodule.sub.url; git config submodule.sub.active true)
`);
      await expectTwins(t, [update([])]);
    });
  },
);

describeGit(
  "git submodule update and status (JGit SubmoduleUpdateTest, SubmoduleStatusTest)",
  () => {
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "submodule-update-jgit-"));
    });
    afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

    it("SubmoduleUpdateTest.repositoryWithNoSubmodules, SubmoduleStatusTest.repositoryWithNoSubmodules", async () => {
      const t = twins("git init -q -b main sup; cd sup; echo a > a; git add a; git commit -qm a");
      await expectTwins(t, [update([]), status([])], "sup");
    });

    it("SubmoduleUpdateTest.repositoryWithUnconfiguredSubmodule, SubmoduleStatusTest.repositoryWithUninitializedSubmodule", async () => {
      const t = twins(BASIC);
      await expectTwins(t, [update([]), status([])]);
    });

    it("SubmoduleUpdateTest.repositoryWithInitializedSubmodule, SubmoduleStatusTest.repositoryWithMissingSubmodule", async () => {
      const t = twins(`
git init -q -b main sup; cd sup; echo a > a; git add a; git commit -qm a
git update-index --add --cacheinfo 160000,$(git rev-parse HEAD),sub
mkdir sub; git -C sub init -q
`);
      await expectTwins(t, [update([]), status([])], "sup");
    });

    it("SubmoduleStatusTest.repositoryWithNoHeadInSubmodule, repositoryWithNoSubmoduleRepository", async () => {
      const t = twins(`${BASIC}
(cd clone; git submodule -q init; git -C sub init -q)
`);
      await expectTwins(t, [status([]), both("rm -rf sub/.git"), status([])]);
    });

    it("SubmoduleStatusTest.repositoryWithInitializedSubmodule, repositoryWithDifferentRevCheckedOutSubmodule", async () => {
      const t = twins(`${BASIC}
(cd clone; git submodule -q update --init)
`);
      await expectTwins(t, [
        status([]),
        both("cd sub; git checkout -q main; echo n > n; git add n; git commit -qm n"),
        status([]),
      ]);
    });

    it("SubmoduleUpdateTest.updateMode, updateModeMergeClonedRestoredSubmodule, updateModeRebaseClonedRestoredSubmodule", async () => {
      const t = twins(BASIC);
      await expectTwins(t, [
        both("git submodule -q init; git config submodule.sub.update rebase"),
        update([]),
        both("cd sub; git checkout -q main"),
        update([]),
        both("git config submodule.sub.update checkout"),
        update([]),
        both("git config submodule.sub.update merge; cd sub; git checkout -q main"),
        update([]),
        both("rm -rf sub .git/modules/sub; mkdir sub"),
        update([]),
      ]);
    });
  },
);

/** git-submodule.sh clones with GIT_PROTOCOL_FROM_USER=0: `test:` is allowed only by config. */
const TEST_PROTOCOL_ENV = (): Record<string, string> => ({
  ...testEnv(root),
  GIT_CONFIG_PARAMETERS: "'protocol.file.allow'='always' 'protocol.test.allow'='always'",
});

/**
 * `test://<host>/<repo>` serving `<twin>/<repo>` (whatever the host) through `g`'s working
 * copy (`clone`), each connect recorded as `<host><path> <user>:<password> <Authorization>`.
 */
function testTransports(g: Git, calls: string[]): GitTransportRegistry {
  const transports = createDefaultTransports();
  transports.register({
    name: "test-native",
    schemes: ["test"],
    async connect(request: GitConnectRequest) {
      const creds = request.credentials
        ? `${request.credentials.username}:${request.credentials.password}`
        : "-";
      calls.push(
        `${request.url.host}${request.url.path} ${creds} ${request.headers?.Authorization ?? "-"}`,
      );
      const repo = await openLocalRemote(g.workingCopy, `..${request.url.path}`);
      const [client, server] = createDuplexPair();
      const head = await repo.history.refs.get("HEAD");
      void serveOverDuplex({
        duplex: server,
        repository: createRepositoryFacade({ history: repo.history }),
        refStore: createTransportRefStore(repo.history.refs),
        service: request.service,
        bare: repo.bare,
        ...(head && "target" in head ? { currentBranch: head.target } : {}),
        ...(request.protocolVersion === 2 ? { protocolVersion: "2" as const } : {}),
      }).finally(() => server.close?.());
      return { kind: "native", duplex: client, handshake: "implicit" };
    },
  });
  return transports;
}

const SECRET = { username: "alice", password: "token-for-trusted" };
const SECRET_HEADERS = { Authorization: "Bearer trusted-only" };

/**
 * `deep` (a commit), `up` with `deep` as submodule at `<deepUrl>`, `sup` with `up` as `sub`,
 * and `clone` of `sup` whose remote is `test://trusted.example/sup` (so `../up` resolves to
 * `test://trusted.example/up`) and whose `sub` URL is `<subUrl>`.
 */
const nested = (subUrl: string, deepUrl: string) => `
git init -q -b main deeper; (cd deeper; echo e > e; git add e; git commit -qm e)
git init -q -b main deep; (cd deep; echo d > d; git add d; git commit -qm d
  git submodule add -q ../deeper deeper
  git config -f .gitmodules submodule.deeper.url test://evil.example/deeper
  git add .gitmodules; git commit -qm deeper)
git init -q -b main up; (cd up; echo x > x; git add x; git commit -qm x
  git submodule add -q ../deep deep; git config -f .gitmodules submodule.deep.url ${deepUrl}
  git add .gitmodules; git commit -qm deep)
git init -q -b main sup; (cd sup; echo a > a; git add a; git commit -qm a
  git submodule add -q ../up sub; git commit -qm sub)
git clone -q sup clone; git -C clone remote set-url origin test://trusted.example/sup
git -C clone config -f .gitmodules submodule.sub.url ${subUrl}
`;

describeGit("git submodule update through the superproject's transports", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "submodule-update-transports-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it("clones and fetches go through the given connector, with credentials for a named origin", async () => {
    const t = twins(`${BASIC}
(cd clone; git config -f .gitmodules submodule.sub.url test://host/up)
`);
    const env = TEST_PROTOCOL_ENV();
    const calls: string[] = [];
    const g = await ours(t, "clone", env);
    const first = await g
      .submoduleUpdate()
      .setInit(true)
      .setTransports(testTransports(g, calls))
      .setCredentials({ username: "u", password: "p" })
      .addCredentialOrigin("test://host")
      .call();
    expect(first.stdout).toMatch(/^Submodule path 'sub': checked out '[0-9a-f]{40}'\n$/);
    expect(calls).toEqual(["host/up u:p -"]);
    sh(join(t.ours, "up"), "echo r > r; git add r; git commit -qm r");
    const g2 = await ours(t, "clone", env);
    await g2
      .submoduleUpdate()
      .setRemote(true)
      .setTransports(testTransports(g2, calls))
      .setCredentials({ username: "u", password: "p" })
      .addCredentialOrigin("test://host/anything")
      .call();
    expect(calls).toEqual(["host/up u:p -", "host/up u:p -"]);
    expect(ask(join(t.ours, "clone/sub"), ["rev-parse", "HEAD"])).toBe(
      ask(join(t.ours, "up"), ["rev-parse", "HEAD"]),
    );
  });

  it("static credentials and headers reach the superproject's origin, never a nested submodule's other host (depth 2 and 3)", async () => {
    const t = twins(nested("../up", "test://evil.example/deep"));
    const calls: string[] = [];
    const g = await ours(t, "clone", TEST_PROTOCOL_ENV());
    const result = await g
      .submoduleUpdate()
      .setInit(true)
      .setRecursive(true)
      .setTransports(testTransports(g, calls))
      .setCredentials(SECRET)
      .setHeaders(SECRET_HEADERS)
      .call();
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      "trusted.example/up alice:token-for-trusted Bearer trusted-only",
      "evil.example/deep - -",
      "evil.example/deeper - -",
    ]);
    // and later fetches inside the nested submodules: still nothing for evil.example
    sh(join(t.ours, "deep"), "echo n > n; git add n; git commit -qm n");
    calls.length = 0;
    const g2 = await ours(t, "clone", TEST_PROTOCOL_ENV());
    await g2
      .submoduleUpdate()
      .setRemote(true)
      .setRecursive(true)
      .setTransports(testTransports(g2, calls))
      .setCredentials(SECRET)
      .setHeaders(SECRET_HEADERS)
      .call();
    expect(calls.filter((c) => c.startsWith("evil.example"))).not.toHaveLength(0);
    for (const call of calls.filter((c) => c.startsWith("evil.example"))) {
      expect(call).not.toMatch(/alice|token|Bearer/);
    }
  });

  it("a submodule at another host than the superproject's gets no static credentials (depth 1)", async () => {
    const t = twins(nested("test://evil.example/up", "test://evil.example/deep"));
    const calls: string[] = [];
    const g = await ours(t, "clone", TEST_PROTOCOL_ENV());
    await g
      .submoduleUpdate()
      .setInit(true)
      .setRecursive(true)
      .setTransports(testTransports(g, calls))
      .setCredentials(SECRET)
      .setHeaders(SECRET_HEADERS)
      .call();
    expect(calls).toEqual([
      "evil.example/up - -",
      "evil.example/deep - -",
      "evil.example/deeper - -",
    ]);
  });

  it("per-URL providers are asked with each URL, and their answers go to that URL alone", async () => {
    const t = twins(nested("../up", "test://evil.example/deep"));
    const calls: string[] = [];
    const asked: string[] = [];
    const g = await ours(t, "clone", TEST_PROTOCOL_ENV());
    await g
      .submoduleUpdate()
      .setInit(true)
      .setRecursive(true)
      .setTransports(testTransports(g, calls))
      .setCredentialsForUrl((url) => {
        asked.push(url);
        return url.startsWith("test://trusted.example/") ? SECRET : undefined;
      })
      .setHeadersForUrl((url) =>
        url.startsWith("test://trusted.example/") ? SECRET_HEADERS : undefined,
      )
      .call();
    expect(asked).toEqual([
      "test://trusted.example/up",
      "test://evil.example/deep",
      "test://evil.example/deeper",
    ]);
    expect(calls).toEqual([
      "trusted.example/up alice:token-for-trusted Bearer trusted-only",
      "evil.example/deep - -",
      "evil.example/deeper - -",
    ]);
  });
});

/** A smart-HTTP server of `<twin>/<repo>` repositories, recording each request's secrets. */
interface RecordingServer {
  origin: string;
  /** `<path> <Authorization or -> <X-Token or ->` per request */
  seen: string[];
  close(): Promise<void>;
}

/**
 * Serves the repositories of `twin` over real HTTP on loopback; paths under `/moved/`
 * redirect (307, the method and body kept) to `redirectTo` with the rest of the path, when given.
 */
async function recordingServer(
  twin: () => string,
  redirectTo?: () => string,
): Promise<RecordingServer> {
  const seen: string[] = [];
  const handler = createFetchHandler({
    resolveRepository: async (repoPath) => {
      const name = repoPath.replace(/^\/+|\/+$/g, "");
      if (!/^[a-z]+$/.test(name)) return null;
      const files = createNodeFilesApi({ rootDir: join(twin(), name) });
      const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
      return {
        repository: createRepositoryFacade({ history }),
        refStore: createTransportRefStore(history.refs),
      };
    },
  });
  const server = await serveOnLoopback(async (request) => {
    const url = new URL(request.url);
    seen.push(
      `${url.pathname} ${request.headers.get("authorization") ?? "-"} ${request.headers.get("x-token") ?? "-"}`,
    );
    if (redirectTo && url.pathname.startsWith("/moved/")) {
      const rest = url.pathname.slice("/moved".length) + url.search;
      return new Response(null, { status: 307, headers: { location: `${redirectTo()}${rest}` } });
    }
    return handler(request);
  });
  return { origin: server.baseUrl, seen, close: () => server.close() };
}

const HTTP_SECRET = { username: "alice", password: "secret" };
const HTTP_HEADERS = { "X-Token": "token-for-trusted" };
const BASIC_ALICE = `Basic ${btoa("alice:secret")}`;

describeGit("git submodule update over HTTP: credentials never leave their origin", () => {
  let trusted: RecordingServer;
  let evil: RecordingServer;
  let t: Twins;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "submodule-update-http-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  /**
   * `deep`, `up` (with `deep` at `<deepUrl>`), `sup` and `clone` (remote
   * `<trusted>/sup`, `sub` at `<subUrl>`); `$T`/`$E` in the URLs are the two servers'
   * `127.0.0.1:<port>`.
   */
  async function setup(subUrl: string, deepUrl = "../deep"): Promise<void> {
    let dir = "";
    evil = await recordingServer(() => dir);
    trusted = await recordingServer(
      () => dir,
      () => evil.origin,
    );
    const fill = (u: string) =>
      u.replace(/\$T/g, trusted.origin.slice(7)).replace(/\$E/g, evil.origin.slice(7));
    t = twins(`
git init -q -b main deep; (cd deep; echo d > d; git add d; git commit -qm d)
git init -q -b main up; (cd up; echo x > x; git add x; git commit -qm x
  git submodule add -q ../deep deep
  git config -f .gitmodules submodule.deep.url '${fill(deepUrl)}'; git add .gitmodules
  git commit -qm deep)
git init -q -b main sup; (cd sup; echo a > a; git add a; git commit -qm a
  git submodule add -q ../up sub; git commit -qm sub)
git clone -q sup clone; git -C clone remote set-url origin '${trusted.origin}/sup'
git -C clone config -f .gitmodules submodule.sub.url '${fill(subUrl)}'
`);
    dir = t.ours;
  }

  afterEach(async () => {
    await trusted?.close();
    await evil?.close();
  });

  async function update(): Promise<SubmoduleCommandResult> {
    const env = {
      ...testEnv(root),
      GIT_CONFIG_PARAMETERS: "'protocol.file.allow'='always' 'protocol.http.allow'='always'",
    };
    const g = await ours(t, "clone", env);
    return oursRun(() =>
      g
        .submoduleUpdate()
        .setInit(true)
        .setRecursive(true)
        .setCredentials(HTTP_SECRET)
        .setHeaders(HTTP_HEADERS)
        .call(),
    );
  }

  const leaked = (s: RecordingServer) => s.seen.filter((line) => !line.endsWith(" - -"));

  it("the superproject's origin gets them, at depth 1 and 2", async () => {
    await setup("../up", "http://$T/deep");
    const result = await update();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(trusted.seen.length).toBeGreaterThan(0);
    for (const line of trusted.seen) expect(line).toMatch(` ${BASIC_ALICE} token-for-trusted`);
  });

  it("a backslash in the authority (WHATWG reads it as `/`): nothing reaches the other host", async () => {
    await setup("http://$E\\@$T/up");
    await update();
    expect(evil.seen.length).toBeGreaterThan(0);
    expect(leaked(evil)).toEqual([]);
    await t2(() => setup("../up", "http://$E\\@$T/deep"));
  });

  /**
   * Runs a second setup in the same test (depth 2: the nested URL the crafted one) and
   * checks no request carried a secret to the other host (nor, with `clean`, to any host).
   */
  async function t2(again: () => Promise<void>, clean = false): Promise<void> {
    await trusted.close();
    await evil.close();
    await again();
    await update();
    expect(leaked(evil)).toEqual([]);
    if (clean) expect(leaked(trusted).filter((l) => !l.startsWith("/up/"))).toEqual([]);
  }

  it("`%2f`/`%40`/`%3a` in the authority: no secret reaches either host for that URL", async () => {
    await setup("http://$E%2f@$T/up");
    await update();
    expect(leaked(evil)).toEqual([]);
    expect(leaked(trusted)).toEqual([]);
    await t2(() => setup("../up", "http://$E%40$T/deep"), true);
    await t2(() => setup("../up", "http://$E%3a@$T/deep"), true);
  });

  it("userinfo holding `@`: no secret reaches either host for that URL", async () => {
    await setup("http://a@$E@$T/up");
    await update();
    expect(leaked(evil)).toEqual([]);
    expect(leaked(trusted)).toEqual([]);
    await t2(() => setup("../up", "http://a@$E@$T/deep"), true);
    await t2(() => setup("../up", "http://a@$T@$E/deep"), true);
  });

  it("a redirect from the trusted server to another origin goes there without them", async () => {
    await setup("http://$T/moved/up");
    const result = await update();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      trusted.seen.some((line) => line.startsWith("/moved/up/") && line.includes(BASIC_ALICE)),
    ).toBe(true);
    expect(evil.seen.length).toBeGreaterThan(0);
    expect(leaked(evil)).toEqual([]);
    await t2(() => setup("../up", "http://$T/moved/deep"));
  });

  it("strictUrlOrigin: one origin from git's and WHATWG's parses, none where they could differ", () => {
    expect(strictUrlOrigin("HTTPS://user@Git.Example.com:443/x.git")).toBe(
      "https://git.example.com",
    );
    expect(strictUrlOrigin("http://h:8080/x")).toBe("http://h:8080");
    expect(strictUrlOrigin("git@example.com:org/x.git")).toBe("ssh://example.com");
    expect(strictUrlOrigin("ssh://git@example.com:22/x")).toBe("ssh://example.com");
    expect(strictUrlOrigin("git://example.com:9419/x")).toBe("git://example.com:9419");
    for (const url of [
      "http://127.0.0.1:1\\@localhost:2/up",
      "http://evil%2f@trusted/x",
      "http://evil%40trusted/x",
      "http://a@b@trusted/x",
      "http://tr usted/x",
      "http://trüsted/x",
      "http://trusted\t/x",
      "ssh://evil.example%2f@trusted.example/x",
      "ssh://evil.example\\@trusted.example/x",
      "git://evil%2f@trusted/x",
      "evil%2f@trusted:x",
      "https::https://trusted/x",
      "file:///srv/x",
      "../up",
      "/srv/x",
    ]) {
      expect(strictUrlOrigin(url), url).toBeUndefined();
    }
  });
});
