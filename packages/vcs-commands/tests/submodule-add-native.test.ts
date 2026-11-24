/**
 * `git submodule add` against native git (builtin/submodule--helper.c `module_add`,
 * `add_submodule`, `clone_submodule`, `configure_added_submodule`): each scenario is built
 * once with native git and copied into twins; every step runs `git submodule add ...` in one
 * twin and our command in the other, and compares stdout, stderr, the exit status, the
 * worktree (gitfiles included), `.gitmodules`, `.git/config`, each `.git/modules/<name>`'s
 * layout, config, HEAD and refs, and the superproject's and submodules' indexes
 * (`ls-files -s`).
 *
 * Inputs come from git's t7400-submodule-basic.sh (each test names its title there) and
 * JGit's SubmoduleAddTest. Local URLs need `protocol.file.allow=always`, as git's tests set
 * it; one test leaves it unset (git 2.38+'s default `user`, and `git submodule` runs its
 * clone with GIT_PROTOCOL_FROM_USER=0).
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
const compatibility = is25x ? "2.56" : "2.43";
const hasPathConfig = gitAtLeast(versionLine, 2, 52);

/** `-c protocol.file.allow=always`, as git's tests clone local submodules. */
const ALLOW_FILE = { GIT_CONFIG_PARAMETERS: "'protocol.file.allow'='always'" };

/** What a `.git/modules/<name>` holds that both implementations write. */
const MODULE_LAYOUT = new Set(["HEAD", "config", "index", "objects", "refs", "shallow"]);

let root: string;
let caseNo = 0;

/** Runs a bash script with native git's test environment (fixtures). */
function sh(cwd: string, script: string): string {
  return execFileSync("bash", ["-euc", script], {
    cwd,
    env: { ...testEnv(root), ...ALLOW_FILE },
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

/** Native git's stdout in `cwd` (read-only questions about a twin), or its failure. */
function ask(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, env: testEnv(root) });
  return `${r.stdout.toString("latin1")}${r.status ? `[exit ${r.status}]` : ""}`;
}

/** The state compared: worktree files, configs, gitfiles, modules, indexes and refs. */
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
        } else {
          out[r] = norm(readFileSync(p, "latin1"));
          out[`${r} (ls-files)`] = ask(abs, ["ls-files", "-s"]);
        }
      } else if (st.isSymbolicLink()) out[r] = `link -> ${readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[`${r}/`] = "dir";
        walk(p, r);
      } else out[r] = norm(readFileSync(p, "latin1"));
    }
  };
  walk(dir, "");
  out["(ls-files)"] = ask(dir, ["ls-files", "-s"]);
  return out;
}

/** Our working copy of `<twin>/sup` (the FilesApi rooted at the twin, so `../up` is in reach). */
async function ours(
  twin: string,
  env: Record<string, string>,
  noEnvironment = false,
): Promise<Git> {
  if (noEnvironment) return openOurs(twin, undefined, undefined, "sup", false);
  const environment = createNodeGitHostEnvironment({
    env,
    hookRunner: createNodeHookRunner({ env, compatibility }),
  });
  return openOurs(twin, environment, undefined, "sup", true);
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

/** Our `submodule add` in the version of the native git under test. */
const sa = (g: Git) => g.submoduleAdd().setCompatibility(compatibility);

/**
 * One step: native git's arguments and our call, each given the twin it runs in (absolute
 * paths differ between twins).
 */
type Step = [
  args: string[] | ((twin: string) => string[]),
  run: (git: Git, twin: string) => Promise<SubmoduleCommandResult>,
];

interface TwinOptions {
  /** Leave `protocol.file.allow` at git's default */
  noAllowFile?: boolean;
  /** `.gitmodules` holds a twin's absolute path: its blob id differs between twins */
  absoluteUrls?: boolean;
  /** Open ours with no host environment (no `-c` config, no GIT_PROTOCOL_FROM_USER) */
  noEnvironment?: boolean;
}

/** Runs each step in both twins (in `sup`), comparing outputs and states. */
async function expectTwins(
  t: { native: string; ours: string },
  steps: Step[],
  options: TwinOptions = {},
): Promise<void> {
  const env = { ...testEnv(root), ...(options.noAllowFile ? {} : ALLOW_FILE) };
  for (const [args, run] of steps) {
    const nativeArgs = typeof args === "function" ? args(t.native) : args;
    const label = `git submodule add ${nativeArgs.join(" ")}`;
    const r = spawnSync("git", ["submodule", "add", ...nativeArgs], {
      cwd: join(t.native, "sup"),
      env,
    });
    const n: SubmoduleCommandResult = {
      stdout: r.stdout.toString("utf8"),
      stderr: r.stderr.toString("utf8"),
      exitCode: r.status ?? -1,
    };
    const o = await oursRun(async () =>
      run(await ours(t.ours, env, options.noEnvironment), t.ours),
    );
    const norm = (x: SubmoduleCommandResult, twin: string) => ({
      stdout: x.stdout.split(twin).join("<T>"),
      stderr: x.stderr.split(twin).join("<T>"),
      exitCode: x.exitCode,
    });
    expect(norm(o, t.ours), label).toEqual(norm(n, t.native));
    const state = (twin: string) => {
      const snap = snapshot(join(twin, "sup"), twin);
      if (options.absoluteUrls) {
        const key = "(ls-files)";
        snap[key] = (snap[key] ?? "").replace(
          /^(100644 )[0-9a-f]+( 0\t\.gitmodules)$/m,
          "$1<id>$2",
        );
      }
      return snap;
    };
    expect(state(t.ours), label).toEqual(state(t.native));
  }
}

/** `git submodule add <args>` and ours with the same URL and path (and options). */
const add = (
  args: string[],
  build: (command: ReturnType<typeof sa>) => ReturnType<typeof sa>,
): Step => [args, (g) => build(sa(g)).call()];

/** `up` (two commits on main, a branch `dev`) and `sup` (one commit). */
const BASIC = `
git init -q -b main up; (cd up; echo x > x; git add x; git commit -qm x; git branch dev
  echo y > y; git add y; git commit -qm y)
