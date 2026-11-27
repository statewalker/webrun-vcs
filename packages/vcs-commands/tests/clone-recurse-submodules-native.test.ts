/**
 * `git clone --recurse-submodules` against native git (builtin/clone.c: `submodule.active`
 * written with the clone's configuration, then `git submodule update --require-init
 * --recursive [--depth=1] [--remote --no-fetch] [--filter=<spec>] [--[no-]single-branch]`
 * after the checkout): native git clones into `native`, ours into `ours` (an empty
 * repository first), from the same sources; the submodule update's stdout, stderr and exit
 * status are compared, and every repository the clones made (the superproject and each
 * submodule, nested ones too): HEAD, refs, config, shallow file, objects, index and files.
 *
 * Inputs come from git's t5614-clone-submodules-shallow.sh and t5617-clone-submodules-remote.sh
 * (each test names its title there) and JGit's CloneCommandTest. Submodules are cloned with
 * GIT_PROTOCOL_FROM_USER=0, so local URLs need `protocol.file.allow=always`, as the scripts
 * set it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
import { ourClone } from "./clone-options-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const ALLOW_FILE = { GIT_CONFIG_PARAMETERS: "'protocol.file.allow'='always'" };

let root: string;
let caseNo = 0;

function sh(cwd: string, script: string, extra: Record<string, string> = {}): string {
  return execFileSync("bash", ["-euc", script], {
    cwd,
    env: { ...testEnv(root), ...ALLOW_FILE, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("latin1");
}

const HELPERS = `
pwd=$(pwd)
test_commit () { echo "$1" > "$1.t"; git add "$1.t"; git commit -qm "$1"; git tag "$1"; }
`;

/** t5614-clone-submodules-shallow.sh: "setup" (the superproject is `super`). */
const T5614_SETUP = `
git init -q -b main super; cd super; test_commit commit1; test_commit commit2
mkdir sub; (cd sub; git init -q -b main; test_commit subcommit1; test_commit subcommit2; test_commit subcommit3)
git submodule add -q "file://$pwd/super/sub" sub; git commit -qm "add submodule"
`;

/** t5617-clone-submodules-remote.sh: "setup", "setup bare clone for server". */
const T5617_SETUP = `
git init -q -b main super; cd super; test_commit commit1
mkdir sub; (cd sub; git init -q -b main; test_commit subcommit1; git tag sub_when_added_to_super; git branch other)
git submodule add -q "file://$pwd/super/sub" sub; git commit -qm "add submodule"
(cd sub; test_commit subcommit2)
cd ..; git clone -q --bare "file://$pwd/super/." srv.bare
git -C srv.bare config --local uploadpack.allowfilter 1; git -C srv.bare config --local uploadpack.allowanysha1inwant 1
`;

/** JGit CloneCommandTest.testCloneRepositoryWithNestedSubmodules: sub2 inside sub1 inside super. */
const NESTED_SETUP = `
git init -q -b master sub2; (cd sub2; echo content > file.txt; git add file.txt; git commit -qm "create file")
git init -q -b master sub1; (cd sub1; echo content > file.txt; git add file.txt; git commit -qm "create file"
  git submodule add -q "$pwd/sub2" sub; git commit -qm "Adding submodule")
git init -q -b master super; (cd super; echo content > file.txt; git add file.txt; git commit -qm "create file"
  git submodule add -q "$pwd/sub1" sub; git commit -qm "Adding submodule")
`;

/** A case directory with the fixture built in it. */
function fixture(script: string): string {
  const home = join(root, `case${++caseNo}`);
  execFileSync("mkdir", ["-p", home]);
  sh(home, `${HELPERS}${script}`);
  return home;
}

/** Each repository below `dir` (itself and its submodules, recursively), its state. */
function snapshot(home: string, dir: string, twin: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const norm = (s: string) => s.split(`/${twin}/`).join("/<T>/").split(`/${twin}\n`).join("/<T>\n");
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, env: testEnv(home) });
    return `${r.stdout.toString("latin1")}${r.status ? `[exit ${r.status}]` : ""}`;
  };
  const visit = (repo: string, rel: string) => {
    if (!existsSync(join(repo, ".git"))) {
      out[rel] = "not populated";
      return;
    }
    const gitDir = git(repo, "rev-parse", "--absolute-git-dir").trim();
    const read = (name: string) =>
      existsSync(join(gitDir, name)) ? norm(readFileSync(join(gitDir, name), "latin1")) : "-";
    out[rel] = {
      head: read("HEAD"),
      refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname) %(symref)"),
      config: read("config"),
      shallow: read("shallow"),
      gitfile:
        existsSync(join(repo, ".git")) && !existsSync(join(repo, ".git", "HEAD"))
          ? norm(readFileSync(join(repo, ".git"), "latin1"))
          : "dir",
      objects: git(
        repo,
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype)",
      )
        .split("\n")
        .filter(Boolean)
        .sort(),
      index: git(repo, "ls-files", "-s"),
      files: readdirSync(repo).sort(),
    };
    for (const line of git(repo, "ls-files", "-s").split("\n")) {
      const m = /^160000 [0-9a-f]+ \d\t(.*)$/.exec(line);
      if (m) visit(join(repo, m[1] as string), `${rel}/${m[1]}`);
    }
  };
  visit(join(home, dir), ".");
  return out;
}

