/**
 * `git var` against native git: the scenarios of git's t0007-git-var.sh (identities,
 * `GIT_DEFAULT_BRANCH` with and without `init.defaultBranch`, `GIT_EDITOR` and
 * `GIT_SEQUENCE_EDITOR` from the environment and the configuration, the attribute and
 * configuration files under `GIT_ATTR_NOSYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_SYSTEM`,
 * `GIT_CONFIG_GLOBAL`, `HOME` and `XDG_CONFIG_HOME`, `-l` with the configuration and a
 * multi-line editor, usage errors) plus `GIT_PAGER`. Each runs on native git and on ours
 * with the same variables. Run with the system git (2.43) and with 2.56.1 first on `PATH`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { git, type Outcome, outcomeOf, plumbingEnv } from "./plumbing-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root = "";
let repo = "";
/** The build's own system files (`$(prefix)/etc/...`), which our host environment is told. */
let buildSystemConfig = "";
let buildSystemAttributes = "";
/** The build's DEFAULT_EDITOR and DEFAULT_PAGER (Debian's git: `editor`, `pager`). */
let buildEditor = "";
let buildPager = "";

/** The test variables with `changes` applied (undefined removes one). */
function envWith(changes: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string | undefined> = { ...plumbingEnv(root), ...changes };
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

function nativeVar(args: string[], env: Record<string, string>): Outcome {
  const r = spawnSync("git", ["var", ...args], { cwd: repo, env, encoding: "latin1" });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

async function oursVar(args: string[], env: Record<string, string>): Promise<Outcome> {
  const environment = createNodeGitHostEnvironment({
    env,
    ...(env.GIT_CONFIG_SYSTEM === undefined ? { systemConfig: buildSystemConfig } : {}),
    systemAttributes: buildSystemAttributes,
    defaultEditor: buildEditor,
    defaultPager: buildPager,
  });
  const g = await openOurs(repo, environment);
  const cmd = g.var();
  for (const a of args) {
    if (a === "-l") cmd.setList(true);
    else cmd.setVariable(a);
  }
  return outcomeOf(await cmd.call());
}

async function twin(args: string[], changes: Record<string, string | undefined> = {}) {
  const env = envWith(changes);
  const n = nativeVar(args, env);
  expect(await oursVar(args, env), `${args.join(" ")} ${JSON.stringify(changes)}`).toEqual(n);
  return n;
}

/** sane_unset_all_editors */
const NO_EDITORS = {
  GIT_EDITOR: undefined,
  GIT_SEQUENCE_EDITOR: undefined,
  VISUAL: undefined,
  EDITOR: undefined,
  TERM: undefined,
};

describeGit("git var against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "git-var-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(root, repo, ["init", "-q", "-b", "main"]);
    const sys = (name: string) =>
      spawnSync("git", ["var", name], {
        cwd: repo,
        env: envWith({ GIT_CONFIG_NOSYSTEM: undefined, GIT_ATTR_NOSYSTEM: undefined }),
        encoding: "utf8",
      }).stdout.trim();
    buildSystemConfig = sys("GIT_CONFIG_SYSTEM");
    buildSystemAttributes = sys("GIT_ATTR_SYSTEM");
    const build = (name: string) =>
      spawnSync("git", ["var", name], {
        cwd: repo,
        env: envWith({ ...NO_EDITORS, TERM: "xterm", GIT_PAGER: undefined, PAGER: undefined }),
        encoding: "utf8",
      }).stdout.trim();
    buildEditor = build("GIT_EDITOR");
    buildPager = build("GIT_PAGER");
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  const withConfig = async (pairs: [string, string][], body: () => Promise<void>) => {
    for (const [k, v] of pairs) git(root, repo, ["config", k, v]);
    try {
      await body();
    } finally {
      for (const [k] of pairs) git(root, repo, ["config", "--unset-all", k]);
    }
  };

  it('t0007-git-var.sh: "get GIT_AUTHOR_IDENT", "get GIT_COMMITTER_IDENT"', async () => {
    expect((await twin(["GIT_AUTHOR_IDENT"])).out).toBe(
      "A U Thor <author@example.com> 1112911993 -0700\n",
    );
    await twin(["GIT_COMMITTER_IDENT"]);
    await twin(["GIT_COMMITTER_IDENT"], { GIT_COMMITTER_DATE: "2005-04-07T22:13:13+0200" });
    await withConfig(
      [
        ["user.name", "Conf Name"],
        ["user.email", "conf@example.com"],
      ],
      async () => {
        await twin(["GIT_AUTHOR_IDENT"], {
          GIT_AUTHOR_NAME: undefined,
          GIT_AUTHOR_EMAIL: undefined,
        });
      },
    );
  });

  it('t0007-git-var.sh: "get GIT_DEFAULT_BRANCH without configuration", "get GIT_DEFAULT_BRANCH with configuration"', async () => {
    await twin(["GIT_DEFAULT_BRANCH"]);
    await withConfig([["init.defaultbranch", "foo"]], async () => {
      await twin(["GIT_DEFAULT_BRANCH"]);
    });
    await withConfig([["init.defaultbranch", "a..b"]], async () => {
      await twin(["GIT_DEFAULT_BRANCH"]);
    });
  });

  it('t0007-git-var.sh: "get GIT_EDITOR without configuration", "get GIT_EDITOR with configuration", "get GIT_EDITOR with environment variable GIT_EDITOR", "get GIT_EDITOR with environment variable EDITOR", "get GIT_EDITOR with configuration and environment variable GIT_EDITOR", "get GIT_EDITOR with configuration and environment variable EDITOR"', async () => {
    expect((await twin(["GIT_EDITOR"], { ...NO_EDITORS })).status).toBe(1);
    await twin(["GIT_EDITOR"], { ...NO_EDITORS, TERM: "xterm" });
    await twin(["GIT_EDITOR"], { ...NO_EDITORS, TERM: "xterm", VISUAL: "visual" });
    await twin(["GIT_EDITOR"], { ...NO_EDITORS, TERM: "dumb", VISUAL: "visual" });
    await twin(["GIT_EDITOR"], { ...NO_EDITORS, GIT_EDITOR: "foo" });
    await twin(["GIT_EDITOR"], { ...NO_EDITORS, EDITOR: "foo" });
    await withConfig([["core.editor", "foo"]], async () => {
      await twin(["GIT_EDITOR"], { ...NO_EDITORS });
      await twin(["GIT_EDITOR"], { ...NO_EDITORS, GIT_EDITOR: "bar" });
      await twin(["GIT_EDITOR"], { ...NO_EDITORS, EDITOR: "bar" });
    });
  });

  it('t0007-git-var.sh: "get GIT_SEQUENCE_EDITOR without configuration", "get GIT_SEQUENCE_EDITOR with configuration", "get GIT_SEQUENCE_EDITOR with environment variable", "get GIT_SEQUENCE_EDITOR with configuration and environment variable"', async () => {
    await twin(["GIT_SEQUENCE_EDITOR"], { ...NO_EDITORS });
    await twin(["GIT_SEQUENCE_EDITOR"], { ...NO_EDITORS, EDITOR: "ed" });
    await twin(["GIT_SEQUENCE_EDITOR"], { ...NO_EDITORS, GIT_SEQUENCE_EDITOR: "foo" });
    await withConfig([["sequence.editor", "foo"]], async () => {
      await twin(["GIT_SEQUENCE_EDITOR"], { ...NO_EDITORS });
      await twin(["GIT_SEQUENCE_EDITOR"], { ...NO_EDITORS, GIT_SEQUENCE_EDITOR: "bar" });
    });
  });

  it("GIT_PAGER: GIT_PAGER, core.pager, PAGER, less, cat", async () => {
    await twin(["GIT_PAGER"], { GIT_PAGER: undefined, PAGER: undefined });
    await twin(["GIT_PAGER"], { GIT_PAGER: "more", PAGER: "most" });
    await twin(["GIT_PAGER"], { GIT_PAGER: undefined, PAGER: "most" });
    await twin(["GIT_PAGER"], { GIT_PAGER: "", PAGER: "most" });
    await withConfig([["core.pager", "cat"]], async () => {
      await twin(["GIT_PAGER"], { GIT_PAGER: undefined, PAGER: "most" });
    });
  });

  it('t0007-git-var.sh: "GIT_SHELL_PATH points to a valid executable", "GIT_ATTR_SYSTEM produces expected output", "GIT_ATTR_GLOBAL points to the correct location"', async () => {
    await twin(["GIT_SHELL_PATH"]);
    expect((await twin(["GIT_ATTR_SYSTEM"], { GIT_ATTR_NOSYSTEM: "1" })).status).toBe(1);
    await twin(["GIT_ATTR_SYSTEM"], { GIT_ATTR_NOSYSTEM: undefined });
    await twin(["GIT_ATTR_GLOBAL"], { XDG_CONFIG_HOME: `${root}/.config` });
    await twin(["GIT_ATTR_GLOBAL"], { XDG_CONFIG_HOME: undefined, HOME: root });
    await twin(["GIT_ATTR_GLOBAL"], { XDG_CONFIG_HOME: `${root}//x/../.config/` });
    await withConfig([["core.attributesFile", "~/attrs"]], async () => {
      await twin(["GIT_ATTR_GLOBAL"]);
    });
  });

  it('t0007-git-var.sh: "GIT_CONFIG_SYSTEM points to the correct location", "GIT_CONFIG_GLOBAL points to the correct location"', async () => {
    expect((await twin(["GIT_CONFIG_SYSTEM"], { GIT_CONFIG_NOSYSTEM: "1" })).status).toBe(1);
    await twin(["GIT_CONFIG_SYSTEM"], { GIT_CONFIG_NOSYSTEM: undefined });
    await twin(["GIT_CONFIG_SYSTEM"], {
      GIT_CONFIG_NOSYSTEM: undefined,
      GIT_CONFIG_SYSTEM: "/dev/null",
    });
    await twin(["GIT_CONFIG_SYSTEM"], {
      GIT_CONFIG_NOSYSTEM: undefined,
      GIT_CONFIG_SYSTEM: `${root}/gitconfig`,
    });
    await twin(["GIT_CONFIG_GLOBAL"], {
      GIT_CONFIG_GLOBAL: undefined,
      HOME: root,
      XDG_CONFIG_HOME: `${root}/foo`,
    });
    await twin(["GIT_CONFIG_GLOBAL"], { GIT_CONFIG_GLOBAL: undefined, HOME: root });
    await twin(["GIT_CONFIG_GLOBAL"], { GIT_CONFIG_GLOBAL: "/dev/null" });
    await twin(["GIT_CONFIG_GLOBAL"], { GIT_CONFIG_GLOBAL: `${root}/gitconfig` });
  });

  it('t0007-git-var.sh: "git var -l lists variables", "git var -l lists config", "git var -l lists multiple global configs", "git var -l does not split multiline editors"', async () => {
    await withConfig(
      [
        ["core.editor", "vim"],
        ["foo.Bar.baz", "x\ny"],
      ],
      async () => {
        await twin(["-l"], { ...NO_EDITORS });
        await twin(["-l"], {
          GIT_CONFIG_GLOBAL: undefined,
          HOME: root,
          XDG_CONFIG_HOME: `${root}/foo`,
          ...NO_EDITORS,
          GIT_EDITOR: "!f() {\n\techo Hello!\n}; f",
        });
      },
    );
  });

  it('t0007-git-var.sh: "listing and asking for variables are exclusive"', async () => {
    expect((await twin(["-l", "GIT_COMMITTER_IDENT"])).status).toBe(129);
    expect((await twin(["GIT_NO_SUCH_VARIABLE"])).status).toBe(129);
    expect((await twin([])).status).toBe(129);
  });
});