git init -q -b main sup; cd sup; echo a > a; git add a; git commit -qm a
`;

describeGit("git submodule add (t7400-submodule-basic, SubmoduleAddTest)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "submodule-add-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t7400-submodule-basic.sh: "submodule add", "submodule add --branch" (SubmoduleAddTest.addSubmodule, addSubmoduleWithName)', async () => {
    const t = twins(BASIC);
    await expectTwins(t, [
      add(["../up", "sub"], (c) => c.setURI("../up").setPath("sub")),
      add(["-b", "dev", "--name", "nm", "../up", "d/s2"], (c) =>
        c.setBranch("dev").setName("nm").setURI("../up").setPath("d/s2"),
      ),
      add(["-q", "../up/", "q"], (c) => c.setQuiet(true).setURI("../up/").setPath("q")),
    ]);
  });

  it('t7400-submodule-basic.sh: "add submodules without specifying an explicit path"', async () => {
    const t = twins(`${BASIC}
git clone -q --bare ../up ../bare.git
`);
    await expectTwins(t, [
      add(["../up/.git"], (c) => c.setURI("../up/.git")),
      add(["../bare.git"], (c) => c.setURI("../bare.git")),
    ]);
  });

  it('t7400-submodule-basic.sh: "submodule add with ./, /.. and // in path"', async () => {
    const t = twins(BASIC);
    await expectTwins(t, [
      add(["../up", "./x//y/../z"], (c) => c.setURI("../up").setPath("./x//y/../z")),
      add(["../up", "././w"], (c) => c.setURI("../up").setPath("././w")),
    ]);
  });

  it('t7400-submodule-basic.sh: "gracefully add/reset submodule with a trailing slash"', async () => {
    const t = twins(BASIC);
    await expectTwins(t, [
      add(["../up", "t/"], (c) => c.setURI("../up").setPath("t/")),
      add(["../up", "with space"], (c) => c.setURI("../up").setPath("with space")),
    ]);
  });

  it('t7400-submodule-basic.sh: "submodule add to .gitignored path fails"', async () => {
    const t = twins(`${BASIC}
