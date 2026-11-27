/**
 * `git clone`'s repository layout against native git (t5601-clone): a bare clone, a clone
 * with `--separate-git-dir` (the gitfile as git writes it), and one with `--template`. Ours
 * is `InitCommand` (bare, separate git directory, templates) then `CloneCommand` into the
 * working copy it made, as `git clone` runs init_db first. Both are listed: every path with
 * its kind and mode (pack names and the index's bytes left out), the config, HEAD, gitfile and
 * packed-refs as text. git writes packs and their indexes read-only (0444); ours, outside a
 * shared repository, under the umask (0644), so those are compared by their read bits.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InitCommand } from "../src/commands/init-command.js";
import { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const savedUmask = process.umask();

function native(cwd: string, args: string[], extra: Record<string, string> = {}, umask = "022") {
  const r = spawnSync("sh", ["-c", `umask ${umask} && exec git "$@"`, "git", ...args], {
    cwd,
    env: testEnv(root, extra),
  });
  return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

let extraEnv: Record<string, string> = {};
const environment = () => createNodeGitHostEnvironment({ env: testEnv(root, extraEnv) });

/** Text files compared whole; the others by kind and mode only. */
const TEXT = /(^|\/)(config|HEAD|packed-refs|description|file|\.git)$|refs\/heads\/[^/]+$/;

function layout(dir: string, rename: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const fix = (text: string) =>
    Object.entries(rename).reduce((t, [from, to]) => t.replaceAll(from, to), text);
  const walk = (rel: string) => {
    const at = join(root, dir, rel);
    const st = lstatSync(at);
    const key = rel.replace(/pack-[0-9a-f]{40}/g, "pack-X");
    // a pack, its index and reverse index: git's 0444, ours the umask's (read bits compared)
    const packFile = /objects\/pack\/pack-[0-9a-f]{40}\.(pack|idx|rev)$/.test(rel);
    const mode = (st.mode & (packFile ? 0o444 : 0o7777)).toString(8);
    if (st.isDirectory()) {
      out[key || "."] = `dir ${mode}`;
      for (const name of readdirSync(at)) walk(rel ? `${rel}/${name}` : name);
    } else if (TEXT.test(rel)) out[key] = `file ${mode} ${fix(readFileSync(at, "utf8"))}`;
    else out[key] = `file ${mode}`;
  };
  walk("");
  return out;
}

/** Our clone of `src` into a repository `init` made, opened as `open` says. */
async function oursClone(
  init: (c: InitCommand) => InitCommand,
  open: () => Promise<Git>,
  clone: (git: Git) => ReturnType<Git["clone"]>,
  umask = 0o022,
): Promise<void> {
  process.umask(umask);
  try {
    await init(
      new InitCommand()
        .setFilesApi(createNodeFilesApi({ rootDir: root }))
        .setEnvironment(environment())
        .setInitialBranch("main"),
    ).call();
    await clone(await open())
      .setURI(join(root, "src"))
      .setLocal(false)
      .call();
  } finally {
    process.umask(savedUmask);
  }
}

async function openBare(gitDir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: root });
  const { history } = await createGitFilesBackend({ files, gitDir, environment: environment() });
  const worktrees = await openGitLinkedWorktrees({
    files,
    gitDir,
    history,
    environment: environment(),
  });
  return Git.fromWorktreeAdmin(await worktrees.openAdmin());
}

