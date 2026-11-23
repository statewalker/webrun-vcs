/**
 * `git submodule init`, `deinit`, `sync`, `set-url`, `set-branch` and `foreach` against
 * native git (builtin/submodule--helper.c): each scenario is built once with native git,
 * copied into twins, and every step runs `git submodule ...` in one twin and our command in
 * the other; stdout, stderr, the exit status and the resulting `.gitmodules`, `.git/config`,
 * submodules' configs, `.git/modules/` layout and worktree are compared after each step.
 *
 * Inputs come from git's t7400-submodule-basic.sh (init/deinit), t7403-submodule-sync.sh,
 * t7407-submodule-foreach.sh, t7419-submodule-set-branch.sh, t7420-submodule-set-url.sh and
 * t7425-submodule-gitdir-path-extension.sh, and JGit's SubmoduleInitTest, SubmoduleSyncTest
 * and SubmoduleDeinitTest.
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
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Git, SubmoduleCommandError, type SubmoduleCommandResult } from "../src/index.js";
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

/** Runs a bash script with native git's test environment (fixtures). */
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

const S = (s: string) => s.split("\0").join("");

/** The state compared: worktree files, configs, gitfiles and the modules layout. */
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

/** Runs each step in both twins (in `sub` of each), comparing outputs and states. */
async function expectTwins(t: { native: string; ours: string }, steps: Step[], sub = "sup") {
  for (const [args, run] of steps) {
    const label = `git submodule ${args.join(" ")}`;
    const n = nativeRun(join(t.native, sub), args);
    const o = await oursRun(async () => run(await ours(join(t.ours, sub))));
    const norm = (r: SubmoduleCommandResult, twin: string) => ({
      stdout: S(r.stdout).split(twin).join("<T>"),
      stderr: S(r.stderr).split(twin).join("<T>"),
      exitCode: r.exitCode,
    });
    expect(norm(o, t.ours), label).toEqual(norm(n, t.native));
    expect(snapshot(join(t.ours, sub), t.ours), label).toEqual(
      snapshot(join(t.native, sub), t.native),
    );
  }
}

/** An upstream `up` (one commit) and `sup` with submodules `sub` and `dir/s2` of it. */
const BASIC = `
git init -q -b main up; (cd up; echo x > x; git add x; git commit -qm x)
git init -q -b main sup; cd sup; echo a > a; git add a; git commit -qm a
git submodule add -q ../up sub
git submodule add -q ../up dir/s2
git commit -qm subs
`;