printf '%s\\n' ign 'pat*' > .gitignore; git add .gitignore; git commit -qm i
`);
    await expectTwins(t, [
      add(["../up", "ign"], (c) => c.setURI("../up").setPath("ign")),
      add(["../up", "pattern"], (c) => c.setURI("../up").setPath("pattern")),
    ]);
  });

  it('t7400-submodule-basic.sh: "submodule add to .gitignored path with --force"', async () => {
    const t = twins(`${BASIC}
echo '*' > .gitignore; git add -f .gitignore; git commit -qm i
`);
    await expectTwins(t, [
      add(["--force", "../up", "submod"], (c) =>
        c.setForce(true).setURI("../up").setPath("submod"),
      ),
    ]);
  });

  it('t7400-submodule-basic.sh: "submodule add to path with tracked content fails"', async () => {
    const t = twins(`${BASIC}
mkdir dir-tracked; echo f > dir-tracked/bar; git add dir-tracked/bar; git commit -qm d
`);
    await expectTwins(t, [
      add(["../up", "dir-tracked"], (c) => c.setURI("../up").setPath("dir-tracked")),
      add(["../up", "a"], (c) => c.setURI("../up").setPath("a")),
      add(["../up", "*"], (c) => c.setURI("../up").setPath("*")),
      add(["-f", "../up", "a"], (c) => c.setForce(true).setURI("../up").setPath("a")),
    ]);
  });

  it('t7400-submodule-basic.sh: "submodule add to reconfigure existing submodule with --force"', async () => {
    const t = twins(`${BASIC}
git submodule add -q ../up submod; git commit -qm sub
git clone -q ../up ../bogus
`);
    await expectTwins(t, [
      add(["../up", "submod"], (c) => c.setURI("../up").setPath("submod")),
      add(["--force", "../bogus", "submod"], (c) =>
        c.setForce(true).setURI("../bogus").setPath("submod"),
      ),
      add(["--force", "-b", "dev", "../up", "submod-branch"], (c) =>
        c.setForce(true).setBranch("dev").setURI("../up").setPath("submod-branch"),
      ),
      add(["--force", "../up", "submod"], (c) =>
        c.setForce(true).setURI("../up").setPath("submod"),
      ),
    ]);
  });

  it('t7400-submodule-basic.sh: "submodule add with incomplete .gitmodules"', async () => {
    const t = twins(`${BASIC}
git init -q -b main one; git -C one commit -q --allow-empty -m one-initial
git config -f .gitmodules submodule.one.ignore all
`);
    await expectTwins(t, [add(["./one"], (c) => c.setURI("./one"))]);
  });

  it('t7400-submodule-basic.sh: "add aborts on repository with no commits", "add should fail when path is used by a file", "add should fail when path is used by an existing directory"', async () => {
    const t = twins(`${BASIC}
git init -q repo-no-commits
touch file; mkdir empty-dir; mkdir notrepo; echo f > notrepo/f
`);
    await expectTwins(t, [
      add(["../a", "./repo-no-commits"], (c) => c.setURI("../a").setPath("./repo-no-commits")),
      add(["../up", "file"], (c) => c.setURI("../up").setPath("file")),
      add(["../up", "empty-dir"], (c) => c.setURI("../up").setPath("empty-dir")),
      add(["../up", "notrepo"], (c) => c.setURI("../up").setPath("notrepo")),
      add(["../up", "a/b"], (c) => c.setURI("../up").setPath("a/b")),
    ]);
  });

  it("adds a repository already at the path (t7400 \"submodule add\"'s 'Adding existing repo')", async () => {
    const t = twins(`${BASIC}
git init -q -b main existing; (cd existing; echo e > e; git add e; git commit -qm e)
`);
    await expectTwins(t, [
      add(["../up", "existing"], (c) => c.setURI("../up").setPath("existing")),
    ]);
  });

  it("refuses bad URLs and names (SubmoduleAddTest.addSubmoduleWithInvalidUri, t7400 'submodule add' checks)", async () => {
    const t = twins(BASIC);
    await expectTwins(t, [
      add(["--", "-upstream", "s1"], (c) => c.setURI("-upstream").setPath("s1")),
      add(["bad-url", "s1"], (c) => c.setURI("bad-url").setPath("s1")),
      add(["--name", "../x", "../up", "s2"], (c) =>
        c.setName("../x").setURI("../up").setPath("s2"),
      ),
      add(["--name", "a/../b", "../up", "s2"], (c) =>
        c.setName("a/../b").setURI("../up").setPath("s2"),
      ),
    ]);
    const gone = twins(`${BASIC}
