/**
 * Test-only: twins of a repository for comparing our merge, cherry-pick, revert and rebase
 * with native git. The same build steps run twice (never a copy), native git operates on
 * one twin and our commands on the other, then both are compared: refusal, status, index,
 * every worktree file and git's state files.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { PersonIdent } from "@statewalker/vcs-core";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyConfig,
} from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemoryWorkingCopy } from "@statewalker/vcs-working-tree";

import { Git } from "../src/index.js";
import { nativeGitEnv } from "./native-git-http-backend.js";

/** The identity and date nativeGitEnv gives native git, for our commits to match. */
export const INTEROP_IDENT: PersonIdent = {
  name: "Interop Tester",
  email: "interop@example.com",
  timestamp: 1112911993,
  tzOffset: "+0000",
};

/** Native git in `cwd`: status, stdout, stderr (GIT_EDITOR is `true`). */
export function git(
  home: string,
  cwd: string,
  ...args: string[]
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    env: { ...nativeGitEnv(home), GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
    encoding: "utf8",
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Native git that must succeed; its stdout. */
export function gitOk(home: string, cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...nativeGitEnv(home), GIT_EDITOR: "true" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Writes a worktree file (parents created). */
export function put(dir: string, path: string, content: string | Uint8Array): void {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/** Our working copy over a repository native git made in `dir`. */
export async function openOurs(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const { history } = await createGitFilesBackend({ files });
  const io = {
    read: async (path: string) => {
      try {
        return new Uint8Array(readFileSync(join(dir, path)));
      } catch {
        return undefined;
      }
    },
    write: async (path: string, content: Uint8Array) => writeFileSync(join(dir, path), content),
  };
  const config = new GitWorkingCopyConfig(io, ".git/config");
  await config.load();
  const staging = new FileStagingStore(files, ".git/index");
  await staging.read();
  const checkoutFiles = {
    read: io.read,
    write: (p: string, c: Iterable<Uint8Array>) => files.write(p, c),
    stats: async (p: string) => {
      const s = await files.stats(p);
      return s ? { isDirectory: s.kind === "directory" } : undefined;
    },
    remove: async (p: string) => {
      await files.remove(p);
    },
    removeDir: async (p: string) => {
      await files.remove(p);
    },
    mkdir: (p: string) => files.mkdir(p),
    list: (p: string) => files.list(p),
  } as unknown as GitCheckoutFilesApi;
  const checkout = new GitCheckout({
    staging,
    refs: history.refs,
    files: checkoutFiles,
    gitDir: ".git",
  });
  const worktree = createFileWorktree({
    files,
    rootPath: "",
    gitDir: ".git",
    blobs: history.blobs,
    trees: history.trees,
  });
  const wc = new MemoryWorkingCopy({ history, checkout, worktree, config });
  return Git.fromWorkingCopy(wc);
}

/** The state files a merge, cherry-pick, revert or rebase leaves, as `name: content`. */
const STATE_FILES = [
  "MERGE_HEAD",
  "MERGE_MSG",
  "MERGE_MODE",
  "SQUASH_MSG",
  "ORIG_HEAD",
  "AUTO_MERGE",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "MERGE_AUTOSTASH",
];

/** Everything compared between the twins. */
export interface Snapshot {
  head: string;
  status: string;
  index: string;
  files: Record<string, string>;
  state: Record<string, string>;
}

function walkFiles(dir: string, prefix = "", out: Record<string, string> = {}) {
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    if (!prefix && name === ".git") continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(dir, rel));
    if (stat.isSymbolicLink()) out[rel] = `link -> ${readlinkSync(join(dir, rel))}`;
    else if (stat.isDirectory()) {
      out[`${rel}/`] = "dir";
      walkFiles(dir, rel, out);
    } else {
      const exec = stat.mode & 0o100 ? "[x] " : "";
      out[rel] = exec + readFileSync(join(dir, rel)).toString("latin1");
    }
  }
  return out;
}

function stateFiles(dir: string, normalize: (name: string, text: string) => string) {
  const out: Record<string, string> = {};
  const gitDir = join(dir, ".git");
  for (const name of STATE_FILES) {
    const path = join(gitDir, name);
    if (existsSync(path)) out[name] = normalize(name, readFileSync(path, "utf8"));
  }
  for (const sub of ["sequencer", "rebase-merge"]) {
    const path = join(gitDir, sub);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name);
      // `patch` only shows the stopped commit's diff (git am --show-current-patch)
      if (lstatSync(file).isDirectory() || name === "patch") continue;
      out[`${sub}/${name}`] = normalize(`${sub}/${name}`, readFileSync(file, "utf8"));
    }
  }
  return out;
}

/**
 * The repository as both twins are compared: HEAD (symbolic or not), status, index, every
 * worktree file, the state files (`normalize` evens out what git versions write
 * differently).
 */
export function snapshot(
  home: string,
  dir: string,
  normalize: (name: string, text: string) => string = (_n, t) => t,
): Snapshot {
  const symbolic = git(home, dir, "symbolic-ref", "-q", "HEAD").stdout.trim();
  return {
    head: `${symbolic || "detached"} ${git(home, dir, "rev-parse", "HEAD").stdout.trim()}`,
    status: gitOk(home, dir, "status", "--porcelain=v2", "-uall"),
    index: gitOk(home, dir, "ls-files", "-s"),
    files: walkFiles(dir),
    state: stateFiles(dir, normalize),
  };
}

/**
 * State files as both git versions agree on them: the todo/done lines without the `# `
 * 2.5x puts before the subject, the backup's help text and the message's conflict list
 * (2.43 leaves the commit message in `rebase-merge/message`).
 */
export function normalizeState(name: string, text: string): string {
  if (name === "rebase-merge/git-rebase-todo.backup") return "<backup>";
  // a stash commit of the moment (its date is the clock's)
  if (name === "rebase-merge/autostash" || name === "MERGE_AUTOSTASH") return "<autostash>";
  if (name === "rebase-merge/message") return text.replace(/\n# Conflicts:\n(#\t.*\n)*$/, "\n");
  if (/rebase-merge\/(git-rebase-todo|done)$/.test(name) || name === "sequencer/todo") {
    return text.replace(/^(\w+ [0-9a-f]+) # /gm, "$1 ");
  }
  return text;
}

/** Native git's merge-ort lines from stdout (what our `output` carries). */
export function ortLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((l) => /^(Auto-merging|CONFLICT|warning: Cannot merge|Automatic merge failed)/.test(l));
}
