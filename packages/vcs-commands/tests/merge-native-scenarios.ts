/**
 * Test-only: builds the histories the merge, cherry-pick, revert and rebase twin tests run
 * on, the same way every time (so two twins built apart are the same repository).
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { gitOk, put } from "./merge-native-helpers.js";

/** A file's content, a link (`{ link }`), an executable (`{ exec }`), or deleted (null). */
export type FileSpec = string | Uint8Array | { link: string } | { exec: string } | null;
export type Files = Record<string, FileSpec>;

/** Writes `files` into `dir` (deleting the nulls). */
export function applyFiles(dir: string, files: Files): void {
  for (const [path, spec] of Object.entries(files)) {
    const full = join(dir, path);
    if (existsSync(full) || isLink(full)) rmSync(full, { recursive: true, force: true });
    if (spec === null) continue;
    mkdirSync(join(full, ".."), { recursive: true });
    if (typeof spec === "object" && "link" in spec) symlinkSync(spec.link, full);
    else if (typeof spec === "object" && "exec" in spec) {
      put(dir, path, spec.exec);
      chmodSync(full, 0o755);
    } else put(dir, path, spec);
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A history: `base` committed on main, `side` branched off with its changes, main's on top. */
export interface History {
  base: Files;
  main?: Files;
  side?: Files;
  /** More commits on side (each a commit), after `side` */
  sideMore?: Files[];
  /** Repository config set before the first commit */
  config?: Record<string, string>;
  /** Changes left in the worktree (and the index with `stage`) on main */
  dirty?: Files;
  /** Paths of `dirty` to stage */
  stage?: string[];
}

/** Builds `history` in a new repository at `dir`. */
export function buildHistory(home: string, dir: string, history: History): void {
  mkdirSync(dir, { recursive: true });
  const run = (...args: string[]) => gitOk(home, dir, ...args);
  run("init", "-q", "-b", "main");
  for (const [key, value] of Object.entries(history.config ?? {})) run("config", key, value);
  applyFiles(dir, history.base);
  run("add", "-A");
  run("commit", "-q", "--allow-empty", "-m", "base");
  run("checkout", "-q", "-b", "side");
  applyFiles(dir, history.side ?? {});
  run("add", "-A");
  run("commit", "-q", "--allow-empty", "-m", "side change\n\nbody line");
  for (const [k, more] of (history.sideMore ?? []).entries()) {
    applyFiles(dir, more);
    run("add", "-A");
    run("commit", "-q", "--allow-empty", "-m", `side ${k + 2}`);
  }
  run("checkout", "-q", "main");
  // no `main`: side is a fast-forward of main
  if (history.main) {
    applyFiles(dir, history.main);
    run("add", "-A");
    run("commit", "-q", "--allow-empty", "-m", "main change");
  }
  if (history.dirty) {
    applyFiles(dir, history.dirty);
    if (history.stage?.length) run("add", "-A", "--", ...history.stage);
  }
}

const lines = (n: number, edit: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => `${edit[i + 1] ?? `line ${i + 1}`}\n`).join("");

/** Ten numbered lines with some replaced (`{ 3: "x" }` puts x on line 3). */
export const text = (edit: Record<number, string> = {}) => lines(10, edit);