type Clone = ReturnType<Git["clone"]>;

/**
 * Runs `git clone <args> <url> native` and our clone of `url` into `ours`, comparing the
 * submodule part of stderr, stdout, the exit status and the repositories.
 */
async function expectTwins(
  home: string,
  args: string[],
  url: string,
  configure: (c: Clone) => Clone,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const env = { ...testEnv(home), ...ALLOW_FILE, ...extraEnv };
  const r = spawnSync("git", ["clone", ...args, url, "native"], { cwd: home, env });
  const nativeErr = r.stderr.toString("utf8");
  const result = await ourClone(
    home,
    join(home, "ours"),
    (c) => configure(c.setURI(url).setDirectory("ours")),
    { extraEnv: { ...ALLOW_FILE, ...extraEnv } },
  );
  const local = !/^[a-z]+:\/\//.test(url);
  const ourErr = `Cloning into 'ours'...\n${(result.messages ?? []).join("")}${local ? "done.\n" : ""}${result.submodules?.stderr ?? ""}`;
  const mine = {
    stdout: result.submodules?.stdout ?? "",
    stderr: ourErr.split("/ours/").join("/<T>/").replace("'ours'", "'<T>'"),
    exitCode: result.hookExitCode ?? result.submodules?.exitCode ?? 0,
  };
  const native = {
    stdout: r.stdout.toString("utf8"),
    stderr: nativeErr.split("/native/").join("/<T>/").replace("'native'", "'<T>'"),
    exitCode: r.status ?? -1,
  };
  expect(mine).toEqual(native);
  expect(snapshot(home, "ours", "ours")).toEqual(snapshot(home, "native", "native"));
}

