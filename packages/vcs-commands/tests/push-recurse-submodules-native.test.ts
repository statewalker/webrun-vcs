/**
 * `git push --recurse-submodules=check|on-demand|only|no` and `push.recurseSubmodules`
 * against native git (transport.c `transport_push`, submodule.c `find_unpushed_submodules`,
 * `push_unpushed_submodules`, `submodule--helper push-check`): t5531's fixture is built once
 * and copied into two twins (the pushed-to repositories inside them), each step runs in both,
 * and every push runs natively in one and ours in the other: the exit status, the stderr
 * lines (without hints, `remote:` lines and the hang-up line, as other push twins) and the
 * refs of every repository are compared.
 *
 * Inputs come from git's t5531-deep-submodule-push.sh: the scenarios run in its order, one
 * test per title, each going on from the state the previous ones left.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type PushCommand, pushOutputText, pushSucceeded } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";
import { configurePush } from "./push-modes-native-support.js";
import { testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;
const versionLine = nativeGitAvailable() ? execFileSync("git", ["--version"]).toString() : "";
const compatibility = gitAtLeast(versionLine, 2, 50) ? "2.56" : "2.43";

let root: string;
let native: string;
let ours: string;

/** The repositories whose refs are compared after each push. */
const REPOS = [
  "pub.git",
  "submodule.git",
  "work",
  "work/gar/bage",
  "a",
  "upstream",
  "upstream/sub",
  "upstream/sub/deepsub",
];

function env(): Record<string, string> {
  return {
    ...testEnv(root),
    GIT_CONFIG_PARAMETERS: "'protocol.file.allow'='always' 'init.defaultBranch'='main'",
  };
}

