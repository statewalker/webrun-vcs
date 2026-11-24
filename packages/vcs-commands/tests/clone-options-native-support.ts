/**
 * What the clone-option twins share (t5606-clone-options, t5611-clone-config,
 * t5621-clone-revision, t1091-sparse-checkout-builtin, t5702-protocol-v2): the repository
 * state a clone leaves, compared whole between native git's clone and ours, and our clone into
 * an empty repository (`git init` first, as `git clone` runs init_db).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";

import { Git } from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitOut, gitRun, testEnv } from "./status-native-support.js";

/** Our clone's compatibility: the native git's version. */
export const compatibility: "2.43" | "2.56" = nativeIs25x ? "2.56" : "2.43";

const read = (path: string) => (existsSync(path) ? readFileSync(path, "latin1") : undefined);

/** The files of a worktree (`.git` left out), path → content. */
function worktreeFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(rel ? join(dir, rel) : dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === ".git") continue;
      if (e.isDirectory()) walk(r);
      else out[r] = readFileSync(join(dir, r), "latin1");
    }
  };
  walk("");
  return out;
}

/**
 * The state a clone leaves in `repo` (a worktree, or a bare repository): HEAD, the refs and
 * where they are stored, HEAD's reflog, the config, shallow and sparse-checkout files, the
 * objects, and for a worktree its index entries and files.
 */
export function cloneStateOf(home: string, repo: string, bare = false) {
  const gitDir = bare ? repo : join(repo, ".git");
  const git = (...args: string[]) => gitOut(home, repo, args);
  const reflog = gitRun(home, repo, ["reflog", "show", "--format=%H %gs", "HEAD"]);
  return {
    head: read(join(gitDir, "HEAD")),
    refs: git("for-each-ref", "--format=%(refname) %(objectname) %(symref)"),
    packed: read(join(gitDir, "packed-refs")),
    loose: git("for-each-ref", "--format=%(refname)")
      .split("\n")
      .filter((name) => name && existsSync(join(gitDir, name))),
    headLog: reflog.status === 0 ? reflog.stdout : undefined,
    config: read(join(gitDir, "config")),
    shallow: read(join(gitDir, "shallow")),
    sparse: read(join(gitDir, "info/sparse-checkout")),
    objects: git("cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)")
      .split("\n")
      .filter(Boolean)
      .sort(),
    ...(bare ? {} : { index: git("ls-files", "-s", "-t"), files: worktreeFiles(repo) }),
  };
}

type Clone = ReturnType<Git["clone"]>;

/**
 * Our clone into `dir` (absolute, below `home`), made an empty repository first (bare with
 * `bare`); `extraEnv` reaches our host environment (`GIT_CONFIG_COUNT`: git's `-c`).
 */
export async function ourClone(
  home: string,
  dir: string,
  configure: (c: Clone) => Clone,
  options: { bare?: boolean; extraEnv?: Record<string, string> } = {},
) {
  const env = testEnv(home, options.extraEnv ?? {});
  gitOut(home, home, ["init", "-q", "-b", "main", ...(options.bare ? ["--bare"] : []), dir]);
  const environment = createNodeGitHostEnvironment({ env });
  const rel = dir.slice(home.length + 1);
  let git: Git;
  if (options.bare) {
    const files = createNodeFilesApi({ rootDir: home });
    const { history } = await createGitFilesBackend({ files, gitDir: rel, environment });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: rel, history, environment });
    git = Git.fromWorktreeAdmin(await worktrees.openAdmin());
  } else {
    git = await openOurs(home, environment, undefined, rel);
  }
  return configure(git.clone().setCompatibility(compatibility)).call();
}

/** Our clone's failure: its message (git's lines) and exit code. */
export async function ourCloneFails(
  home: string,
  dir: string,
  configure: (c: Clone) => Clone,
  options: { bare?: boolean; extraEnv?: Record<string, string> } = {},
): Promise<{ message: string; exitCode?: number }> {
  try {
    await ourClone(home, dir, configure, options);
  } catch (error) {
    const e = error as Error & { exitCode?: number };
    return { message: e.message, exitCode: e.exitCode };
  }
  throw new Error("our clone succeeded");
}

/** git's `fatal:`/`error:`/`warning:`/`hint:` lines on stderr. */
export const stderrLines = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => /^(fatal|error|warning|hint): /.test(l))
    .join("\n");

export { testEnv };