describeGit("git submodule init (t7400, SubmoduleInitTest)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "submodule-cmds-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("registers the URLs, resolved against the remote or the worktree, and -q", async () => {
    const t = twins(`${BASIC}
git config --remove-section submodule.sub; git config --remove-section submodule.dir/s2
`);
    await expectTwins(t, [
      [["init"], (g) => g.submoduleInit().call()],
      [["init"], (g) => g.submoduleInit().call()],
    ]);
    const q = twins(`${BASIC}
git config --remove-section submodule.sub; git config --remove-section submodule.dir/s2
git remote add origin https://example.com/org/sup.git
`);
    await expectTwins(q, [
      [["init", "-q", "--", "sub"], (g) => g.submoduleInit().setQuiet(true).addPath("sub").call()],
      [["init", "dir"], (g) => g.submoduleInit().addPath("dir").call()],
    ]);
  });

  it("copies update strategies, honours submodule.active, warns on suspicious entries", async () => {
    const t = twins(`
git init -q -b main up; (cd up; echo x>x; git add x; git commit -qm x)
U=$(git -C up rev-parse HEAD)
git init -q -b main sup; cd sup; echo a>a; git add a; git commit -qm a
for p in a1 b/b2 c3 d4 e5; do git update-index --add --cacheinfo 160000,$U,$p; done
printf '%s\\n' '[submodule "a1"]' '	path = a1' '	url = ./up1' '	update = rebase' \\
  '[submodule "b/b2"]' '	path = b/b2' '	url = ../up2' '	update = merge' '	branch = dev' \\
  '[submodule "c3"]' '	path = c3' '	url = git://example.com/c3' '	update = none' \\
  '[submodule "../evil"]' '	path = d4' '	url = x' \\
  '[submodule "d4"]' '	path = d4' '	url = -oops' \\
  '[submodule "e5"]' '	path = e5' > .gitmodules
git add .gitmodules; git commit -qm m
git remote add origin https://h/a/sup
git config submodule.active 'b/*'; git config --add submodule.active c3
`);
    await expectTwins(t, [
      [["init"], (g) => g.submoduleInit().call()],
      [["init", "--", "a1", "d4"], (g) => g.submoduleInit().addPath("a1").addPath("d4").call()],
      [["init", "e5"], (g) => g.submoduleInit().addPath("e5").call()],
      [["init", "nope"], (g) => g.submoduleInit().addPath("nope").call()],
      [["init", "a"], (g) => g.submoduleInit().addPath("a").call()],
      [["deinit", "--all"], (g) => g.submoduleDeinit().setAll(true).call()],
    ]);
  });

  it("keeps a registered URL and sets submodule.<name>.active=false to true", async () => {
    const t = twins(`${BASIC}
git config submodule.sub.url /somewhere/else; git config submodule.sub.active false
git config --unset submodule.dir/s2.url
`);
    await expectTwins(t, [[["init"], (g) => g.submoduleInit().call()]]);
  });

  it("resolves JGit's relative URLs against the remote (SubmoduleInitTest)", async () => {
    for (const remote of [
      "git://server/repo.git",
      "git://server/repo.git/",
      "user@host:path/to/repo",
      "../relative/super",
      "/abs/super",
    ]) {
      const t = twins(`
git init -q -b main up; (cd up; echo x>x; git add x; git commit -qm x)
U=$(git -C up rev-parse HEAD)
git init -q -b main sup; cd sup; echo a>a; git add a; git commit -qm a
for p in one two three; do git update-index --add --cacheinfo 160000,$U,$p; done
printf '%s\\n' '[submodule "one"]' '	path = one' '	url = ./sub.git' \\
  '[submodule "two"]' '	path = two' '	url = ../sub.git' \\
  '[submodule "three"]' '	path = three' '	url = ../../sub.git' > .gitmodules
git add .gitmodules; git commit -qm m
git remote add origin '${remote}'
`);
      await expectTwins(t, [[["init"], (g) => g.submoduleInit().call()]]);
    }
  });

  it.runIf(hasPathConfig)(
    "writes submodule.<name>.gitdir under extensions.submodulePathConfig (t7425)",
    async () => {
      const t = twins(`
git init -q -b main up; (cd up; echo x>x; git add x; git commit -qm x)
U=$(git -C up rev-parse HEAD)
git init -q -b main sup; cd sup; echo a>a; git add a; git commit -qm a
for p in a1 b/b2 C3 c3 'New Sub'; do git update-index --add --cacheinfo "160000,$U,$p"; done
printf '%s\\n' '[submodule "a1"]' '	path = a1' '	url = ../up' '[submodule "b/b2"]' '	path = b/b2' \\
  '	url = ../up' '[submodule "C3"]' '	path = C3' '	url = ../up' '[submodule "c3"]' '	path = c3' \\
  '	url = ../up' '[submodule "New Sub"]' '	path = New Sub' '	url = ../up' > .gitmodules
git add .gitmodules; git commit -qm m
git config core.repositoryformatversion 1; git config extensions.submodulePathConfig true
git config submodule.c3.gitdir .git/modules/kept
`);
      await expectTwins(t, [[["init"], (g) => g.submoduleInit().call()]]);
    },
  );
});