function sh(cwd: string, script: string): void {
  execFileSync("bash", ["-euc", `${HELPERS}${script}`], {
    cwd,
    env: env(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const HELPERS = `
test_commit () { if [ "$1" = -C ]; then (cd "$2"; shift 2; test_commit "$@"); return; fi
  echo "$1" > "$1.t"; git add "$1.t"; git commit -qm "$1"; git tag "$1"; }
`;

/** A script run in both twins. */
function both(script: string): void {
  sh(native, script);
  sh(ours, script);
}

const kept = (stderr: string) =>
  stderr
    .split("\n")
    .filter(
      (l) =>
        l !== "" &&
        !l.startsWith("hint:") &&
        !l.startsWith("remote: ") &&
        l !== "fatal: the remote end hung up unexpectedly",
    );

function refs(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const repo of REPOS) {
    const r = spawnSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], {
      cwd: join(dir, repo),
      env: env(),
    });
    if (r.status === 0) out[repo] = r.stdout.toString("latin1");
  }
  return out;
}

/** `git [-c <key=value>...] push <args>` in `<twin>/<cwd>`, natively and ours. */
async function push(cwd: string, argv: string[]): Promise<void> {
  const config: string[] = [];
  let i = 0;
  while (argv[i] === "-c") {
    config.push(argv[i + 1] as string);
    i += 2;
  }
  const args = argv.slice(i + 1);
  const label = `git ${argv.join(" ")} (in ${cwd})`;
  const params = config.map((c) => {
    const eq = c.indexOf("=");
    return `'${c.slice(0, eq)}'='${c.slice(eq + 1)}'`;
  });
  const e = { ...env(), GIT_CONFIG_PARAMETERS: [env().GIT_CONFIG_PARAMETERS, ...params].join(" ") };
  const r = spawnSync("git", ["push", ...args], { cwd: join(native, cwd), env: e });
  const mine: { exitCode: number; lines: string[] } = await (async () => {
    const environment = createNodeGitHostEnvironment({
      env: e,
      hookRunner: createNodeHookRunner({ env: e, compatibility }),
    });
    const git = await openOurs(ours, environment, undefined, cwd, true);
    const rest: string[] = [];
    let command: PushCommand = git.push().setCompatibility(compatibility);
    for (const a of args) {
      if (a.startsWith("--recurse-submodules=")) {
        command = command.setRecurseSubmodules(a.slice("--recurse-submodules=".length) as "check");
      } else rest.push(a);
    }
    try {
      const result = await configurePush(command, rest).call();
      return {
        exitCode: pushSucceeded(result) ? 0 : 1,
        lines: kept(pushOutputText(result)).filter((l) => !l.startsWith("error: failed to push")),
      };
    } catch (error) {
      const err = error as Error & { exitCode?: number };
      return {
        exitCode: err.exitCode ?? 128,
        lines: kept(`${err.message}\n`).filter((l) => !l.startsWith("error: failed to push")),
      };
    }
  })().catch((error: Error & { exitCode?: number }) => ({
    exitCode: error.exitCode ?? 128,
    lines: kept(`${error.message}\n`),
  }));
  const twinless = (lines: string[], twin: string) => lines.map((l) => l.split(twin).join("<T>"));
  expect({ ...mine, lines: twinless(mine.lines, ours) }, label).toEqual({
    exitCode: r.status,
    lines: twinless(
      kept(r.stderr.toString("utf8")).filter((l) => !l.startsWith("error: failed to push")),
      native,
    ),
  });
  expect(refs(ours), label).toEqual(refs(native));
}

describeGit("git push --recurse-submodules (native twins)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "push-recurse-"));
    native = join(root, "native");
    ours = join(root, "ours");
    const build = join(root, "build");
    execFileSync("mkdir", ["-p", build]);
    // t5531-deep-submodule-push.sh: "setup"
    sh(
      build,
      `mkdir pub.git; GIT_DIR=pub.git git init -q --bare; GIT_DIR=pub.git git config receive.fsckobjects true
mkdir work; (cd work; git init -q; git config push.default matching; mkdir -p gar/bage
  (cd gar/bage; git init -q; git config push.default matching; >junk; git add junk; git commit -qm "Initial junk")
  git add gar/bage; git commit -qm "Initial superproject")`,
    );
    execFileSync("cp", ["-a", build, native]);
    execFileSync("cp", ["-a", build, ours]);
  });
  afterAll(() => {
    if (!process.env.KEEP_TWINS) rmSync(root, { recursive: true, force: true });
  });

  it('t5531-deep-submodule-push.sh: "push works with recorded gitlink"', async () => {
    await push("work", ["push", "../pub.git", "main"]);
  });

  it('t5531-deep-submodule-push.sh: "push if submodule has no remote"', async () => {
    both(`(cd work/gar/bage; >junk2; git add junk2; git commit -qm "Second junk")
(cd work; git add gar/bage; git commit -qm "Second commit for gar/bage")`);
    await push("work", ["push", "--recurse-submodules=check", "../pub.git", "main"]);
  });

  it('t5531-deep-submodule-push.sh: "push fails if submodule commit not on remote"', async () => {
    both(`(cd work/gar; git clone -q --bare bage ../../submodule.git; cd bage
  git remote add origin ../../../submodule.git; git fetch -q; >junk3; git add junk3; git commit -qm "Third junk")
(cd work; git add gar/bage; git commit -qm "Third commit for gar/bage")`);
    await push("work", ["push", "--recurse-submodules=check", "../pub.git", "main"]);
    await push("work", ["-c", "push.recurseSubmodules=check", "push", "../pub.git", "main"]);
  });

  it('t5531-deep-submodule-push.sh: "push succeeds after commit was pushed to remote"', async () => {
    both("git -C work/gar/bage push -q origin main");
    await push("work", ["push", "--recurse-submodules=check", "../pub.git", "main"]);
  });

  it('t5531-deep-submodule-push.sh: "push succeeds if submodule commit not on remote but using on-demand on command line", "push succeeds if submodule commit not on remote but using on-demand from config", "push succeeds if submodule commit not on remote but using auto-on-demand via submodule.recurse config"', async () => {
    const commit = (name: string) =>
      both(`(cd work/gar/bage; >${name}; git add ${name}; git commit -qm "${name} junk")
(cd work; git add gar/bage; git commit -qm "${name} for gar/bage")`);
    commit("recurse-on-demand-on-command-line");
    await push("work", ["push", "--recurse-submodules=on-demand", "../pub.git", "main"]);
    commit("recurse-on-demand-from-config");
    await push("work", ["-c", "push.recurseSubmodules=on-demand", "push", "../pub.git", "main"]);
    commit("recurse-on-demand-from-submodule-recurse-config");
    await push("work", ["-c", "submodule.recurse=true", "push", "../pub.git", "main"]);
  });

  it('t5531-deep-submodule-push.sh: "push recurse-submodules on command line overrides config", "push succeeds if submodule commit disabling recursion from cmdline overriding config"', async () => {
    both(`(cd work/gar/bage; >recurse-check-on-command-line-overriding-config; git add -A; git commit -qm "Recurse on command-line overriding config junk")
(cd work; git add gar/bage; git commit -qm "Recurse on command-line overriding config for gar/bage")`);
    await push("work", [
      "-c",
      "push.recurseSubmodules=on-demand",
      "push",
      "--recurse-submodules=check",
      "../pub.git",
      "main",
    ]);
    await push("work", [
      "-c",
      "push.recurseSubmodules=on-demand",
      "push",
      "--recurse-submodules=no",
      "../pub.git",
      "main",
    ]);
    await push("work", ["push", "--recurse-submodules=on-demand", "../pub.git", "main"]);
  });

  it('t5531-deep-submodule-push.sh: "submodule entry pointing at a tag is error"', async () => {
    both(`git -C work/gar/bage tag -a test1 -m "tag"; tag=$(git -C work/gar/bage rev-parse test1^{tag})
git -C work update-index --cacheinfo 160000 "$tag" gar/bage; git -C work commit -qm "bad commit"`);
    await push("work", ["push", "--recurse-submodules=on-demand", "../pub.git", "main"]);
    both("git -C work reset -q --hard HEAD^");
  });

  it('t5531-deep-submodule-push.sh: "push fails if recurse submodules option passed as yes"', async () => {
    both(`(cd work/gar/bage; >yes-junk; git add yes-junk; git commit -qm "yes")
(cd work; git add gar/bage; git commit -qm "yes for gar/bage")`);
    await push("work", ["push", "--recurse-submodules=yes", "../pub.git", "main"]);
    await push("work", ["-c", "push.recurseSubmodules=yes", "push", "../pub.git", "main"]);
    await push("work", ["push", "--recurse-submodules=on-demand", "../pub.git", "main"]);
  });

  it('t5531-deep-submodule-push.sh: "push fails when commit on multiple branches if one branch has no remote"', async () => {
    both(`(cd work/gar/bage; >junk4; git add junk4; git commit -qm "Fourth junk")
(cd work; git branch branch2; git add gar/bage; git commit -qm "Fourth commit for gar/bage"; git checkout -q branch2
  (cd gar/bage; git checkout -q HEAD~1); >junk1; git add junk1; git commit -qm "First junk")`);
    await push("work", ["push", "--recurse-submodules=check", "../pub.git"]);
  });

  it('t5531-deep-submodule-push.sh: "push succeeds if submodule has no remote and is on the first superproject commit"', async () => {
    both(`git init -q --bare a; git clone -q a a1 2>/dev/null; (cd a1; git init -q b; (cd b; >junk; git add junk; git commit -qm initial)
  git add b; git commit -qm "added submodule")`);
    await push("a1", ["push", "--recurse-submodules=check", "origin", "main"]);
  });

  it('t5531-deep-submodule-push.sh: "push unpushed submodules when not needed", "push unpushed submodules when not needed 2", "push unpushed submodules recursively"', async () => {
    both(`(cd work; (cd gar/bage; git checkout -q main; >junk5; git add junk5; git commit -qm "Fifth junk"; git push -q)
  git checkout -q main; git add gar/bage; git commit -qm "Fifth commit for gar/bage")`);
    await push("work", ["push", "--recurse-submodules=on-demand", "../pub.git", "main"]);
    both(`(cd work; (cd gar/bage; >junk6; git add junk6; git commit -qm "Sixth junk"); >junk2; git add junk2
  git commit -qm "Second junk for work")`);
    await push("work", ["push", "--recurse-submodules=on-demand", "../pub.git", "main"]);
    both(`(cd work; (cd gar/bage; git checkout -q main; >junk7; git add junk7; git commit -qm "Seventh junk")
  git checkout -q main; git add gar/bage; git commit -qm "Seventh commit for gar/bage")`);
    await push("work", ["push", "--recurse-submodules=on-demand", "../pub.git", "main"]);
  });

  it('t5531-deep-submodule-push.sh: "push unpushable submodule recursively fails"', async () => {
    both(`(cd work; (cd gar/bage; git checkout -q main~0; >junk8; git add junk8; git commit -qm "Eighth junk")
  git add gar/bage; git commit -qm "Eighth commit for gar/bage")`);
    await push("work", ["push", "--recurse-submodules=on-demand", "../pub.git", "main"]);
    both("git -C work reset -q --hard main^");
  });

  it('t5531-deep-submodule-push.sh: "push --dry-run does not recursively update submodules", "push only unpushed submodules recursively"', async () => {
    both(`(cd work/gar/bage; git checkout -q main; >junk9; git add junk9; git commit -qm "Ninth junk"
  cd ../..; git checkout -q main; git add gar/bage; git commit -qm "Ninth commit for gar/bage")`);
    await push("work", [
      "push",
      "--dry-run",
      "--recurse-submodules=on-demand",
      "../pub.git",
      "main",
    ]);
    await push("work", ["push", "--dry-run", "--recurse-submodules=only", "../pub.git", "main"]);
    await push("work", ["push", "--recurse-submodules=only", "../pub.git", "main"]);
  });

  const setupSubsub = `rm -rf upstream downstream; git init -q upstream; git init -q upstream/sub; git init -q upstream/sub/deepsub
test_commit -C upstream/sub/deepsub innermost; git -C upstream/sub submodule add -q ./deepsub deepsub
git -C upstream/sub commit -qm middle; git -C upstream submodule add -q ./sub sub; git -C upstream commit -qm outermost
git clone -q --recurse-submodules upstream downstream
git -C downstream/sub/deepsub checkout -q -b downstream-branch; git -C downstream/sub checkout -q -b downstream-branch
git -C downstream checkout -q -b downstream-branch
test_commit -C downstream/sub/deepsub new-innermost; git -C downstream/sub add deepsub; git -C downstream/sub commit -qm new-middle
git -C downstream add sub; git -C downstream commit -qm new-outermost`;

  it('t5531-deep-submodule-push.sh: "push with push.recurseSubmodules=only on superproject"', async () => {
    both(`${setupSubsub}\ngit -C downstream config push.recurseSubmodules only`);
    await push("downstream", ["push", "origin", "downstream-branch"]);
  });

  it('t5531-deep-submodule-push.sh: "push with push.recurseSubmodules=only on superproject and top-level submodule"', async () => {
    both(`${setupSubsub}
git -C downstream config push.recurseSubmodules only; git -C downstream/sub config push.recurseSubmodules only`);
    await push("downstream", ["push", "origin", "downstream-branch"]);
  });

  it('t5531-deep-submodule-push.sh: "push propagating the remotes name to a submodule"', async () => {
    both(`git -C work remote add origin ../pub.git; git -C work remote add pub ../pub.git
>work/gar/bage/junk10; git -C work/gar/bage add junk10; git -C work/gar/bage commit -qm "Tenth junk"
git -C work add gar/bage; git -C work commit -qm "Tenth junk added to gar/bage"`);
    await push("work", ["push", "--recurse-submodules=on-demand", "pub", "main"]);
    await push("work", ["push", "--recurse-submodules=on-demand", "origin", "main"]);
  });

  it('t5531-deep-submodule-push.sh: "push propagating refspec to a submodule", "push propagating HEAD refspec to a submodule"', async () => {
    both(`>work/gar/bage/junk11; git -C work/gar/bage add junk11; git -C work/gar/bage commit -qm "Eleventh junk"
git -C work checkout -q branch2; git -C work add gar/bage; git -C work commit -qm "updating gar/bage in branch2"`);
    await push("work", ["push", "--recurse-submodules=on-demand", "origin", "branch2"]);
    await push("work", [
      "push",
      "--recurse-submodules=on-demand",
      "origin",
      "HEAD:refs/heads/branch2",
    ]);
    both("git -C work/gar/bage branch branch2 main");
    await push("work", ["push", "--recurse-submodules=on-demand", "origin", "branch2"]);
    both(`git -C work/gar/bage checkout -q branch2; >work/gar/bage/junk12; git -C work/gar/bage add junk12
git -C work/gar/bage commit -qm "Twelfth junk"; git -C work checkout -q branch2; git -C work add gar/bage
git -C work commit -qm "updating gar/bage in branch2"`);
    await push("work", [
      "push",
      "--recurse-submodules=on-demand",
      "origin",
      "HEAD:refs/heads/branch2",
    ]);
  });
});
