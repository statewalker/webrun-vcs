/**
 * Native twins of git's interactive extras (`commit -p`, `add -e`, `clean -i`, `am -i`):
 * native git run with scripted answers on standard input and a scripted editor, and a
 * selector and editor giving ours the same answers.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";

import type { PatchRequest } from "../src/commands/add-patch/index.js";
import { Git } from "../src/index.js";
import { snapshot } from "./merge-native-helpers.js";
import { nativeGitEnv } from "./native-git-http-backend.js";

type Env = Record<string, string | undefined>;

/** The fixed identities every native call and ours use. */
export const IDENT: Env = {
  GIT_AUTHOR_NAME: "Ann Author",
  GIT_AUTHOR_EMAIL: "ann@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0200",
  GIT_COMMITTER_NAME: "Cid Committer",
  GIT_COMMITTER_EMAIL: "cid@example.com",
  GIT_COMMITTER_DATE: "1700000500 -0700",
};

export function envOf(home: string, over: Env = {}): Record<string, string> {
  const env: Env = { ...nativeGitEnv(home), ...IDENT, ...over };
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

export function git(home: string, cwd: string, args: string[], env: Env = {}) {
  const r = spawnSync("git", args, {
    cwd,
    env: envOf(home, { GIT_EDITOR: "true", ...env }),
    encoding: "utf8",
    input: "",
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function gitOk(home: string, cwd: string, args: string[], env: Env = {}): string {
  const r = git(home, cwd, args, env);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

export function put(dir: string, path: string, content: string | Uint8Array): void {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  rmSync(full, { force: true });
  writeFileSync(full, content);
}

/** Our working copy over the repository native git made in `dir`, with the same identities. */
export async function openOurs(home: string, dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const environment = createNodeGitHostEnvironment({ env: envOf(home) });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/**
 * An editor: the shell script native git runs (`$1` is the file) and what it does to the
 * text in JS. Undefined from `js` is a failing editor.
 */
export interface Editor {
  sh: string;
  js: (text: string) => string | undefined;
}

/** An editor leaving the file as it is. */
export const KEEP: Editor = { sh: ":", js: (t) => t };

/** An editor running `sed -i <expression>` over the file. */
export function sed(expression: string, js: (text: string) => string): Editor {
  return { sh: `sed -i '${expression.replace(/'/g, "'\\''")}' "$1"`, js };
}

/** A failing editor. */
export const FAIL: Editor = { sh: "exit 1", js: () => undefined };

let scripts = 0;

/**
 * Native git with `-c color.ui=false -c interactive.singleKey=false`, `GIT_PAGER=cat`, the
 * answers on stdin (each one a line; `eof` leaves the input at that) and the editors run in
 * turn. `buffers` are the texts each editor run was given.
 */
export function native(
  home: string,
  dir: string,
  args: string[],
  answers: string[],
  editors: Editor[] = [],
  env: Env = {},
): { stdout: string; stderr: string; status: number; buffers: string[] } {
  const n = scripts++;
  const editor = join(home, `editor-${n}.sh`);
  const state = join(home, `editor-${n}.n`);
  const copies = join(home, `editor-${n}.buf`);
  writeFileSync(state, "0");
  const steps = editors.map((e, i) => `if [ "$n" = ${i} ]; then\n${e.sh}\nexit $?\nfi`);
  writeFileSync(
    editor,
    `#!/bin/sh\nn=$(cat '${state}')\necho $((n+1)) > '${state}'\ncat "$1" >> '${copies}'\nprintf '\\0' >> '${copies}'\n${steps.join("\n")}\n`,
  );
  chmodSync(editor, 0o755);
  const r = spawnSync(
    "git",
    ["-c", "color.ui=false", "-c", "interactive.singleKey=false", ...args],
    {
      cwd: dir,
      env: envOf(home, { GIT_PAGER: "cat", GIT_EDITOR: editor, ...env }),
      input: answers.map((a) => `${a}\n`).join(""),
      encoding: "latin1",
    },
  );
  let buffers: string[] = [];
  try {
    buffers = readFileSync(copies, "latin1").split("\0").slice(0, -1);
    unlinkSync(copies);
  } catch {
    // no editor run
  }
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1, buffers };
}

/** The answers as a selector gives them; `edit` requests go to the editors in turn. */
export function selector(answers: string[], editors: Editor[] = [], buffers: string[] = []) {
  const queue = [...answers];
  const editQueue = [...editors];
  return (request: PatchRequest): string | undefined => {
    if (request.type === "edit") {
      buffers.push(request.text);
      const editor = editQueue.shift();
      return editor ? editor.js(request.text) : request.text;
    }
    return queue.shift();
  };
}

/** A line reader answering as the scripted stdin does (undefined at its end). */
export function lineReader(answers: string[]): () => string | undefined {
  const queue = [...answers];
  return () => queue.shift();
}

/** An editor callback of ours running the editors in turn; the texts it was given. */
export function editorOf(editors: Editor[], buffers: string[] = []) {
  const queue = [...editors];
  return (_path: string, text: string): string | undefined => {
    buffers.push(text);
    const editor = queue.shift();
    return editor ? editor.js(text) : text;
  };
}

/** HEAD, the index, status, the worktree, the state files, and the log of HEAD. */
export function view(home: string, dir: string) {
  const shot = snapshot(home, dir);
  const log = git(home, dir, ["log", "--format=%H %T %an %ae %ad %cn %s%n%b", "HEAD"]).stdout;
  return { ...shot, log };
}
