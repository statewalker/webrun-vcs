/**
 * `git init`'s repository layout against native git (t0001-init): bare and non-bare
 * repositories, `--separate-git-dir` and its gitfile (re-init moving the git directory),
 * `--template` / `$GIT_TEMPLATE_DIR` / `init.templateDir`, and `--shared` with the modes
 * git gives what it creates. Each twin is made by native git and by ours in sibling
 * directories, then both are listed: every path with its kind and permission bits, and the
 * config, HEAD and gitfiles as text.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { InitCommand, InitOptionsError } from "../src/commands/init-command.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const savedUmask = process.umask();

/** Native git in `cwd` under `umask`, with the test environment plus `extra`. */
function native(cwd: string, args: string[], extra: Record<string, string> = {}, umask = 0o022) {
  const r = spawnSync("sh", ["-c", `umask ${umask.toString(8)} && exec git "$@"`, "git", ...args], {
    cwd,
    env: testEnv(root, extra),
  });
  return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/** Ours, under `umask` (the FilesApi creates files as the process's umask says). */
async function ours(
  configure: (init: InitCommand) => InitCommand,
  extra: Record<string, string> = {},
  umask = 0o022,
) {
  process.umask(umask);
  try {
    const environment = createNodeGitHostEnvironment({ env: testEnv(root, extra) });
    const init = new InitCommand()
      .setFilesApi(createNodeFilesApi({ rootDir: root }))
      .setEnvironment(environment)
      .setInitialBranch("main");
    return await configure(init).call();
  } finally {
    process.umask(savedUmask);
  }
}

/** Every entry below `dir` (a path of the test root): kind, permission bits, text of the small files. */
function layout(dir: string, rename: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const fix = (text: string) =>
    Object.entries(rename).reduce((t, [from, to]) => t.replaceAll(from, to), text);
  const walk = (rel: string) => {
    const at = join(root, dir, rel);
    const st = lstatSync(at);
    const mode = (st.mode & 0o7777).toString(8);
    const key = fix(rel) || ".";
    if (st.isSymbolicLink()) out[key] = `link ${mode}`;
    else if (st.isDirectory()) {
      out[key] = `dir ${mode}`;
      for (const name of readdirSync(at).sort()) walk(rel ? `${rel}/${name}` : name);
    } else {
      const text = st.size < 4096 ? fix(readFileSync(at, "utf8")) : `<${st.size} bytes>`;
      out[key] = `file ${mode} ${text}`;
    }
  };
  walk("");
  return out;
}

/** Two fresh names for a twin. */
function twinNames(name: string): [string, string] {
  const n = counter++;
  return [`${name}-n${n}`, `${name}-o${n}`];
}

describeGit("git init's layout, as native git (t0001-init)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "init-layout-"));
    // a world-writable root: setpriv runs reach it
    chmodSync(root, 0o777);
    mkdirSync(join(root, "template-source/hooks"), { recursive: true });
    writeFileSync(join(root, "template-source/file"), "content\n");
    writeFileSync(join(root, "template-source/description"), "Unnamed repository\n");
    writeFileSync(join(root, "template-source/hooks/post-update"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(root, "template-source/hooks/post-update"), 0o755);
    writeFileSync(join(root, "template-source/.hidden"), "skipped\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => process.umask(savedUmask));

  it('t0001-init.sh: "init --bare"', async () => {
    const [n, o] = twinNames("bare.git");
    expect(native(root, ["init", "-q", "--template=", "-b", "main", "--bare", n]).status).toBe(0);
    const result = await ours((c) => c.setDirectory(o).setBare(true).setTemplate(""));
    expect(result.bare).toBe(true);
    expect(layout(o)).toEqual(layout(n));
    expect(layout(o).config).toContain("bare = true");
  });

  it('t0001-init.sh: "plain"', async () => {
    const [n, o] = twinNames("plain");
    expect(native(root, ["init", "-q", "--template=", "-b", "main", n]).status).toBe(0);
    await ours((c) => c.setDirectory(o).setTemplate(""));
    expect(layout(o)).toEqual(layout(n));
  });

  it('t0001-init.sh: "init with --template"', async () => {
    const [n, o] = twinNames("template-custom");
    expect(native(root, ["init", "-q", "--template=template-source", "-b", "main", n]).status).toBe(
      0,
    );
    await ours((c) => c.setDirectory(o).setTemplate("template-source"));
    expect(layout(o)).toEqual(layout(n));
    expect(layout(o)[".git/file"]).toBe("file 644 content\n");
    expect(layout(o)[".git/hooks/post-update"]).toMatch(/^file 755 /);
    expect(layout(o)[".git/.hidden"]).toBeUndefined();
  });

  it('t0001-init.sh: "init with --template (blank)"', async () => {
    const [n, o] = twinNames("template-blank");
    expect(native(root, ["init", "-q", "--template=", "-b", "main", n]).status).toBe(0);
    await ours((c) => c.setDirectory(o).setTemplate(""));
    expect(existsSync(join(root, o, ".git/info/exclude"))).toBe(false);
    expect(layout(o)).toEqual(layout(n));
  });

  it("$GIT_TEMPLATE_DIR names the templates", async () => {
    const [n, o] = twinNames("template-env");
    const extra = { GIT_TEMPLATE_DIR: join(root, "template-source") };
    expect(native(root, ["init", "-q", "-b", "main", n], extra).status).toBe(0);
    await ours((c) => c.setDirectory(o), extra);
    expect(layout(o)).toEqual(layout(n));
  });

  for (const [title, value] of [
    ["init with init.templatedir set", () => join(root, "template-source")],
    ["init with init.templatedir using ~ expansion", () => "~/template-source"],
  ] as const) {
    it(`t0001-init.sh: "${title}"`, async () => {
      const [n, o] = twinNames("templatedir");
      const global = join(root, `global-${n}`);
      writeFileSync(global, `[init]\n\ttemplatedir = ${value()}\n`);
      const extra = { GIT_CONFIG_GLOBAL: global };
      expect(native(root, ["init", "-q", "-b", "main", n], extra).status).toBe(0);
      await ours((c) => c.setDirectory(o), extra);
      expect(layout(o)[".git/file"]).toBe("file 644 content\n");
      expect(layout(o)).toEqual(layout(n));
    });
  }

  it("a template of a repository version git does not know is not copied", async () => {
    const [n, o] = twinNames("template-vintage");
    mkdirSync(join(root, "template-future"));
    writeFileSync(join(root, "template-future/config"), "[core]\n\trepositoryformatversion = 2\n");
    writeFileSync(join(root, "template-future/file"), "x\n");
    const theirs = native(root, ["init", "-q", "--template=template-future", "-b", "main", n]);
    const result = await ours((c) => c.setDirectory(o).setTemplate("template-future"));
    expect(result.warnings).toEqual([theirs.stderr.trimEnd()]);
    expect(layout(o)).toEqual(layout(n));
  });

  it('t0001-init.sh: "init --bare/--shared overrides system/global config"', async () => {
    const [n, o] = twinNames("init-bare-shared-override");
    const global = join(root, `global-${n}`);
    writeFileSync(global, "[core]\n\tbare = false\n\tsharedRepository = 0640\n");
    const extra = { GIT_CONFIG_GLOBAL: global };
    const args = ["init", "-q", "--template=", "-b", "main", "--bare", "--shared=0666", n];
    expect(native(root, args, extra).status).toBe(0);
    await ours((c) => c.setDirectory(o).setBare(true).setShared("0666").setTemplate(""), extra);
    expect(layout(o)).toEqual(layout(n));
    expect(layout(o).config).toContain("sharedrepository = 0666");
  });

  it('t0001-init.sh: "init honors global core.sharedRepository"', async () => {
    const [n, o] = twinNames("shared-honor-global");
    const global = join(root, `global-${n}`);
    writeFileSync(global, "[core]\n\tsharedRepository = 0666\n");
    const extra = { GIT_CONFIG_GLOBAL: global };
    expect(native(root, ["init", "-q", "--template=", "-b", "main", n], extra).status).toBe(0);
    await ours((c) => c.setDirectory(o).setTemplate(""), extra);
    expect(layout(o)).toEqual(layout(n));
    expect(layout(o)[".git/HEAD"]).toMatch(/^file 666 /);
  });

  it('t0001-init.sh: "init creates a new deep directory (umask vs. shared)"', async () => {
    const [n, o] = twinNames("newdir");
    for (const d of [n, o]) mkdirSync(join(root, d));
    const args = [
      "init",
      "-q",
      "--template=",
      "-b",
      "main",
      "--bare",
      "--shared=0660",
      `${n}/a/b/c`,
    ];
    expect(native(root, args, {}, 0o002).status).toBe(0);
    await ours(
      (c) => c.setDirectory(`${o}/a/b/c`).setBare(true).setShared("0660").setTemplate(""),
      {},
      0o002,
    );
    expect(layout(o)).toEqual(layout(n));
    // leading directories honour the umask, the repository follows "shared"
    expect(layout(o).a).toBe("dir 775");
    expect(layout(o)["a/b/c"]).toBe("dir 2770");
  });

  it('t0001-init.sh: "init with separate gitdir"', async () => {
    const [n, o] = twinNames("newdir");
    const args = ["init", "-q", "--template=", "-b", "main", "--separate-git-dir", `${n}-real`, n];
    expect(native(root, args).status).toBe(0);
    const result = await ours((c) =>
      c.setDirectory(o).setSeparateGitDir(`${o}-real`).setTemplate(""),
    );
    expect(result.gitDir).toBe(`${o}-real`);
    expect(readFileSync(join(root, o, ".git"), "utf8")).toBe(
      `gitdir: ${join(root, `${o}-real`)}\n`,
    );
    expect(layout(o, { [o]: "X" })).toEqual(layout(n, { [n]: "X" }));
    expect(layout(`${o}-real`)).toEqual(layout(`${n}-real`));
  });

  it('t0001-init.sh: "explicit bare & --separate-git-dir incompatible"', async () => {
    const theirs = native(root, ["init", "--bare", "--separate-git-dir", "goop.git", "bare.git"]);
    expect(theirs.status).toBe(128);
    const error = await ours((c) =>
      c.setDirectory("bare-ours.git").setBare(true).setSeparateGitDir("goop-ours.git"),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(InitOptionsError);
    expect(error.lines).toEqual([theirs.stderr.trimEnd()]);
    expect(existsSync(join(root, "bare-ours.git"))).toBe(false);
  });

  it('t0001-init.sh: "re-init on .git file", "re-init to update git link"', async () => {
    const [n, o] = twinNames("relink");
    const init = ["init", "-q", "--template=", "-b", "main"];
    expect(native(root, [...init, "--separate-git-dir", `${n}-real`, n]).status).toBe(0);
    await ours((c) => c.setDirectory(o).setSeparateGitDir(`${o}-real`).setTemplate(""));
    // re-init on the gitfile: the repository it names
    expect(native(join(root, n), [...init.slice(0, 3)]).status).toBe(0);
    const again = await ours((c) => c.setDirectory(o).setTemplate(""));
    expect(again.reinitialized).toBe(true);
    expect(again.gitDir).toBe(`${o}-real`);
    // re-init to update the link: the repository moved
    expect(
      native(join(root, n), [...init.slice(0, 3), "--separate-git-dir", `../${n}-sur`]).status,
    ).toBe(0);
    await ours((c) => c.setDirectory(o).setSeparateGitDir(`${o}-sur`).setTemplate(""));
    expect(existsSync(join(root, `${o}-real`))).toBe(false);
    expect(readFileSync(join(root, o, ".git"), "utf8")).toBe(`gitdir: ${join(root, `${o}-sur`)}\n`);
    expect(layout(o, { [o]: "X" })).toEqual(layout(n, { [n]: "X" }));
    expect(layout(`${o}-sur`)).toEqual(layout(`${n}-sur`));
  });

  it('t0001-init.sh: "re-init to move gitdir"', async () => {
    const [n, o] = twinNames("move");
    const init = ["init", "-q", "--template=", "-b", "main"];
    expect(native(root, [...init, n]).status).toBe(0);
    await ours((c) => c.setDirectory(o).setTemplate(""));
    expect(
      native(join(root, n), [...init.slice(0, 3), "--separate-git-dir", `../${n}-real`]).status,
    ).toBe(0);
    const moved = await ours((c) =>
      c.setDirectory(o).setSeparateGitDir(`${o}-real`).setTemplate(""),
    );
    expect(moved.reinitialized).toBe(true);
    expect(layout(o, { [o]: "X" })).toEqual(layout(n, { [n]: "X" }));
    expect(layout(`${o}-real`)).toEqual(layout(`${n}-real`));
  });

  /** t0001's sep_git_dir_worktree: a main worktree and a linked one, links as `mode` says. */
  function linkedWorktreePair(name: string, mode: "absolute" | "relative") {
    expect(native(root, ["init", "-q", "--template=", "-b", "main", name]).status).toBe(0);
    native(join(root, name), ["config", "worktree.useRelativePaths", String(mode === "relative")]);
    native(join(root, name), ["commit", "-q", "--allow-empty", "-m", "gumby"]);
    const add = native(join(root, name), ["worktree", "add", "-q", "--detach", `../${name}-link`]);
    expect(add.status, add.stderr).toBe(0);
  }

  /** What the twins are compared by once the git directory moved. */
  function movedState(name: string) {
    const rename = { [name]: "X" };
    const fix = (t: string) => t.replaceAll(join(root, name), "R/X").replaceAll(name, "X");
    const at = (p: string) => join(root, p);
    return {
      main: layout(name, rename),
      sep: layout(`${name}-sep`, rename),
      link: fix(readFileSync(at(`${name}-link/.git`), "utf8")),
      common: fix(native(at(`${name}-link`), ["rev-parse", "--git-common-dir"]).stdout),
      linkCommon: fix(native(at(name), ["rev-parse", "--git-common-dir"]).stdout),
      list: fix(native(at(name), ["worktree", "list", "--porcelain"]).stdout),
      status: native(at(`${name}-link`), ["status", "--porcelain"]).status,
    };
  }

  for (const from of ["mainwt", "linkwt"] as const) {
    for (const mode of ["absolute", "relative"] as const) {
      const title =
        from === "mainwt"
          ? `re-init to move gitdir with linked worktrees (${mode})`
          : `re-init to move gitdir within linked worktree (${mode})`;
      it(`t0001-init.sh: "${title}"`, async () => {
        const [n, o] = twinNames(from);
        for (const name of [n, o]) linkedWorktreePair(name, mode);
        const at = (name: string) => (from === "mainwt" ? name : `${name}-link`);
        const theirs = native(join(root, at(n)), [
          "init",
          "-q",
          "--template=",
          "--separate-git-dir",
          `../${n}-sep`,
        ]);
        expect(theirs.status, theirs.stderr).toBe(0);
        const result = await ours((c) =>
          c.setDirectory(at(o)).setSeparateGitDir(`${o}-sep`).setTemplate(""),
        );
        expect((result.warnings ?? []).filter((w) => w.startsWith("error"))).toEqual([]);
        expect(result.gitDir).toBe(`${o}-sep`);
        const mine = movedState(o);
        expect(mine).toEqual(movedState(n));
        expect(mine.status).toBe(0);
      });
    }
  }

  it('t0001-init.sh: "bare & --separate-git-dir incompatible within worktree"', async () => {
    const [n, o] = twinNames("bare");
    for (const name of [n, o]) {
      expect(native(root, ["init", "-q", "--template=", "-b", "main", name]).status).toBe(0);
      native(join(root, name), ["commit", "-q", "--allow-empty", "-m", "gumby"]);
      expect(native(root, ["clone", "-q", "--bare", name, `${name}.git`]).status).toBe(0);
      const add = native(join(root, `${name}.git`), [
        "worktree",
        "add",
        "--detach",
        `../${name}-wt`,
      ]);
      expect(add.status, add.stderr).toBe(0);
    }
    const theirs = native(join(root, `${n}-wt`), ["init", "--separate-git-dir", "seprepo"]);
    expect(theirs.status).toBe(128);
    const error = await ours((c) =>
      c.setDirectory(`${o}-wt`).setSeparateGitDir(`${o}-wt/seprepo`).setTemplate(""),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(InitOptionsError);
    expect(error.lines).toEqual([theirs.stderr.trimEnd()]);
    expect(layout(`${o}.git`, { [o]: "X" })).toEqual(layout(`${n}.git`, { [n]: "X" }));
    expect(layout(`${o}-wt`, { [o]: "X" })).toEqual(layout(`${n}-wt`, { [n]: "X" }));
  });

  it('t0001-init.sh: "re-init from a linked worktree"', async () => {
    const [n, o] = twinNames("main-worktree");
    for (const name of [n, o]) {
      linkedWorktreePair(name, "absolute");
      native(join(root, name), ["config", "--unset", "worktree.useRelativePaths"]);
    }
    expect(
      native(join(root, `${n}-link`), ["init", "-q", `--template=${join(root, "template-source")}`])
        .status,
    ).toBe(0);
    const result = await ours((c) => c.setDirectory(`${o}-link`).setTemplate("template-source"));
    expect(result.reinitialized).toBe(true);
    expect(layout(o, { [o]: "X" })).toEqual(layout(n, { [n]: "X" }));
    // the templates and the config went to the common directory, nothing to the worktree's
    expect(layout(o)[".git/file"]).toBe("file 644 content\n");
    expect(layout(`${o}-link`, { [o]: "X" })).toEqual(layout(`${n}-link`, { [n]: "X" }));
  });

  it("a linked worktree outside the FilesApi is repaired through the host's files", async () => {
    // our FilesApi is rooted at `<name>-box`, the linked worktree lies beside it
    const [n, o] = twinNames("outside");
    for (const name of [n, o]) {
      mkdirSync(join(root, `${name}-box`));
      expect(
        native(join(root, `${name}-box`), ["init", "-q", "--template=", "-b", "main", "main"])
          .status,
      ).toBe(0);
      native(join(root, `${name}-box/main`), ["config", "worktree.useRelativePaths", "false"]);
      native(join(root, `${name}-box/main`), ["commit", "-q", "--allow-empty", "-m", "c"]);
      const add = native(join(root, `${name}-box/main`), [
        "worktree",
        "add",
        "-q",
        "--detach",
        `../../${name}-wt`,
      ]);
      expect(add.status, add.stderr).toBe(0);
    }
    expect(
      native(join(root, `${n}-box/main`), [
        "init",
        "-q",
        "--template=",
        "--separate-git-dir",
        "../sep",
      ]).status,
    ).toBe(0);
    const environment = createNodeGitHostEnvironment({ env: testEnv(root) });
    const files = createNodeFilesApi({ rootDir: join(root, `${o}-box`) });
    const result = await new InitCommand()
      .setFilesApi(files)
      .setEnvironment(environment)
      .setDirectory("main")
      .setSeparateGitDir("sep")
      .setTemplate("")
      .call();
    expect((result.warnings ?? []).filter((w) => w.startsWith("error"))).toEqual([]);
    const linkOf = (name: string) =>
      readFileSync(join(root, `${name}-wt/.git`), "utf8").replaceAll(name, "X");
    expect(linkOf(o)).toBe(linkOf(n));
    expect(native(join(root, `${o}-wt`), ["status", "--porcelain"]).status).toBe(0);

    // without the host's files the worktree is reported, the repository still moved
    const [n2, o2] = twinNames("unreachable");
    mkdirSync(join(root, `${o2}-box`));
    expect(
      native(join(root, `${o2}-box`), ["init", "-q", "--template=", "-b", "main", "main"]).status,
    ).toBe(0);
    native(join(root, `${o2}-box/main`), ["config", "worktree.useRelativePaths", "false"]);
    native(join(root, `${o2}-box/main`), ["commit", "-q", "--allow-empty", "-m", "c"]);
    native(join(root, `${o2}-box/main`), ["worktree", "add", "-q", "--detach", `../../${o2}-wt`]);
    const blind = { ...environment, hostFilesOf: undefined };
    const reported = await new InitCommand()
      .setFilesApi(createNodeFilesApi({ rootDir: join(root, `${o2}-box`) }))
      .setEnvironment(blind)
      .setDirectory("main")
      .setSeparateGitDir("sep")
      .setTemplate("")
      .call();
    expect(n2).toBeDefined();
    expect(reported.warnings).toEqual([
      `error: could not repair worktree link, not reachable here: ${join(root, `${o2}-wt`)}/.git`,
    ]);
    expect(native(join(root, `${o2}-box/main`), ["status", "--porcelain"]).status).toBe(0);
  });

  it("re-init through a gitfile naming a repository outside the FilesApi is refused", async () => {
    const [, o] = twinNames("stray");
    mkdirSync(join(root, `${o}-box/wt`), { recursive: true });
    expect(native(root, ["init", "-q", "--template=", `${o}-repo`]).status).toBe(0);
    writeFileSync(join(root, `${o}-box/wt/.git`), `gitdir: ${join(root, `${o}-repo/.git`)}\n`);
    const error = await new InitCommand()
      .setFilesApi(createNodeFilesApi({ rootDir: join(root, `${o}-box`) }))
      .setDirectory("wt")
      .setTemplate("")
      .call()
      .catch((e) => e);
    expect(error).toBeInstanceOf(InitOptionsError);
    expect(readdirSync(join(root, `${o}-box/wt`))).toEqual([".git"]);
  });

  it("re-init copies only the templates that are missing, and keeps the config's mode", async () => {
    const [n, o] = twinNames("reinit");
    const init = ["init", "-q", "-b", "main"];
    expect(native(root, [...init, "--template=", n]).status).toBe(0);
    await ours((c) => c.setDirectory(o).setTemplate(""));
    for (const d of [n, o]) writeFileSync(join(root, d, ".git/file"), "mine\n");
    expect(native(root, [...init, "--template=template-source", "--shared", n]).status).toBe(0);
    const again = await ours((c) => c.setDirectory(o).setTemplate("template-source").setShared());
    expect(again.reinitialized).toBe(true);
    expect(again.shared).toBe(0o660);
    expect(layout(o)).toEqual(layout(n));
    expect(layout(o)[".git/file"]).toBe("file 644 mine\n");
  });
});