describeGit("git submodule deinit (t7400, SubmoduleDeinitTest)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "submodule-cmds-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("refuses local changes without -f, clears with -f, again, and --all", async () => {
    const t = twins(`${BASIC}
echo m >> sub/x
`);
    await expectTwins(t, [
      [["deinit"], (g) => g.submoduleDeinit().call()],
      [["deinit", "--all", "sub"], (g) => g.submoduleDeinit().setAll(true).addPath("sub").call()],
      [["deinit", "sub"], (g) => g.submoduleDeinit().addPath("sub").call()],
      [["deinit", "-f", "sub"], (g) => g.submoduleDeinit().setForce(true).addPath("sub").call()],
      [["deinit", "sub"], (g) => g.submoduleDeinit().addPath("sub").call()],
      [["deinit", "nope"], (g) => g.submoduleDeinit().addPath("nope").call()],
      [["deinit", "-q", "--all"], (g) => g.submoduleDeinit().setQuiet(true).setAll(true).call()],
      [["init"], (g) => g.submoduleInit().call()],
    ]);
  });

  it("refuses while .gitmodules has unstaged changes; untracked files count", async () => {
    const t = twins(`${BASIC}
echo '# c' >> .gitmodules
echo u > dir/s2/untracked
`);
    await expectTwins(t, [
      [["deinit", "sub"], (g) => g.submoduleDeinit().addPath("sub").call()],
      [["deinit", "dir/s2"], (g) => g.submoduleDeinit().addPath("dir/s2").call()],
    ]);
  });

  it("absorbs a .git directory first", async () => {
    const t = twins(`${BASIC}
git submodule deinit -q -f sub; rm -rf .git/modules/sub sub
git clone -q ../up sub
`);
    await expectTwins(t, [[["deinit", "sub"], (g) => g.submoduleDeinit().addPath("sub").call()]]);
  });
});

describeGit("git submodule sync (t7403, SubmoduleSyncTest)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "submodule-cmds-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const NESTED = `
git init -q -b main inner; (cd inner; echo i>i; git add i; git commit -qm i)
git init -q -b main up; (cd up; echo x>x; git add x; git commit -qm x; git submodule add -q ../inner nested; git commit -qm n)
git init -q -b main sup; cd sup; echo a>a; git add a; git commit -qm a
git remote add origin ../sup.git; git remote add other /x/y
git submodule add -q ../up sub
(cd sub; git submodule update -q --init)
git submodule add -q ../up dir/s2
git commit -qm subs
`;

  it("syncs URLs relative to a relative remote, recursively, and -q", async () => {
    const t = twins(`${NESTED}
git config submodule.sub.url /stale; git -C sub config remote.origin.url /stale
git -C sub/nested config remote.origin.url /stale
`);
    await expectTwins(t, [
      [["sync"], (g) => g.submoduleSync().call()],
      [["sync", "--recursive"], (g) => g.submoduleSync().setRecursive(true).call()],
      [["sync", "-q", "--", "dir"], (g) => g.submoduleSync().setQuiet(true).addPath("dir").call()],
      [["sync", "nope"], (g) => g.submoduleSync().addPath("nope").call()],
    ]);
  });

  it("changes .gitmodules URLs everywhere, skips inactive and unpopulated submodules", async () => {
    const t = twins(`${NESTED}
git config -f .gitmodules submodule.sub.url ../moved
git config -f .gitmodules submodule.dir/s2.url https://example.com/s2
git config submodule.dir/s2.active false
git submodule deinit -q -f sub
git config submodule.sub.url x
`);
    await expectTwins(t, [
      [["sync", "--recursive"], (g) => g.submoduleSync().setRecursive(true).call()],
    ]);
  });

  it("picks the submodule's remote by its URL in 2.5x, its default remote in 2.43", async () => {
    const t = twins(`
git init -q -b main up; (cd up; echo x>x; git add x; git commit -qm x)
git init -q -b main sup; cd sup; echo a>a; git add a; git commit -qm a
git submodule add -q ../up sub; git commit -qm s
git remote add origin /srv/sup
(cd sub; git remote rename origin upstream; git remote add origin /elsewhere; git config remote.upstream.url /srv/up; git config --unset branch.main.remote)
`);
    await expectTwins(t, [
      [["sync"], (g) => g.submoduleSync().setCompatibility(compatibility).call()],
    ]);
  });
});

