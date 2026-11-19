/**
 * What the status, commit dry-run and commit template native-twin tests share: native git
 * run with the test environment, and our working copy over the same repository with the
 * same host environment (extra variables included).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";

import type { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitEnv } from "./native-git-http-backend.js";

/** The test environment of native git, rooted at `home`, with `extra` variables. */
export function testEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { ...nativeGitEnv(home), ...extra };
}

/** Native git's stdout (latin-1 text: one character per byte). */
export function gitOut(
  home: string,
  cwd: string,
  args: string[],
  extra?: Record<string, string>,
): string {
  return execFileSync("git", args, {
    cwd,
    env: testEnv(home, extra),
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("latin1");
}

/** Native git's exit code, stdout and stderr (latin-1 text). */
export function gitRun(
  home: string,
  cwd: string,
  args: string[],
  extra?: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, env: testEnv(home, extra) });
  return {
    status: r.status,
    stdout: r.stdout.toString("latin1"),
    stderr: r.stderr.toString("latin1"),
  };
}

/** Writes `content` at `path` (latin-1 text: each character one byte), making directories. */
export function putFile(dir: string, path: string, content: string): void {
  const at = Buffer.concat([Buffer.from(`${dir}/`), Buffer.from(path, "latin1")]);
  mkdirSync(at.subarray(0, at.lastIndexOf(0x2f)), { recursive: true });
  writeFileSync(at, Buffer.from(content, "latin1"));
}

/** Our working copy over the repository at `dir`, with native git's host environment. */
export async function openRepo(
  home: string,
  dir: string,
  extra: Record<string, string> = {},
): Promise<Git> {
  return openOurs(dir, createNodeGitHostEnvironment({ env: testEnv(home, extra) }));
}