git submodule add -q ../up sub; git commit -qm sub; rm .gitmodules
`);
    await expectTwins(gone, [add(["../up", "s3"], (c) => c.setURI("../up").setPath("s3"))]);
  });

  it('t7400-submodule-basic.sh: "submodule add --name allows to replace a submodule with another at the same path"', async () => {
    const t = twins(`${BASIC}
git clone -q --bare ../up ../bare.git
git submodule add -q ../up repo; git commit -qm repo
rm -rf repo; git rm -q repo
`);
    await expectTwins(t, [
      add(["-q", "--name", "repo_new", "../bare.git", "repo"], (c) =>
        c.setQuiet(true).setName("repo_new").setURI("../bare.git").setPath("repo"),
      ),
    ]);
  });

  it('t7400-submodule-basic.sh: "submodule add with an existing name fails unless forced"', async () => {
    const t = twins(`${BASIC}
git clone -q --bare ../up ../bare.git
git submodule add -q --name repo_new ../bare.git repo; git commit -qm repo
rm -rf repo; git rm -q repo
`);
    await expectTwins(t, [
      add(["-q", "--name", "repo_new", "../up", "repo"], (c) =>
        c.setQuiet(true).setName("repo_new").setURI("../up").setPath("repo"),
      ),
      add(["-f", "-q", "--name", "repo_new", "../up", "repo"], (c) =>
        c.setForce(true).setQuiet(true).setName("repo_new").setURI("../up").setPath("repo"),
      ),
    ]);
  });

  it('t7400-submodule-basic.sh: "submodule add fails when name is reused"', async () => {
    const t = twins(`${BASIC}
git submodule add -q ../up child; git commit -qm child
git mv child child_old; git commit -qm moved
`);
    await expectTwins(t, [
      add(["../up", "child"], (c) => c.setURI("../up").setPath("child")),
      add(["-f", "../up", "child"], (c) => c.setForce(true).setURI("../up").setPath("child")),
    ]);
  });

  it('t7400-submodule-basic.sh: "use superproject as upstream when path is relative and no url is set there" (SubmoduleAddTest.addSubmoduleWithRelativeUri)', async () => {
    const t = twins(BASIC);
    await expectTwins(t, [
      add(["../up", "relative"], (c) => c.setURI("../up").setPath("relative")),
      add(["./.git", "self"], (c) => c.setURI("./.git").setPath("self")),
    ]);
    const remote = twins(`${BASIC}