describeGit("git submodule set-url and set-branch (t7420, t7419)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "submodule-cmds-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("set-url rewrites .gitmodules and syncs (t7420)", async () => {
    const t = twins(`${BASIC}
git remote add origin /srv/x/sup.git
`);
    await expectTwins(t, [
      [
        ["set-url", "sub", "../other"],
        (g) => g.submoduleSetUrl().setPath("sub").setUrl("../other").call(),
      ],
      [
        ["set-url", "--", "dir/s2", "https://example.com/new"],
        (g) => g.submoduleSetUrl().setPath("dir/s2").setUrl("https://example.com/new").call(),
      ],
      [
        ["set-url", "-q", "sub", "./q"],
        (g) => g.submoduleSetUrl().setQuiet(true).setPath("sub").setUrl("./q").call(),
      ],
      [["set-url", "nope", "u"], (g) => g.submoduleSetUrl().setPath("nope").setUrl("u").call()],
    ]);
    const inactive = twins(`${BASIC}
git config submodule.sub.active false
`);
    await expectTwins(inactive, [
      [["set-url", "sub", "../x"], (g) => g.submoduleSetUrl().setPath("sub").setUrl("../x").call()],
    ]);
  });

  it("set-branch sets and removes the branch (t7419)", async () => {
    const t = twins(BASIC);
    await expectTwins(t, [
      [
        ["set-branch", "-b", "topic", "sub"],
        (g) => g.submoduleSetBranch().setPath("sub").setBranch("topic").call(),
      ],
      [
        ["set-branch", "--branch", "t2", "sub"],
        (g) => g.submoduleSetBranch().setPath("sub").setBranch("t2").call(),
      ],
      [
        ["set-branch", "-q", "-d", "sub"],
        (g) => g.submoduleSetBranch().setQuiet(true).setPath("sub").setDefault(true).call(),
      ],
      [
        ["set-branch", "-d", "sub"],
        (g) => g.submoduleSetBranch().setPath("sub").setDefault(true).call(),
      ],
      [["set-branch", "sub"], (g) => g.submoduleSetBranch().setPath("sub").call()],
      [
        ["set-branch", "-b", "x", "-d", "sub"],
        (g) => g.submoduleSetBranch().setPath("sub").setBranch("x").setDefault(true).call(),
      ],
      [
        ["set-branch", "-b", "x", "nope"],
        (g) => g.submoduleSetBranch().setPath("nope").setBranch("x").call(),
      ],
    ]);
  });
});

describeGit("git submodule foreach (t7407)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "submodule-cmds-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const NESTED = `
git init -q -b main inner; (cd inner; echo i>i; git add i; git commit -qm i)
git init -q -b main up; (cd up; echo x>x; git add x; git commit -qm x; git submodule add -q ../inner nested; git commit -qm n)
git init -q -b main sup; cd sup; echo a>a; git add a; git commit -qm a
git submodule add -q ../up sub
(cd sub; git submodule update -q --init)
git submodule add -q ../up 'dir/s 2'
git submodule add -q ../up gone
git commit -qm subs
git submodule deinit -q gone
`;
  const SHOW =
    'echo "$name|$sm_path|$displaypath|$sha1|$toplevel|$path|$GIT_DIR"; pwd; echo err >&2';

  it("runs a shell command with git's variables, recursively, quietly", async () => {
    const t = twins(NESTED);
    await expectTwins(t, [
      [["foreach", SHOW], (g) => g.submoduleForeach().setCommand([SHOW]).call()],
      [
        ["foreach", "--recursive", SHOW],
        (g) => g.submoduleForeach().setRecursive(true).setCommand([SHOW]).call(),
      ],
      [
        ["--quiet", "foreach", "echo", "a b", "$name"],
        (g) => g.submoduleForeach().setQuiet(true).setCommand(["echo", "a b", "$name"]).call(),
      ],
      [["foreach"], (g) => g.submoduleForeach().call()],
      [
        ["foreach", "--recursive", "test $name = nested && exit 3; echo ok"],
        (g) =>
          g
            .submoduleForeach()
            .setRecursive(true)
            .setCommand(["test $name = nested && exit 3; echo ok"])
            .call(),
      ],
      [["foreach", "false"], (g) => g.submoduleForeach().setCommand(["false"]).call()],
    ]);
  });

  it("calls back with the same values", async () => {
    const t = twins(NESTED);
    await expectTwins(t, [
      [
        ["foreach", "--recursive", 'echo "$name|$sm_path|$displaypath|$sha1|$toplevel"'],
        (g) =>
          g
            .submoduleForeach()
            .setRecursive(true)
            .setCallback(async (c) => ({
              stdout: `${c.name}|${c.path}|${c.displayPath}|${c.sha1}|${c.toplevel}\n`,
            }))
            .call(),
      ],
    ]);
  });
});
