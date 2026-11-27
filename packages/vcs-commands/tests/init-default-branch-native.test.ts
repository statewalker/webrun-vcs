/**
 * `init.defaultBranch` and `advice.defaultBranchName` as `git init` and `git clone` read them
 * (statewalker/webrun-vcs#224): git asks `repo_config_get_string` once the new repository
 * exists (after its templates are copied), so `includeIf "gitdir:..."` conditions match the
 * new repository's git directory and a template's `config` counts. Each twin is made by native
 * git and by ours in sibling directories under the same global config (a temporary file,
 * never `/dev/null`), and their HEADs and hints compared.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InitCommand } from "../src/commands/init-command.js";
import { Git } from "../src/git.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;

function native(args: string[], extra: Record<string, string>) {
  const r = spawnSync("git", args, { cwd: root, env: testEnv(root, extra) });
  return { status: r.status, stderr: r.stderr.toString() };
}

async function ours(configure: (init: InitCommand) => InitCommand, extra: Record<string, string>) {
  const environment = createNodeGitHostEnvironment({ env: testEnv(root, extra) });
  const init = new InitCommand()
    .setFilesApi(createNodeFilesApi({ rootDir: root }))
    .setEnvironment(environment);
  return configure(init).call();
}

const head = (gitDir: string) => readFileSync(join(root, gitDir, "HEAD"), "utf8");

/** A global config file whose `includeIf "<condition>"` brings in `included`. */
function globalWith(condition: string, included: string): Record<string, string> {
  const n = counter++;
  const inc = join(root, `inc-${n}`);
  writeFileSync(inc, included);
  const global = join(root, `global-${n}`);
  writeFileSync(global, `[includeIf "${condition}"]\n\tpath = ${inc}\n`);
  return { GIT_CONFIG_GLOBAL: global };
}

const TRUNK = "[init]\n\tdefaultBranch = trunk\n";