git remote add origin ../sup
`);
    await expectTwins(remote, [add(["../up", "sub"], (c) => c.setURI("../up").setPath("sub"))]);
  });

  it('t7400-submodule-basic.sh: "submodule add (absolute path)"', async () => {
    const t = twins(BASIC);
    await expectTwins(
      t,
      [
        [
          (twin) => [join(twin, "up"), "abs"],
          (g, twin) => sa(g).setURI(join(twin, "up")).setPath("abs").call(),
        ],
        [
          (twin) => [`file://${join(twin, "up")}`, "fileurl"],
          (g, twin) =>
            sa(g)
              .setURI(`file://${join(twin, "up")}`)
              .setPath("fileurl")
              .call(),
        ],
      ],
      { absoluteUrls: true },
    );
  });

  it('t7400-submodule-basic.sh: "submodule add clone shallow submodule"', async () => {
    const t = twins(BASIC);
    await expectTwins(
      t,
      [
        [
          (twin) => ["--depth=1", `file://${join(twin, "up")}`, "submodule"],
          (g, twin) =>
            sa(g)
              .setDepth(1)
              .setURI(`file://${join(twin, "up")}`)
              .setPath("submodule")
              .call(),
        ],
      ],
      { absoluteUrls: true },
    );
    await expectTwins(
      t,
      [
        add(["--depth", "1", "../up", "deep"], (c) =>
          c.setDepth(1).setURI("../up").setPath("deep"),
        ),
        add(["-b", "nope", "../up", "nb"], (c) =>
          c.setBranch("nope").setURI("../up").setPath("nb"),
        ),
      ],
      { absoluteUrls: true },
    );
  });

  it('t7400-submodule-basic.sh: "submodule with UTF-8 name"', async () => {
    const t = twins(`${BASIC}
svname=$(printf "\\303\\245 \\303\\244\\303\\266")
git init -q -b main "$svname"; (cd "$svname"; : > sub; git add sub; git commit -qm "init sub")
mv "$svname" ../"$svname"
`);
    const svname = "å äö";
    await expectTwins(t, [add([`../${svname}`], (c) => c.setURI(`../${svname}`))]);
  });

  it("borrows objects with --reference", async () => {
    const t = twins(`${BASIC}
git clone -q --bare ../up ../ref.git
`);
    await expectTwins(t, [
      [
        (twin) => ["--reference", join(twin, "ref.git"), "../up", "r"],
        (g, twin) => sa(g).setReference(join(twin, "ref.git")).setURI("../up").setPath("r").call(),
      ],
    ]);
  });

  it('t7400-submodule-basic.sh: "submodule update --init with submodule.active set" (active set only for paths the patterns leave out)', async () => {
    const t = twins(`${BASIC}
git config submodule.active 'q*'
`);
    await expectTwins(t, [
      add(["../up", "q1"], (c) => c.setURI("../up").setPath("q1")),
      add(["../up", "r1"], (c) => c.setURI("../up").setPath("r1")),
    ]);
  });

  it("refuses local clones under protocol.file.allow's default user (git 2.38+, t7400's setup sets it)", async () => {
    const t = twins(BASIC);
    await expectTwins(t, [add(["../up", "sub"], (c) => c.setURI("../up").setPath("sub"))], {
      noAllowFile: true,
    });
  });

  it('t7400-submodule-basic.sh: "submodule add relays add --dry-run stderr"', async () => {
    const t = twins(`${BASIC}
: > .git/index.lock
`);
    await expectTwins(t, [
      add(["../up", "sub-while-locked"], (c) => c.setURI("../up").setPath("sub-while-locked")),
    ]);
  });

  it.runIf(hasPathConfig)(
    't7425-submodule-gitdir-path-extension.sh: "verify new submodule gitdir config"',
    async () => {
      const t = twins(`${BASIC}
git config core.repositoryformatversion 1; git config extensions.submodulePathConfig true
`);
      await expectTwins(t, [
        add(["../up", "sub"], (c) => c.setURI("../up").setPath("sub")),
        add(["--name", "x/y", "../up", "nested"], (c) =>
          c.setName("x/y").setURI("../up").setPath("nested"),
        ),
      ]);
    },
  );

  it("refuses local clones under protocol.file.allow's default user with no host environment too", async () => {
    const t = twins(BASIC);
    await expectTwins(t, [add(["../up", "sub"], (c) => c.setURI("../up").setPath("sub"))], {
      noAllowFile: true,
      noEnvironment: true,
    });
  });

  it("refuses paths outside the repository before creating anything", async () => {
    const t = twins(BASIC);
    await expectTwins(t, [
      add(["../up", "../outside"], (c) => c.setURI("../up").setPath("../outside")),
      add(["../up", "a/../../x"], (c) => c.setURI("../up").setPath("a/../../x")),
      [
        (twin) => ["../up", join(twin, "abs")],
        (g, twin) => sa(g).setURI("../up").setPath(join(twin, "abs")).call(),
      ],
    ]);
  });

  it('t7400-submodule-basic.sh: "submodule add to reconfigure existing submodule with --force" (a file where the kept git directory\'s worktree goes)', async () => {
    const t = twins(`${BASIC}
git submodule add -q ../up k; git commit -qm k
git rm -q k; git commit -qm gone; echo f > k
`);
    await expectTwins(t, [
      add(["-f", "../up", "k"], (c) => c.setForce(true).setURI("../up").setPath("k")),
    ]);
  });
});
