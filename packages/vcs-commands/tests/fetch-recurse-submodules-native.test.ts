/**
 * `git fetch --recurse-submodules` against native git (submodule.c `fetch_submodules`):
 * each scenario's upstream and downstream are built once with native git; the downstream is
 * copied into twins, the upstream stays shared (both twins fetch from it), and each fetch
 * step runs native `git fetch` in one twin and our `FetchCommand` in the other, comparing
 * stderr, the exit status, and every repository's refs and FETCH_HEAD (the superproject's
 * and each `.git/modules/...` one).
 *
 * Inputs come from git's t5526-fetch-submodules.sh (each test names its title there) and
 * JGit's FetchAndPullCommandsRecurseSubmodulesTest.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type FetchCommand, fetchOutputText, fetchSucceeded, type Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";
import { testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;
const versionLine = nativeGitAvailable() ? execFileSync("git", ["--version"]).toString() : "";
const compatibility = gitAtLeast(versionLine, 2, 50) ? "2.56" : "2.43";

/** `-c protocol.file.allow=always`, as t5526 sets it globally (fixtures only). */
const ALLOW_FILE = { GIT_CONFIG_PARAMETERS: "'protocol.file.allow'='always'" };

let root: string;
let caseNo = 0;

interface Twins {
  base: string;
  build: string;
  native: string;
  ours: string;
}