describeGit("git clone --recurse-submodules (native twins)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clone-recurse-"));
  });
  afterAll(async () => {
    if (!process.env.KEEP_TWINS) await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  const t5614 =
    (args: string[], configure: (c: Clone) => Clone, setup = "") =>
    async () => {
      const home = fixture(`${T5614_SETUP}${setup}`);
      await expectTwins(home, args, `file://${home}/super/.`, configure);
    };

  it(
    't5614-clone-submodules-shallow.sh: "nonshallow clone implies nonshallow submodule"',
    t5614(["--recurse-submodules"], (c) => c.setRecurseSubmodules(true)),
  );
  it(
    't5614-clone-submodules-shallow.sh: "shallow clone with shallow submodule"',
    t5614(["--recurse-submodules", "--depth", "2", "--shallow-submodules"], (c) =>
      c.setRecurseSubmodules(true).setDepth(2).setShallowSubmodules(true),
    ),
  );
  it(
    't5614-clone-submodules-shallow.sh: "shallow clone does not imply shallow submodule"',
    t5614(["--recurse-submodules", "--depth", "2"], (c) =>
      c.setRecurseSubmodules(true).setDepth(2),
    ),
  );
  it(
    't5614-clone-submodules-shallow.sh: "shallow clone with non shallow submodule"',
    t5614(["--recurse-submodules", "--depth", "2", "--no-shallow-submodules"], (c) =>
      c.setRecurseSubmodules(true).setDepth(2).setShallowSubmodules(false),
    ),
  );
  it(
    't5614-clone-submodules-shallow.sh: "non shallow clone with shallow submodule"',
    t5614(["--recurse-submodules", "--no-local", "--shallow-submodules"], (c) =>
      c.setRecurseSubmodules(true).setLocal(false).setShallowSubmodules(true),
    ),
  );
  it(
    't5614-clone-submodules-shallow.sh: "clone follows shallow recommendation"',
    t5614(
      ["--recurse-submodules", "--no-local"],
      (c) => c.setRecurseSubmodules(true).setLocal(false),
      `git config -f .gitmodules submodule.sub.shallow true; git add .gitmodules; git commit -qm "recommend shallow for sub"`,
    ),
  );
  it(
    't5614-clone-submodules-shallow.sh: "clone follows non shallow recommendation"',
    t5614(
      ["--recurse-submodules", "--no-local"],
      (c) => c.setRecurseSubmodules(true).setLocal(false),
      `git config -f .gitmodules submodule.sub.shallow false; git add .gitmodules; git commit -qm "recommend non shallow for sub"`,
    ),
  );

  const t5617 =
    (
      args: string[],
      configure: (c: Clone) => Clone,
      source = "super/.",
      extraEnv: Record<string, string> = {},
    ) =>
    async () => {
      const home = fixture(T5617_SETUP);
      await expectTwins(home, args, `file://${home}/${source}`, configure, extraEnv);
    };

  it(
    't5617-clone-submodules-remote.sh: "clone with --no-remote-submodules", "check the default is --no-remote-submodules"',
    t5617(["--recurse-submodules", "--no-remote-submodules"], (c) =>
      c.setRecurseSubmodules(true).setRemoteSubmodules(false),
    ),
  );
  it(
    't5617-clone-submodules-remote.sh: "clone with --remote-submodules"',
    t5617(["--recurse-submodules", "--remote-submodules"], (c) =>
      c.setRecurseSubmodules(true).setRemoteSubmodules(true),
    ),
  );
  it(
    't5617-clone-submodules-remote.sh: "clone with --single-branch"',
    t5617(["--recurse-submodules", "--single-branch"], (c) =>
      c.setRecurseSubmodules(true).setSingleBranch(true),
    ),
  );
  it(
    't5617-clone-submodules-remote.sh: "clone with --filter"',
    t5617(
      ["--recurse-submodules", "--filter", "blob:none", "--also-filter-submodules"],
      (c) => c.setRecurseSubmodules(true).setFilter("blob:none").setAlsoFilterSubmodules(true),
      "srv.bare",
    ),
  );
  it(
    't5617-clone-submodules-remote.sh: "filters applied with clone.filterSubmodules"',
    t5617(
      ["--recurse-submodules", "--filter", "blob:none"],
      (c) => c.setRecurseSubmodules(true).setFilter("blob:none"),
      "srv.bare",
      { GIT_CONFIG_PARAMETERS: "'protocol.file.allow'='always' 'clone.filterSubmodules'='true'" },
    ),
  );
  it(
    't5617-clone-submodules-remote.sh: "--no-also-filter-submodules overrides clone.filterSubmodules=true"',
    t5617(
      ["--recurse-submodules", "--filter", "blob:none", "--no-also-filter-submodules"],
      (c) => c.setRecurseSubmodules(true).setFilter("blob:none").setAlsoFilterSubmodules(false),
      "srv.bare",
      { GIT_CONFIG_PARAMETERS: "'protocol.file.allow'='always' 'clone.filterSubmodules'='true'" },
    ),
  );

  it("clone --recurse-submodules=<pathspec>: only the submodules it names", async () => {
    const home = fixture(`${T5614_SETUP}
mkdir ../other; (cd ../other; git init -q -b main; test_commit o1)
git submodule add -q "file://$pwd/other" other; git commit -qm "add other"`);
    await expectTwins(
      home,
      [
        "--recurse-submodules=other",
        "--recurse-submodules=other",
        "--recurse-submodules=:(exclude)sub",
      ],
      `file://${home}/super/.`,
      (c) => c.setRecurseSubmodules(["other", "other", ":(exclude)sub"]),
    );
  });

  it("JGit CloneCommandTest: testCloneRepositoryWithNestedSubmodules (local path)", async () => {
    const home = fixture(NESTED_SETUP);
    await expectTwins(home, ["--recurse-submodules"], `${home}/super`, (c) =>
      c.setRecurseSubmodules(true),
    );
  });

  it("clone --recurse-submodules without protocol.file.allow: the submodule clone is refused", async () => {
    const home = fixture(NESTED_SETUP);
    await expectTwins(
      home,
      ["--recurse-submodules"],
      `${home}/super`,
      (c) => c.setRecurseSubmodules(true),
      { GIT_CONFIG_PARAMETERS: "" },
    );
  });

  it("clone --also-filter-submodules needs --filter and --recurse-submodules", async () => {
    const home = fixture(T5614_SETUP);
    const url = `file://${home}/super/.`;
    for (const [args, configure] of [
      [
        ["--also-filter-submodules", "--recurse-submodules"],
        (c: Clone) => c.setAlsoFilterSubmodules(true).setRecurseSubmodules(true),
      ],
      [
        ["--also-filter-submodules", "--filter=blob:none"],
        (c: Clone) => c.setAlsoFilterSubmodules(true).setFilter("blob:none"),
      ],
    ] as const) {
      const r = spawnSync("git", ["clone", ...args, url, "native"], {
        cwd: home,
        env: { ...testEnv(home), ...ALLOW_FILE },
      });
      let message = "";
      try {
        await ourClone(home, join(home, "ours"), (c) => configure(c.setURI(url)));
      } catch (error) {
        message = (error as Error).message;
      }
      // git says it clones before it checks the options
      expect(`Cloning into 'native'...\n${message}\n`).toBe(r.stderr.toString("utf8"));
      rmSync(join(home, "ours"), { recursive: true, force: true });
    }
  });
});
