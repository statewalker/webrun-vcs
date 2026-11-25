/**
 * Shared helpers of the plumbing helpers' native twins (`check-ref-format`, `stripspace`,
 * `url-parse`, `patch-id`, `var`, `check-attr`, `check-ignore`): native git run as a process,
 * ours through `Git`, both reduced to an exit status and the bytes of stdout and stderr
 * (latin1 text, so the two compare byte for byte).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";

import { nativeGitEnv } from "./native-git-http-backend.js";

/** What a git process gave. */
export interface Outcome {
  status: number;
  out: string;
  err: string;
}

/** The native git's version as `major.minor`. */
export function nativeVersion(): { major: number; minor: number } {
  const v = execFileSync("git", ["--version"], { encoding: "utf8" });
  const m = /(\d+)\.(\d+)/.exec(v);
  return { major: Number(m?.[1] ?? 0), minor: Number(m?.[2] ?? 0) };
}

/** Whether the native git is at least `major.minor`. */
export function nativeAtLeast(major: number, minor: number): boolean {
  const v = nativeVersion();
  return v.major > major || (v.major === major && v.minor >= minor);
}

/** The compatibility ours follows for the native git. */
export function nativeCompatibility(): "2.43" | "2.56" {
  return nativeAtLeast(2, 44) ? "2.56" : "2.43";
}

/** The test environment: fixed identities and dates, no system or global config. */
export function plumbingEnv(home: string, extra: Record<string, string> = {}) {
  return {
    ...nativeGitEnv(home),
    GIT_AUTHOR_NAME: "A U Thor",
    GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_COMMITTER_NAME: "C O Mitter",
    GIT_COMMITTER_EMAIL: "committer@example.com",
    GIT_AUTHOR_DATE: "1112911993 -0700",
    GIT_COMMITTER_DATE: "1112911993 -0700",
    ...extra,
  };
}

/** `git <args>` in `cwd`, its stdin given as latin1 text (git's bytes). */
export function native(
  home: string,
  cwd: string,
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
): Outcome {
  const r = spawnSync("git", args, {
    cwd,
    env: plumbingEnv(home, options.env),
    encoding: "latin1",
    input: Buffer.from(options.stdin ?? "", "latin1"),
  });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/** `git <args>` that must succeed; its stdout. */
export function git(home: string, cwd: string, args: string[], stdin?: string): string {
  const r = native(home, cwd, args, stdin === undefined ? {} : { stdin });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out;
}

/** Files written under `dir` (latin1 contents: git's bytes). */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), Buffer.from(content, "latin1"));
  }
}

/** Latin1 text of git's bytes as the string ours reads (`decodeGitPath`). */
export const fromBytes = (text: string): string => decodeGitPath(Buffer.from(text, "latin1"));

/** Our output as latin1 text of its bytes, as native output is read. */
export const asBytes = (text: string): string =>
  Buffer.from(encodeGitPath(text)).toString("latin1");

/** What our command gave, as an {@link Outcome}. */
export function outcomeOf(result: { exitCode: number; stdout: string; stderr: string }): Outcome {
  return { status: result.exitCode, out: asBytes(result.stdout), err: asBytes(result.stderr) };
}