function sh(cwd: string, script: string, extra: Record<string, string> = {}): string {
  return execFileSync("bash", ["-euc", script], {
    cwd,
    env: { ...testEnv(root), ...ALLOW_FILE, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("latin1");
}

/** t5526's helpers, available to every upstream script. */
const HELPERS = `
pwd=$(pwd)
add_submodule_commits () {
  (cd submodule && echo new >> subfile && git add subfile && git commit -qm new subfile) &&
  (cd deepsubmodule && echo new >> deepsubfile && git add deepsubfile && git commit -qm new deepsubfile)
}
add_superproject_commits () {
  (cd submodule && (cd subdir/deepsubmodule && git fetch -q && git checkout -q FETCH_HEAD) &&
    git add subdir/deepsubmodule && git commit -qm "new deep submodule") &&
  git add submodule && git commit -qm "new submodule"
}
`;

/** t5526-fetch-submodules.sh: "setup" (the superproject is the build directory itself). */
const T5526_SETUP = `
git init -q .
mkdir deepsubmodule; (cd deepsubmodule; git init -q; echo deepsubcontent > deepsubfile
  git add deepsubfile; git commit -qm new deepsubfile; git branch -M deep)
mkdir submodule; (cd submodule; git init -q; echo subcontent > subfile; git add subfile
  git submodule add -q "$pwd/deepsubmodule" subdir/deepsubmodule; git commit -qam new; git branch -M sub)
git submodule add -q "$pwd/submodule" submodule; git commit -qam initial; git branch -M super
git clone -q . downstream; (cd downstream; git submodule -q update --init --recursive)
`;

/** A fixture built by `script` in `build`; `downstream` copied into the twins. */
function twins(script: string, dir = "downstream"): Twins {
  const base = join(root, `case${++caseNo}`);
  const build = join(base, "build");
  execFileSync("mkdir", ["-p", build]);
  sh(build, `${HELPERS}${script}`);
  const native = join(base, "native");
  const ours = join(base, "ours");
  execFileSync("mkdir", ["-p", native, ours]);
  execFileSync("cp", ["-a", join(build, dir), join(native, dir)]);
  execFileSync("cp", ["-a", join(build, dir), join(ours, dir)]);
  return { base, build, native, ours };
}

/** Each git directory's refs and FETCH_HEAD below a twin's repository. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (gitDir: string, rel: string) => {
    if (!existsSync(join(gitDir, "HEAD"))) return;
    const r = spawnSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], {
      cwd: gitDir,
      env: { ...testEnv(root), GIT_DIR: gitDir },
    });
    out[`${rel} refs`] = r.stdout.toString("latin1");
    out[`${rel} HEAD`] = readFileSync(join(gitDir, "HEAD"), "latin1");
    const fetchHead = join(gitDir, "FETCH_HEAD");
    out[`${rel} FETCH_HEAD`] = existsSync(fetchHead) ? readFileSync(fetchHead, "latin1") : "-";
    const modules = join(gitDir, "modules");
    if (existsSync(modules)) walkModules(modules, `${rel}/modules`);
  };
  const walkModules = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      if (!statSync(p).isDirectory()) continue;
      if (existsSync(join(p, "HEAD"))) visit(p, `${rel}/${name}`);
      else walkModules(p, `${rel}/${name}`);
    }
  };
  visit(join(dir, ".git"), ".git");
  return out;
}

async function ours(t: Twins, dir: string, env: Record<string, string>): Promise<Git> {
  const environment = createNodeGitHostEnvironment({
    env,
    hookRunner: createNodeHookRunner({ env, compatibility }),
  });
  return openOurs(t.base, environment, undefined, `ours/${dir}`, true);
}

type Step =
  | { up: string }
  | { both: string }
  | {
      git: string[];
      run: (git: Git) => Promise<{ stderr: string; exitCode: number }>;
      env?: Record<string, string>;
    }
  | {
      fetch: string[];
      ours: (c: FetchCommand) => FetchCommand;
      env?: Record<string, string>;
      quiet?: boolean;
    };

const up = (script: string): Step => ({ up: script });
const both = (script: string): Step => ({ both: script });
const fetch = (
  args: string[],
  build: (c: FetchCommand) => FetchCommand = (c) => c,
  env?: Record<string, string>,
): Step => ({
  fetch: args,
  ours: build,
  ...(env ? { env } : {}),
  quiet: args.includes("-q") || args.includes("--quiet"),
});

/** Runs the steps, comparing each fetch's stderr, exit status and the repositories. */
async function expectTwins(t: Twins, steps: Step[], dir = "downstream"): Promise<void> {
  for (const step of steps) {
    if ("up" in step) {
      sh(t.build, `${HELPERS}${step.up}`);
      continue;
    }
    if ("both" in step) {
      sh(join(t.native, dir), step.both);
      sh(join(t.ours, dir), step.both);
      continue;
    }
    const env = { ...testEnv(root), ...(step.env ?? {}) };
    if ("git" in step) {
      const label = `git ${step.git.join(" ")}`;
      const r = spawnSync("git", step.git, { cwd: join(t.native, dir), env });
      const native = { stderr: r.stderr.toString("utf8"), exitCode: r.status ?? -1 };
      const mine = await step
        .run(await ours(t, dir, env))
        .catch((error: Error & { exitCode?: number }) => ({
          stderr: `${error.message}\n`,
          exitCode: error.exitCode ?? 128,
        }));
      expect(mine, label).toEqual(native);
      expect(snapshot(join(t.ours, dir)), label).toEqual(snapshot(join(t.native, dir)));
      continue;
    }
    const label = `git fetch ${step.fetch.join(" ")}`;
    const r = spawnSync("git", ["fetch", ...step.fetch], { cwd: join(t.native, dir), env });
    const native = { stderr: r.stderr.toString("utf8"), exitCode: r.status ?? -1 };
    let mine: { stderr: string; exitCode: number };
    try {
      const git = await ours(t, dir, env);
      const command = step.ours(git.fetch().setCompatibility(compatibility));
      if (step.quiet) command.setQuiet(true);
      const result = await command.call();
      mine = {
        stderr: fetchOutputText(result, step.quiet),
        exitCode: fetchSucceeded(result) ? 0 : 1,
      };
    } catch (error) {
      const e = error as Error & { exitCode?: number };
      mine = { stderr: `${e.message}\n`, exitCode: e.exitCode ?? 128 };
    }
    expect(mine, label).toEqual(native);
    expect(snapshot(join(t.ours, dir)), label).toEqual(snapshot(join(t.native, dir)));
  }
}

describeGit("git fetch --recurse-submodules (native twins)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fetch-recurse-"));
  });
  afterAll(() => {
    if (!process.env.KEEP_TWINS) rmSync(root, { recursive: true, force: true });
  });

  it('t5526-fetch-submodules.sh: "fetch --recurse-submodules recurses into submodules"', async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up("add_submodule_commits"),
      fetch(["--recurse-submodules"], (c) => c.setRecurseSubmodules(true)),
    ]);
  });

  it('t5526-fetch-submodules.sh: "fetch --recurse-submodules honors --no-write-fetch-head"', async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up("add_submodule_commits"),
      fetch(["--recurse-submodules", "--no-write-fetch-head"], (c) =>
        c.setRecurseSubmodules(true).setWriteFetchHead(false),
      ),
    ]);
  });

  it('t5526-fetch-submodules.sh: "submodule.recurse option triggers recursive fetch"', async () => {
    const t = twins(T5526_SETUP);
    const env = { GIT_CONFIG_PARAMETERS: "'submodule.recurse'" };
    await expectTwins(t, [up("add_submodule_commits"), fetch([], (c) => c, env)]);
  });

  it('t5526-fetch-submodules.sh: "fetch alone only fetches superproject"', async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [up("add_submodule_commits"), fetch([])]);
  });

  it('t5526-fetch-submodules.sh: "using fetchRecurseSubmodules=true in .gitmodules recurses into submodules"', async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up("add_submodule_commits"),
      both("git config -f .gitmodules submodule.submodule.fetchRecurseSubmodules true"),
      fetch([]),
    ]);
  });

  it('t5526-fetch-submodules.sh: "using fetchRecurseSubmodules=false in .git/config overrides setting in .gitmodules"', async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up("add_submodule_commits"),
      both(
        "git config -f .gitmodules submodule.submodule.fetchRecurseSubmodules true; git config submodule.submodule.fetchRecurseSubmodules false",
      ),
      fetch([]),
      fetch(["--recurse-submodules"], (c) => c.setRecurseSubmodules(true)),
    ]);
  });

  it('t5526-fetch-submodules.sh: "--quiet propagates to submodules"', async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up("add_submodule_commits"),
      fetch(["--recurse-submodules", "--quiet"], (c) => c.setRecurseSubmodules(true)),
    ]);
  });

  it('t5526-fetch-submodules.sh: "--dry-run propagates to submodules", "Without --dry-run propagates to submodules"', async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up("add_submodule_commits"),
      fetch(["--recurse-submodules", "--dry-run"], (c) =>
        c.setRecurseSubmodules(true).setDryRun(true),
      ),
      fetch(["--recurse-submodules"], (c) => c.setRecurseSubmodules(true)),
    ]);
  });

  it('t5526-fetch-submodules.sh: "recurseSubmodules=true propagates into submodules", "--no-recurse-submodules overrides config setting"', async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up("add_submodule_commits"),
      both("git config fetch.recurseSubmodules true"),
      fetch([]),
      up("add_submodule_commits"),
      fetch(["--no-recurse-submodules"], (c) => c.setRecurseSubmodules(false)),
    ]);
  });

  it('t5526-fetch-submodules.sh: "--recurse-submodules overrides config in submodule"', async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up("add_submodule_commits"),
      both("(cd submodule && git config fetch.recurseSubmodules false)"),
      fetch(["--recurse-submodules"], (c) => c.setRecurseSubmodules(true)),
    ]);
  });

  it('t5526-fetch-submodules.sh: "Recursion stops when no new submodule commits are fetched"', async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up("add_submodule_commits"),
      fetch(["--recurse-submodules"], (c) => c.setRecurseSubmodules(true)),
      up('git add submodule && git commit -qm "new submodule"'),
      fetch([]),
    ]);
  });

  it(`t5526-fetch-submodules.sh: "Recursion doesn't happen when new superproject commits don't change any submodules"`, async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up('add_submodule_commits; echo a > file; git add file; git commit -qm "new file"'),
      fetch([]),
    ]);
  });

  it('t5526-fetch-submodules.sh: "Recursion picks up config in submodule"', async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      both("(cd submodule && git config fetch.recurseSubmodules true)"),
      up('add_submodule_commits; git add submodule; git commit -qm "new submodule"'),
      fetch([]),
    ]);
  });

  it('t5526-fetch-submodules.sh: "Recursion picks up all submodules when necessary"', async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [up("add_submodule_commits; add_superproject_commits"), fetch([])]);
  });

  it(`t5526-fetch-submodules.sh: "'--recurse-submodules=on-demand' doesn't recurse when no new commits are fetched in the superproject (and ignores config)"`, async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up("add_submodule_commits"),
      both("git config fetch.recurseSubmodules true"),
      fetch(["--recurse-submodules=on-demand"], (c) => c.setRecurseSubmodules("on-demand")),
    ]);
  });

  it(`t5526-fetch-submodules.sh: "'--recurse-submodules=on-demand' recurses as deep as necessary (and ignores config)"`, async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up("add_submodule_commits; add_superproject_commits"),
      both(
        "git config fetch.recurseSubmodules false; (cd submodule && git config -f .gitmodules submodule.subdir/deepsubmodule.fetchRecursive false)",
      ),
      fetch(["--recurse-submodules=on-demand"], (c) => c.setRecurseSubmodules("on-demand")),
    ]);
  });

  it(`t5526-fetch-submodules.sh: "'--recurse-submodules=on-demand' should fetch submodule commits if the submodule is changed but the index has no submodules", "'--recurse-submodules' should fetch submodule commits if the submodule is changed but the index has no submodules"`, async () => {
    const setup = `${T5526_SETUP}
(cd downstream; git checkout -q -b no-submodules; git rm -q .gitmodules; git rm -q submodule
  git commit -qm "no submodules"; git checkout -q super; git switch -q --recurse-submodules no-submodules)`;
    for (const mode of ["on-demand", "yes"] as const) {
      const t = twins(setup);
      const args = mode === "yes" ? ["--recurse-submodules"] : ["--recurse-submodules=on-demand"];
      await expectTwins(t, [
        up("add_submodule_commits; add_superproject_commits"),
        fetch(args, (c) => c.setRecurseSubmodules(mode)),
      ]);
    }
  });

  it(`t5526-fetch-submodules.sh: "'--recurse-submodules' should ignore changed, inactive submodules"`, async () => {
    const t = twins(`${T5526_SETUP}
(cd downstream; git checkout -q -b no-submodules; git rm -q .gitmodules; git rm -q submodule
  git commit -qm "no submodules"; git checkout -q super; git switch -q --recurse-submodules no-submodules)`);
    const env = { GIT_CONFIG_PARAMETERS: "'submodule.submodule.active'='false'" };
    await expectTwins(t, [
      up("add_submodule_commits; add_superproject_commits"),
      fetch(["--recurse-submodules"], (c) => c.setRecurseSubmodules(true), env),
    ]);
  });

  it(`t5526-fetch-submodules.sh: "'fetch.recurseSubmodules=on-demand' overrides global config", "'submodule.<sub>.fetchRecurseSubmodules=on-demand' overrides fetch.recurseSubmodules"`, async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up('add_submodule_commits; git add submodule; git commit -qm "new submodule"'),
      both("git config fetch.recurseSubmodules on-demand"),
      fetch([], (c) => c, { GIT_CONFIG_PARAMETERS: "'fetch.recurseSubmodules'='false'" }),
      up('add_submodule_commits; git add submodule; git commit -qm "new submodule"'),
      both(
        "git config fetch.recurseSubmodules false; git config submodule.submodule.fetchRecurseSubmodules on-demand",
      ),
      fetch([]),
    ]);
  });

  it(`t5526-fetch-submodules.sh: "don't fetch submodule when newly recorded commits are already present"`, async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up(
        'add_submodule_commits; add_submodule_commits; git add submodule; git commit -qm "new submodule"',
      ),
      fetch(["--recurse-submodules"], (c) => c.setRecurseSubmodules(true)),
      up(
        '(cd submodule && git checkout -q HEAD^); git add submodule; git commit -qm "submodule rewound"',
      ),
      fetch([]),
    ]);
  });

  it(`t5526-fetch-submodules.sh: "'fetch.recurseSubmodules=on-demand' works also without .gitmodules entry"`, async () => {
    const t = twins(T5526_SETUP);
    await expectTwins(t, [
      up(
        'add_submodule_commits; git add submodule; git rm -q .gitmodules; git commit -qm "new submodule without .gitmodules"',
      ),
      both(`rm .gitmodules; git config fetch.recurseSubmodules on-demand
git config -f .gitmodules submodule.fake.path fake; git config -f .gitmodules submodule.fake.url fakeurl
git add .gitmodules; git config --unset submodule.submodule.url`),
      fetch([]),
    ]);
  });

  it('t5526-fetch-submodules.sh: "fetch new submodule commits on-demand outside standard refspec", "fetch new submodule commit on-demand in FETCH_HEAD"', async () => {
    const t = twins(`${T5526_SETUP}
git clone -q submodule sub1; git submodule add -q ./sub1; git commit -qm "adding a second submodule"
git -C downstream pull -q --no-recurse-submodules; git -C downstream submodule -q update --init --recursive
git checkout -q --detach`);
    await expectTwins(t, [
      up(`C=$(git -C submodule commit-tree -m "new change outside refs/heads" HEAD^{tree})
git -C submodule update-ref refs/changes/1 $C; git update-index --cacheinfo 160000 $C submodule
D=$(git -C sub1 commit-tree -m "new change outside refs/heads" HEAD^{tree})
git -C sub1 update-ref refs/changes/2 $D; git update-index --cacheinfo 160000 $D sub1
git commit -qm "updated submodules outside of refs/heads"; git update-ref refs/changes/3 HEAD`),
      fetch(["--recurse-submodules", "origin", "refs/changes/3:refs/heads/my_branch"], (c) =>
        c
          .setRecurseSubmodules(true)
          .setRemote("origin")
          .setRefSpecs("refs/changes/3:refs/heads/my_branch"),
      ),
      up(`C=$(git -C submodule commit-tree -m "another change outside refs/heads" HEAD^{tree})
git -C submodule update-ref refs/changes/4 $C; git update-index --cacheinfo 160000 $C submodule
D=$(git -C sub1 commit-tree -m "another change outside refs/heads" HEAD^{tree})
git -C sub1 update-ref refs/changes/5 $D; git update-index --cacheinfo 160000 $D sub1
git commit -qm "updated submodules outside of refs/heads"; git update-ref refs/changes/6 HEAD`),
      fetch(["--recurse-submodules", "origin", "refs/changes/6"], (c) =>
        c.setRecurseSubmodules(true).setRemote("origin").setRefSpecs("refs/changes/6"),
      ),
    ]);
  });

  it('t5526-fetch-submodules.sh: "fetch new submodule commits on-demand outside standard refspec with custom remote name"', async () => {
    const t = twins(`${T5526_SETUP}
git clone -q submodule sub1; git submodule add -q ./sub1; git commit -qm "adding a second submodule"
git -C downstream pull -q --no-recurse-submodules; git -C downstream submodule -q update --init --recursive
git -C downstream/sub1 remote rename origin custom_remote
git checkout -q --detach`);
    await expectTwins(t, [
      up(`C=$(git -C submodule commit-tree -m "change outside refs/heads for custom remote" HEAD^{tree})
git -C submodule update-ref refs/changes/custom1 $C; git update-index --cacheinfo 160000 $C submodule
D=$(git -C sub1 commit-tree -m "change outside refs/heads for custom remote" HEAD^{tree})
git -C sub1 update-ref refs/changes/custom2 $D; git update-index --cacheinfo 160000 $D sub1
git commit -qm "updated submodules outside of refs/heads for custom remote"
git update-ref refs/changes/custom3 HEAD`),
      fetch(
        ["--recurse-submodules", "origin", "refs/changes/custom3:refs/heads/my_other_branch"],
        (c) =>
          c
            .setRecurseSubmodules(true)
            .setRemote("origin")
            .setRefSpecs("refs/changes/custom3:refs/heads/my_other_branch"),
      ),
    ]);
  });

  it('t5526-fetch-submodules.sh: "fetching submodule into a broken repository"', async () => {
    const t = twins(
      `git init -q src; (cd src; git init -q sub; git -C sub commit -q --allow-empty -m "initial in sub"
  git submodule add -q -- ./sub sub; git commit -qm "initial in top")
git clone -q src dst; git -C dst clone -q ../src/sub sub; git -C dst fetch -q --recurse-submodules
rm -r dst/sub/.git/objects`,
      "dst",
    );
    await expectTwins(
      t,
      [fetch(["--recurse-submodules"], (c) => c.setRecurseSubmodules(true))],
      "dst",
    );
  });

  it('t5526-fetch-submodules.sh: "fetching a superproject containing an uninitialized sub/sub project"', async () => {
    const t = twins(
      `for repo in outer middle inner; do git init -q --bare $repo; git clone -q $repo \${repo}_content
  echo "$repo" > \${repo}_content/file; git -C \${repo}_content add file; git -C \${repo}_content commit -qm initial
  git -C \${repo}_content push -q; done
git clone -q outer A; git -C A submodule add -q "$pwd/middle"; git -C A/middle/ submodule add -q "$pwd/inner"
git -C A/middle add .gitmodules inner; git -C A/middle commit -qm "adding inner sub"; git -C A/middle push -q
git -C A add .gitmodules middle; git -C A commit -qm "adding middle sub"; git -C A push -q
git clone -q outer B; git -C B/ submodule -q update --init middle`,
      "B",
    );
    await expectTwins(
      t,
      [
        up(`echo "change on inner repo of A" > A/middle/inner/file
for d in A/middle/inner A/middle A; do git -C $d commit -qam "change on inner"; git -C $d push -q; done`),
        fetch([]),
      ],
      "B",
    );
  });

  it('t5526-fetch-submodules.sh: "recursive fetch with uninit submodule", "recursive fetch after deinit a submodule"', async () => {
    const t = twins(
      `git init -q super; git -C super commit -q --allow-empty -m initial
git init -q sub; git -C sub commit -q --allow-empty -m initial
git -C super submodule add -q ../sub; git -C super commit -qm "add sub"; git clone -q super superclone`,
      "superclone",
    );
    await expectTwins(
      t,
      [
        fetch(["--recurse-submodules"], (c) => c.setRecurseSubmodules(true)),
        both("git submodule -q update --init sub; git submodule -q deinit -f sub"),
        fetch(["--recurse-submodules"], (c) => c.setRecurseSubmodules(true)),
      ],
      "superclone",
    );
  });

  /** t5526-fetch-submodules.sh: "setup repo with upstreams that share a submodule name". */
  const SAME_NAME = `
mkdir same-name-1; (cd same-name-1; git init -q -b main; echo a > a.t; git add a.t; git commit -qm a)
git clone -q same-name-1 same-name-2
(cd same-name-1; mkdir submodule; git -C submodule init -q -b main
  (cd submodule; echo a1 > a1.t; git add a1.t; git commit -qm a1)
  git submodule add -q "$pwd/same-name-1/submodule"; git add submodule; git commit -qm super-a1)
(cd same-name-2; mkdir submodule; git -C submodule init -q -b main
  (cd submodule; echo a2 > a2.t; git add a2.t; git commit -qm a2)
  git submodule add -q "$pwd/same-name-2/submodule"; git add submodule; git commit -qm super-a2)
git clone -q same-name-1 -o same-name-1 same-name-downstream
(cd same-name-downstream; git remote add same-name-2 ../same-name-2; git fetch -q --all
  git submodule -q update --init)
`;
  const commitBoth = (tag: string) =>
    `for n in 1 2; do (cd same-name-$n; (cd submodule; echo ${tag}$n > ${tag}$n.t; git add ${tag}$n.t
  git commit -qm ${tag}$n); git add submodule; git commit -qm super-${tag}$n); done`;

  it('t5526-fetch-submodules.sh: "fetch --recurse-submodules updates name-conflicted, populated submodule", "fetch --recurse-submodules updates name-conflicted, unpopulated submodule"', async () => {
    const t = twins(SAME_NAME, "same-name-downstream");
    await expectTwins(
      t,
      [
        up(commitBoth("b")),
        both("git checkout -q same-name-2/main"),
        fetch(["--recurse-submodules", "same-name-1"], (c) =>
          c.setRecurseSubmodules(true).setRemote("same-name-1"),
        ),
        fetch(["--recurse-submodules", "same-name-2"], (c) =>
          c.setRecurseSubmodules(true).setRemote("same-name-2"),
        ),
        up(commitBoth("c")),
        both(
          'git checkout -q main; git rm -q .gitmodules; git rm -q submodule; git commit -qm "no submodules"',
        ),
        fetch(["--recurse-submodules", "same-name-1"], (c) =>
          c.setRecurseSubmodules(true).setRemote("same-name-1"),
        ),
      ],
      "same-name-downstream",
    );
  });

  it('t5526-fetch-submodules.sh: "fetch --all with --recurse-submodules", "fetch --all with --recurse-submodules with multiple", "fetch --all with --no-recurse-submodules only fetches superproject"', async () => {
    const t = twins(
      `${SAME_NAME}
git clone -q --recurse-submodules same-name-1 src_clone
(cd src_clone; git config submodule.recurse true)`,
      "src_clone",
    );
    const all = (args: string[], build: (c: ReturnType<Git["fetchMultiple"]>) => unknown) => ({
      git: ["fetch", "--all", ...args],
      run: async (git: Git) => {
        const command = git.fetchMultiple().setAll(true);
        build(command);
        const r = await command.call();
        return { stderr: r.stderr, exitCode: r.exitCode };
      },
    });
    await expectTwins(
      t,
      [
        up(commitBoth("d")),
        all([], () => undefined),
        both("git remote add secondary ../same-name-1"),
        up(commitBoth("e")),
        all([], () => undefined),
        up(commitBoth("f")),
        all(["--no-recurse-submodules"], (c) =>
          (c as { setRecurseSubmodules(b: boolean): unknown }).setRecurseSubmodules(false),
        ),
      ],
      "src_clone",
    );
  });

  describe("JGit FetchAndPullCommandsRecurseSubmodulesTest", () => {
    /** setUpSubmodules: sub2 inside sub1 inside the superproject, cloned recursively. */
    const JGIT_SETUP = `
git init -q -b master sub1; (cd sub1; echo content > file.txt; git add file.txt; git commit -qm "create file")
git init -q -b master sub2; (cd sub2; echo content > file.txt; git add file.txt; git commit -qm "create file")
(cd sub1; git submodule add -q "$pwd/sub2" sub; git commit -qam "Adding submodule")
git init -q -b master .; git submodule add -q "$pwd/sub1" sub; git commit -qam "Adding submodule"
git clone -q --recurse-submodules . clone
(cd sub1/sub; echo test > f2.txt; git add f2.txt; git commit -qm "new commit")
(cd sub1; echo test > f1.txt; git add f1.txt; git commit -qm "new commit")
(cd sub2; echo test > f2.txt; git add f2.txt; git commit -qm "new commit")
`;
    /** updateSubmoduleRevision: the superproject's sub moved to sub1's new commit. */
    const UPDATE = `(cd sub; git fetch -q origin refs/heads/master; git reset -q --hard FETCH_HEAD)
git add sub; git commit -qm "update sub"`;
    const execute = (
      args: string[],
      build: (c: FetchCommand) => FetchCommand,
      env?: Record<string, string>,
    ) =>
      fetch(
        ["origin", "refs/heads/master", ...args],
        (c) => build(c.setRemote("origin").setRefSpecs("refs/heads/master")),
        env,
      );

    it("shouldNotFetchSubmodulesWhenNo", async () => {
      const t = twins(JGIT_SETUP, "clone");
      await expectTwins(
        t,
        [execute(["--recurse-submodules=no"], (c) => c.setRecurseSubmodules("no"))],
        "clone",
      );
    });

    it("shouldFetchSubmodulesWhenYes", async () => {
      const t = twins(JGIT_SETUP, "clone");
      await expectTwins(
        t,
        [execute(["--recurse-submodules=yes"], (c) => c.setRecurseSubmodules("yes"))],
        "clone",
      );
    });

    it("shouldFetchSubmodulesWhenOnDemandAndRevisionChanged", async () => {
      const t = twins(JGIT_SETUP, "clone");
      await expectTwins(
        t,
        [
          up(UPDATE),
          execute(["--recurse-submodules=on-demand"], (c) => c.setRecurseSubmodules("on-demand")),
        ],
        "clone",
      );
    });

    it("shouldNotFetchSubmodulesWhenOnDemandAndRevisionNotChanged", async () => {
      const t = twins(JGIT_SETUP, "clone");
      await expectTwins(
        t,
        [execute(["--recurse-submodules=on-demand"], (c) => c.setRecurseSubmodules("on-demand"))],
        "clone",
      );
    });

    it("shouldNotFetchSubmodulesWhenSubmoduleConfigurationSetToNo", async () => {
      const t = twins(JGIT_SETUP, "clone");
      await expectTwins(
        t,
        [
          both("git config submodule.sub.fetchRecurseSubmodules false"),
          up(UPDATE),
          execute([], (c) => c),
        ],
        "clone",
      );
    });

    it("shouldFetchSubmodulesWhenSubmoduleConfigurationSetToYes", async () => {
      const t = twins(JGIT_SETUP, "clone");
      await expectTwins(
        t,
        [both("git config submodule.sub.fetchRecurseSubmodules true"), execute([], (c) => c)],
        "clone",
      );
    });

    it("shouldNotFetchSubmodulesWhenFetchConfigurationSetToNo", async () => {
      const t = twins(JGIT_SETUP, "clone");
      await expectTwins(
        t,
        [both("git config fetch.recurseSubmodules false"), up(UPDATE), execute([], (c) => c)],
        "clone",
      );
    });

    it("shouldFetchSubmodulesWhenFetchConfigurationSetToYes", async () => {
      const t = twins(JGIT_SETUP, "clone");
      await expectTwins(
        t,
        [both("git config fetch.recurseSubmodules true"), execute([], (c) => c)],
        "clone",
      );
    });
  });
});
