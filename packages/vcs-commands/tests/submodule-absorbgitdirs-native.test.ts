/**
 * `git submodule absorbgitdirs` against native git (submodule.c's
 * `absorb_git_dir_into_superproject`): each scenario is built once with native git, copied
 * into twins, and every step runs `git submodule ...` in one twin and our command in the
 * other; stdout, stderr, the exit status and the resulting gitfiles, `.git/modules/` layout,
 * configs (`core.worktree`) and worktree are compared after each step, and native git must
 * still read our result (`git status`, `git fsck` in each submodule).
 *
 * Inputs come from git's t7412-submodule-absorbgitdirs.sh and t7400-submodule-basic.sh
 * (deinit's absorption); the `extensions.submodulePathConfig` layout follows
 * t7425-submodule-gitdir-path-extension.sh's setup.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, SubmoduleCommandError, type SubmoduleCommandResult } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";
import { testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const versionLine = nativeGitAvailable() ? execFileSync("git", ["--version"]).toString() : "";
const is25x = gitAtLeast(versionLine, 2, 50);
const hasPathConfig = gitAtLeast(versionLine, 2, 52);
const compatibility = is25x ? "2.56" : "2.43";

let root: string;
let caseNo = 0;

/** Runs a bash script with native git's test environment (fixtures, checks). */
function sh(cwd: string, script: string): string {
  return execFileSync("bash", ["-euc", script], {
    cwd,
    env: { ...testEnv(root), GIT_CONFIG_PARAMETERS: "'protocol.file.allow'='always'" },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("latin1");
}

/** A fixture built by `script` in a new directory, copied into a native and an ours twin. */
function twins(script: string): { native: string; ours: string } {
  const base = join(root, `case${++caseNo}`);
  const build = join(base, "build");
  execFileSync("mkdir", ["-p", build]);
  sh(build, script);
  const native = join(base, "native");
  const ours = join(base, "ours");
  execFileSync("cp", ["-a", build, native]);
  execFileSync("cp", ["-a", build, ours]);
  return { native, ours };
}

/** The state compared: worktree files, gitfiles, configs and the modules layout. */
function snapshot(dir: string, twin: string): Record<string, string> {
  const out: Record<string, string> = {};
  const norm = (s: string) => s.split(twin).join("<T>");
  const walkGitDir = (abs: string, rel: string) => {
    const config = join(abs, "config");
    if (existsSync(config)) out[`${rel}/config`] = norm(readFileSync(config, "latin1"));
    for (const f of ["HEAD", "index"]) {
      if (existsSync(join(abs, f))) out[`${rel}/${f}`] = "present";
    }
    const modules = join(abs, "modules");
    if (existsSync(modules)) walkModules(modules, `${rel}/modules`);
  };
  const walkModules = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      if (!lstatSync(p).isDirectory()) continue;
      out[`${rel}/${name}/`] = "dir";
      if (existsSync(join(p, "HEAD"))) walkGitDir(p, `${rel}/${name}`);
      else walkModules(p, `${rel}/${name}`);
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

/** Native `git submodule <args>` in `dir`. */
function nativeRun(dir: string, args: string[]): SubmoduleCommandResult {
  const r = spawnSync("git", ["submodule", ...args], { cwd: dir, env: testEnv(root) });
  return {
    stdout: r.stdout.toString("latin1"),
    stderr: r.stderr.toString("latin1"),
    exitCode: r.status ?? -1,
  };
}

/** Our working copy at `dir`, with native git's environment and a command runner. */
async function ours(dir: string): Promise<Git> {
  const env = testEnv(root);
  const environment = createNodeGitHostEnvironment({
    env,
    hookRunner: createNodeHookRunner({ env, compatibility }),
  });
  return openOurs(dir, environment, undefined, "", true);
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

type Step = [args: string[], run: (git: Git) => Promise<SubmoduleCommandResult>];

/** What native git reads in a twin: status, each submodule's HEAD, fsck of each. */
function readBack(dir: string, twin: string): string {
  return sh(
    dir,
    `{ git status --porcelain=v1 --ignore-submodules=none
git submodule foreach -q --recursive 'git rev-parse HEAD; git rev-parse --git-dir; git fsck -q 2>&1; git status --porcelain=v1'
} 2>&1 || echo "exit $?"`,
  )
    .split(twin)
    .join("<T>");
}

/** Runs each step in both twins (in `sub` of each), comparing outputs and states. */
async function expectTwins(t: { native: string; ours: string }, steps: Step[], sub = "sup") {
  for (const [args, run] of steps) {
    const label = `git submodule ${args.join(" ")}`;
    const n = nativeRun(join(t.native, sub), args);
    const o = await oursRun(async () => run(await ours(join(t.ours, sub))));
    const norm = (r: SubmoduleCommandResult, twin: string) => ({
      stdout: r.stdout.split(twin).join("<T>"),
      stderr: r.stderr.split(twin).join("<T>"),
      exitCode: r.exitCode,
    });
    expect(norm(o, t.ours), label).toEqual(norm(n, t.native));
    expect(snapshot(join(t.ours, sub), t.ours), label).toEqual(
      snapshot(join(t.native, sub), t.native),
    );
    expect(readBack(join(t.ours, sub), t.ours), label).toEqual(
      readBack(join(t.native, sub), t.native),
    );
  }
}

const absorb = (paths: string[] = []): Step => [
  ["absorbgitdirs", ...paths],
  (g) => {
    const c = g.submoduleAbsorbGitDirs();
    for (const p of paths) c.addPath(p);
    return c.call();
  },
];

/** t7412's setup: `sup` with the submodule `sub1` added from a repository in place. */
const SETUP = `
git init -q -b main sup; cd sup
git init -q -b main sub1; (cd sub1; echo first > first.t; git add first.t; git commit -qm first)
git submodule add -q ./sub1
git commit -qm superproject
`;

/** t7412's "setup nested submodule": `sub1/nested` added in place inside `sub1`. */
const NESTED = `
git init -q -b main sub1/nested
(cd sub1/nested; echo n > n.t; git add n.t; git commit -qm first_nested)
(cd sub1; git submodule add -q ./nested; git commit -qm "add nested")
git add sub1; git commit -qm "sub1 to include nested submodule"
`;

describeGit("git submodule absorbgitdirs (t7412)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "submodule-absorb-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t7412-submodule-absorbgitdirs.sh: "absorb the git dir"', async () => {
    const t = twins(SETUP);
    await expectTwins(t, [absorb(), absorb()]);
  });

  it("takes -q, pathspecs, and reports a pathspec matching nothing", async () => {
    const t = twins(`${SETUP}
git init -q -b main sub2; (cd sub2; echo s > s.t; git add s.t; git commit -qm s)
git submodule add -q ./sub2 dir/sub2
git commit -qm two
`);
    await expectTwins(t, [
      absorb(["nope"]),
      [
        ["--quiet", "absorbgitdirs", "--", "dir"],
        (g) => g.submoduleAbsorbGitDirs().setQuiet(true).addPath("dir").call(),
      ],
      absorb(["sub1"]),
    ]);
  });

  it('t7412-submodule-absorbgitdirs.sh: "absorbing does not fail for deinitialized submodules"', async () => {
    const t = twins(`${SETUP}
git submodule absorbgitdirs 2>/dev/null
git submodule deinit -q --all
`);
    await expectTwins(t, [absorb()]);
  });

  it('t7412-submodule-absorbgitdirs.sh: "absorb the git dir in a nested submodule"', async () => {
    const t = twins(`${SETUP}
git submodule absorbgitdirs 2>/dev/null
${NESTED}`);
    await expectTwins(t, [absorb()]);
  });

  it("absorbs a submodule and its nested submodule in one run", async () => {
    const t = twins(`${SETUP}${NESTED}`);
    await expectTwins(t, [absorb()]);
  });

  it('t7412-submodule-absorbgitdirs.sh: "re-setup nested submodule"', async () => {
    // sub1 un-absorbed again with its nested submodule's repository inside sub1/.git: the
    // nested gitfile must be rewritten once sub1's git directory has moved
    const t = twins(`${SETUP}
git submodule absorbgitdirs 2>/dev/null
${NESTED}
git submodule absorbgitdirs 2>/dev/null
rm -rf sub1/.git
mv .git/modules/sub1 sub1/.git
GIT_WORK_TREE=. git -C sub1 config --unset core.worktree
echo "gitdir: ../.git/modules/nested" >sub1/nested/.git
GIT_WORK_TREE=../../../nested git -C sub1/.git/modules/nested config core.worktree "../../../nested"
git status --ignore-submodules=none >/dev/null
`);
    await expectTwins(t, [absorb()]);
  });

  it('t7412-submodule-absorbgitdirs.sh: "absorbing the git dir fails for incomplete submodules"', async () => {
    const t = twins(`${SETUP}
git submodule absorbgitdirs 2>/dev/null
git init -q -b main sub2; (cd sub2; echo s > s.t; git add s.t; git commit -qm first)
git add sub2 2>/dev/null; git commit -qm superproject
`);
    await expectTwins(t, [absorb(), absorb(["sub2"])]);
  });

  it('t7412-submodule-absorbgitdirs.sh: "absorbing fails for a submodule with multiple worktrees"', async () => {
    const t = twins(`${SETUP}
git init -q -b main sub3; (cd sub3; echo s > s.t; git add s.t; git commit -qm first)
git submodule add -q ./sub3
git commit -qm "add another submodule"
git -C sub3 worktree add -q ../sub3_second_work_tree
`);
    await expectTwins(t, [absorb(["sub3"]), absorb(["sub1"])]);
  });

  it("refuses broken gitfiles as git does, and leaves gitfiles naming other places", async () => {
    const t = twins(`${SETUP}
git init -q -b main sub2; (cd sub2; echo s > s.t; git add s.t; git commit -qm s)
git submodule add -q ./sub2
git init -q -b main sub3; (cd sub3; echo s > s.t; git add s.t; git commit -qm s)
git submodule add -q ./sub3
git commit -qm more
mv sub2/.git ../elsewhere.git
echo "gitdir: ../../elsewhere.git" > sub2/.git
echo "garbage" > sub3/.git.new; rm -rf sub3/.git; mv sub3/.git.new sub3/.git
git init -q -b main sub4; (cd sub4; echo s > s.t; git add s.t; git commit -qm s)
git submodule add -q ./sub4; git commit -qm sub4
rm -rf sub4/.git; mkdir sub4/.git
`);
    await expectTwins(t, [absorb(["sub2"]), absorb(["sub3"]), absorb(["sub4"]), absorb(["sub1"])]);
  });

  it('t7412-submodule-absorbgitdirs.sh: "absorb the git dir outside of primary worktree"', async () => {
    const t = twins(`${SETUP}
git submodule absorbgitdirs 2>/dev/null
cd ..
git clone -q --bare sup repo-bare.git
git -C repo-bare.git worktree add -q ../repo-wt
git -C repo-wt submodule -q update --init
git init -q -b main repo-wt/sub2; (cd repo-wt/sub2; echo A > A.t; git add A.t; git commit -qm A)
git -C repo-wt submodule add -q ./sub2 sub2
`);
    // the worktree's links name the build directory: point them at each twin
    for (const twin of [t.native, t.ours]) {
      sh(
        twin,
        'echo "gitdir: $PWD/repo-bare.git/worktrees/repo-wt" > repo-wt/.git; echo "$PWD/repo-wt/.git" > repo-bare.git/worktrees/repo-wt/gitdir',
      );
    }
    const n = nativeRun(join(t.native, "repo-wt"), ["absorbgitdirs"]);
    const env = testEnv(root);
    const environment = createNodeGitHostEnvironment({ env });
    const files = createNodeFilesApi({ rootDir: t.ours });
    const { history } = await createGitFilesBackend({ files, gitDir: "repo-bare.git" });
    const worktrees = await openGitLinkedWorktrees({
      files,
      gitDir: "repo-bare.git/worktrees/repo-wt",
      history,
      environment,
    });
    const git = Git.fromWorkingCopy(await worktrees.openCurrent());
    const o = await oursRun(() => git.submoduleAbsorbGitDirs().call());
    const norm = (r: SubmoduleCommandResult, twin: string) => ({
      ...r,
      stderr: r.stderr.split(twin).join("<T>"),
    });
    expect(norm(o, t.ours)).toEqual(norm(n, t.native));
    expect(n.stderr).toContain("repo-bare.git/worktrees/repo-wt/modules/sub2");
    for (const part of ["repo-wt", "repo-bare.git"]) {
      expect(snapshot(join(t.ours, part), t.ours), part).toEqual(
        snapshot(join(t.native, part), t.native),
      );
    }
    const modules = "repo-bare.git/worktrees/repo-wt/modules/sub2/config";
    expect(readFileSync(join(t.ours, modules), "latin1")).toEqual(
      readFileSync(join(t.native, modules), "latin1"),
    );
    expect(readBack(join(t.ours, "repo-wt"), t.ours)).toEqual(
      readBack(join(t.native, "repo-wt"), t.native),
    );
  });

  it("refuses a symbolic link on a submodule's path (validate_submodule_path)", async () => {
    if (!is25x) return; // git 2.43.0 has no validate_submodule_path
    const t = twins(`${SETUP}
mkdir real; mv sub1 real/sub1; ln -s real/sub1 sub1
`);
    await expectTwins(t, [absorb()]);
  });

  it("deinit absorbs a .git directory and its nested submodules first", async () => {
    const t = twins(`${SETUP}${NESTED}`);
    await expectTwins(t, [
      [["deinit", "-f", "sub1"], (g) => g.submoduleDeinit().setForce(true).addPath("sub1").call()],
    ]);
  });

  it('t7400-submodule-basic.sh: "submodule deinit absorbs .git directory if .git is a directory"', async () => {
    const t = twins(`${SETUP}
git submodule absorbgitdirs 2>/dev/null
(cd sub1; rm .git; mv ../.git/modules/sub1 .git; GIT_WORK_TREE=. git config --unset core.worktree)
`);
    await expectTwins(t, [
      [["deinit", "sub1"], (g) => g.submoduleDeinit().addPath("sub1").call()],
      absorb(),
    ]);
  });

  it("git rm absorbs a submodule's .git directory (and its nested ones) before removing it", async () => {
    for (const dryRun of [true, false]) {
      const t = twins(`${SETUP}${NESTED}`);
      const args = ["rm", "-q", ...(dryRun ? ["-n"] : []), "sub1"];
      const r = spawnSync("git", args, { cwd: join(t.native, "sup"), env: testEnv(root) });
      const git = await ours(join(t.ours, "sup"));
      const result = await git.rm().addFilepattern("sub1").setQuiet(true).setDryRun(dryRun).call();
      const label = args.join(" ");
      expect(
        (result.messages ?? [])
          .map((l) => `${l}\n`)
          .join("")
          .split(t.ours)
          .join("<T>"),
        label,
      ).toEqual(r.stderr.toString("latin1").split(t.native).join("<T>"));
      expect(r.status, label).toBe(0);
      expect(snapshot(join(t.ours, "sup"), t.ours), label).toEqual(
        snapshot(join(t.native, "sup"), t.native),
      );
      expect(sh(join(t.ours, "sup"), "git status --porcelain=v1"), label).toEqual(
        sh(join(t.native, "sup"), "git status --porcelain=v1"),
      );
    }
  });

  it.runIf(hasPathConfig)(
    "absorbs into submodule.<name>.gitdir under extensions.submodulePathConfig",
    async () => {
      const t = twins(`
git init -q -b main sup; cd sup
git config core.repositoryformatversion 1
git config extensions.submodulePathConfig true
git init -q -b main sub1; (cd sub1; echo first > first.t; git add first.t; git commit -qm first)
git submodule add -q ./sub1
git commit -qm superproject
git config submodule.sub1.gitdir .git/modules/sub1-moved
`);
      await expectTwins(t, [absorb()]);
    },
  );

  it("dies before changing anything when the move fails (FilesApi.move returning false)", async () => {
    const t = twins(SETUP);
    const env = testEnv(root);
    const environment = createNodeGitHostEnvironment({ env });
    const git = await openOurs(
      join(t.ours, "sup"),
      environment,
      (files) =>
        new Proxy(files, {
          get(target, prop, receiver) {
            if (prop === "move") return async () => false;
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    );
    const o = await oursRun(() => git.submoduleAbsorbGitDirs().call());
    expect(o.exitCode).toBe(128);
    expect(o.stderr).toContain("fatal: could not migrate git directory from '");
    expect(lstatSync(join(t.ours, "sup", "sub1", ".git")).isDirectory()).toBe(true);
    expect(existsSync(join(t.ours, "sup", ".git", "modules", "sub1", "HEAD"))).toBe(false);
    expect(readBack(join(t.ours, "sup"), t.ours)).toEqual(
      readBack(join(t.native, "sup"), t.native),
    );
  });
});