describeGit("git clone's layout, as native git (t5601-clone)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clone-layout-"));
    const src = join(root, "src");
    mkdirSync(src);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: src, env: testEnv(root), stdio: "pipe" });
    git("init", "-q", "-b", "main", "--template=");
    for (const name of ["one", "two"]) {
      writeFileSync(join(src, `${name}.txt`), `${name}\n`);
      git("add", `${name}.txt`);
      git("commit", "-qm", name);
    }
    git("tag", "-a", "v1", "-m", "v1");
    mkdirSync(join(root, "templates/hooks"), { recursive: true });
    writeFileSync(join(root, "templates/description"), "Unnamed repository\n");
    writeFileSync(join(root, "templates/hooks/pre-commit.sample"), "#!/bin/sh\n");
    chmodSync(join(root, "templates/hooks/pre-commit.sample"), 0o755);
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it('t5601-clone.sh: "clone creates intermediate directories for bare repo"', async () => {
    const n = "long/path/to/bare/native";
    const o = "long/path/to/bare/ours";
    expect(
      native(root, ["clone", "-q", "--no-local", "--template=", "--bare", "src", n]).status,
    ).toBe(0);
    await oursClone(
      (c) => c.setDirectory(o).setBare(true).setTemplate(""),
      () => openBare(o),
      (git) => git.clone().setBare(true),
    );
    expect(layout(o)).toEqual(layout(n));
    expect(readFileSync(join(root, o, "config"), "utf8")).toContain("\tbare = true\n");
  });

  it('t5601-clone.sh: "clone separate gitdir", "clone separate gitdir: output"', async () => {
    const args = ["clone", "-q", "--no-local", "--template=", "--separate-git-dir"];
    expect(native(root, [...args, "realgitdir-native", "src", "dst-native"]).status).toBe(0);
    await oursClone(
      (c) => c.setDirectory("dst-ours").setSeparateGitDir("realgitdir-ours").setTemplate(""),
      () => openOurs(root, environment(), undefined, "dst-ours", false, "realgitdir-ours"),
      (git) => git.clone().setDirectory("dst-ours"),
    );
    expect(readFileSync(join(root, "dst-ours/.git"), "utf8")).toBe(
      `gitdir: ${join(root, "realgitdir-ours")}\n`,
    );
    const rename = (side: string) => ({ [`realgitdir-${side}`]: "G", [`dst-${side}`]: "W" });
    expect(layout("dst-ours", rename("ours"))).toEqual(layout("dst-native", rename("native")));
    expect(layout("realgitdir-ours", rename("ours"))).toEqual(
      layout("realgitdir-native", rename("native")),
    );
  });

  it("clone --template copies the templates", async () => {
    const args = ["clone", "-q", "--no-local", "--template=templates", "src"];
    expect(native(root, [...args, "tpl-native"]).status).toBe(0);
    await oursClone(
      (c) => c.setDirectory("tpl-ours").setTemplate("templates"),
      () => openOurs(root, environment(), undefined, "tpl-ours"),
      (git) => git.clone().setDirectory("tpl-ours"),
    );
    const rename = (side: string) => ({ [`tpl-${side}`]: "W" });
    expect(layout("tpl-ours", rename("ours"))).toEqual(layout("tpl-native", rename("native")));
  });

  it("a clone under `git -c core.sharedRepository=0660` gets the shared modes", async () => {
    // the command line's setting reaches init_db, which records it, and the fetch after it
    const extra = {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "core.sharedRepository",
      GIT_CONFIG_VALUE_2: "0660",
    };
    const args = ["clone", "-q", "--no-local", "--template=templates", "src", "shared-native"];
    expect(native(root, args, extra, "002").status).toBe(0);
    extraEnv = extra;
    try {
      await oursClone(
        (c) => c.setDirectory("shared-ours").setTemplate("templates"),
        () => openOurs(root, environment(), undefined, "shared-ours"),
        (git) => git.clone().setDirectory("shared-ours"),
        0o002,
      );
    } finally {
      extraEnv = {};
    }
    const rename = (side: string) => ({ [`shared-${side}`]: "W" });
    const ours = layout("shared-ours", rename("ours"));
    expect(ours).toEqual(layout("shared-native", rename("native")));
    expect(ours[".git"]).toBe("dir 2770");
    expect(ours[".git/index"]).toMatch(/^file 660/);
    expect(ours[".git/packed-refs"]).toMatch(/^file 660/);
    expect(lstatSync(join(root, "shared-ours/.git/objects/pack")).mode & 0o7777).toBe(0o2770);
    // in a shared repository ours makes packs read-only too, as git
    const packModes = (dir: string) =>
      readdirSync(join(root, dir, ".git/objects/pack"))
        .map(
          (name) =>
            `${name.slice(-4)} ${(lstatSync(join(root, dir, ".git/objects/pack", name)).mode & 0o7777).toString(8)}`,
        )
        .sort();
    expect(packModes("shared-ours")).toEqual(packModes("shared-native"));
  });
});