describeGit("init.defaultBranch as the new repository sees it (#224)", () => {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "init-default-branch-")));
    mkdirSync(join(root, "work"));
    mkdirSync(join(root, "other"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it('a global includeIf "gitdir:<dir>/" matching the new repository names its branch', async () => {
    const extra = globalWith(`gitdir:${root}/work/`, TRUNK);
    expect(native(["init", "-q", "--template=", "work/n1"], extra).status).toBe(0);
    const result = await ours((c) => c.setDirectory("work/o1").setTemplate(""), extra);
    expect(head("work/o1/.git")).toBe(head("work/n1/.git"));
    expect(head("work/o1/.git")).toBe("ref: refs/heads/trunk\n");
    expect(result.initialBranch).toBe("trunk");
    expect(result.hints).toBeUndefined();
  });

  it('a bare repository is matched by its own directory ("gitdir:**/work/")', async () => {
    const extra = globalWith("gitdir:work/", TRUNK);
    expect(native(["init", "-q", "--template=", "--bare", "work/n2.git"], extra).status).toBe(0);
    await ours((c) => c.setDirectory("work/o2.git").setBare(true).setTemplate(""), extra);
    expect(head("work/o2.git")).toBe(head("work/n2.git"));
    expect(head("work/o2.git")).toBe("ref: refs/heads/trunk\n");
  });

  it('"gitdir/i:" folds case; a repository elsewhere keeps the built-in default', async () => {
    const extra = globalWith(`gitdir/i:${root.toUpperCase()}/WORK/`, TRUNK);
    expect(native(["init", "-q", "--template=", "work/n3"], extra).status).toBe(0);
    expect(native(["init", "-q", "--template=", "other/n3"], extra).status).toBe(0);
    await ours((c) => c.setDirectory("work/o3").setTemplate(""), extra);
    const elsewhere = await ours((c) => c.setDirectory("other/o3").setTemplate(""), extra);
    expect(head("work/o3/.git")).toBe(head("work/n3/.git"));
    expect(head("other/o3/.git")).toBe(head("other/n3/.git"));
    expect(head("other/o3/.git")).toBe("ref: refs/heads/master\n");
    expect(elsewhere.hints?.length).toBeGreaterThan(0);
  });

  it("advice.defaultBranchName from a matching include silences the hint", async () => {
    const extra = globalWith(`gitdir:${root}/work/`, "[advice]\n\tdefaultBranchName = false\n");
    const n = native(["init", "--template=", "work/n4"], extra);
    expect(n.status).toBe(0);
    const result = await ours((c) => c.setDirectory("work/o4").setTemplate(""), extra);
    expect(head("work/o4/.git")).toBe(head("work/n4/.git"));
    // git 2.43 prints its hint whatever advice.defaultBranchName says (its text has no
    // "Disable this message" line); 2.5x reads the setting
    const probe = native(["init", "--template=", "other/probe4"], {
      GIT_CONFIG_GLOBAL: join(root, "no-global"),
    });
    if (probe.stderr.includes("advice.defaultBranchName")) {
      expect(n.stderr).not.toContain("hint:");
      expect(result.hints).toBeUndefined();
    }
  });

  it("a command-line includeIf (GIT_CONFIG_PARAMETERS) matches the new repository", async () => {
    const inc = join(root, "inc-cmdline");
    writeFileSync(inc, TRUNK);
    const extra = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "includeIf.gitdir:**/work/.path",
      GIT_CONFIG_VALUE_0: inc,
    };
    expect(native(["init", "-q", "--template=", "work/n5"], extra).status).toBe(0);
    await ours((c) => c.setDirectory("work/o5").setTemplate(""), extra);
    expect(head("work/o5/.git")).toBe(head("work/n5/.git"));
    expect(head("work/o5/.git")).toBe("ref: refs/heads/trunk\n");
  });

  it("the template's config sets init.defaultBranch", async () => {
    mkdirSync(join(root, "tpl"), { recursive: true });
    writeFileSync(join(root, "tpl/config"), "[init]\n\tdefaultBranch = fromtemplate\n");
    const extra = { GIT_CONFIG_GLOBAL: join(root, "no-global") };
    expect(native(["init", "-q", "--template=tpl", "other/n6"], extra).status).toBe(0);
    await ours((c) => c.setDirectory("other/o6").setTemplate("tpl"), extra);
    expect(head("other/o6/.git")).toBe(head("other/n6/.git"));
    expect(head("other/o6/.git")).toBe("ref: refs/heads/fromtemplate\n");
  });

  it("clone guesses the remote HEAD by the new repository's init.defaultBranch", async () => {
    // a bundle advertises HEAD without its symref: guess_remote_head takes, among the
    // branches at HEAD's commit, init.defaultBranch's (here from a matching include)
    const src = join(root, "bundle-src");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: src, env: testEnv(root), stdio: "pipe" });
    mkdirSync(src);
    git("init", "-q", "-b", "master", "--template=");
    writeFileSync(join(src, "f.txt"), "f\n");
    git("add", "f.txt");
    git("commit", "-qm", "one");
    git("branch", "trunk");
    git("bundle", "create", join(root, "all.bundle"), "--all");
    const extra = globalWith(`gitdir:${root}/work/`, TRUNK);
    const bundle = join(root, "all.bundle");
    expect(native(["clone", "-q", "--template=", bundle, "work/nc"], extra).status).toBe(0);
    await ours((c) => c.setDirectory("work/oc").setTemplate(""), extra);
    const environment = createNodeGitHostEnvironment({ env: testEnv(root, extra) });
    const files = createNodeFilesApi({ rootDir: root });
    const gitDir = "work/oc/.git";
    const { history } = await createGitFilesBackend({ files, gitDir, environment });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
    const cloned = await Git.fromWorkingCopy(await worktrees.openCurrent())
      .clone()
      .setDirectory("work/oc")
      .setURI(bundle)
      .call();
    expect(head("work/oc/.git")).toBe(head("work/nc/.git"));
    expect(head("work/oc/.git")).toBe("ref: refs/heads/trunk\n");
    expect(cloned.defaultBranch).toBe("trunk");
  });
});
