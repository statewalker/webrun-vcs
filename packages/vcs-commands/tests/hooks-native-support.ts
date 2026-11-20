/**
 * What the hook native-twin tests share: a hook script that logs its name, arguments, the
 * variables git sets for hooks, its directory and stdin to a log file (and can refuse or
 * edit the message file when told to), twins of a repository with such hooks, and our
 * working copy over a twin with the Node hook runner.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";

import type { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitRun, testEnv } from "./status-native-support.js";

/** Whether native git is 2.5x (else 2.43): the runner's compatibility. */
export const nativeIs25x = (() => {
  if (!nativeGitAvailable()) return false;
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return !!m && (Number(m[1]) > 2 || Number(m[2]) >= 50);
})();

/**
 * The logging hook. `$HOOK_LOG` is the log; in `$HOOK_CTL`, a file `exit-<name>` gives the
 * exit code, `edit-<name>` text appended to the file named by the first argument.
 */
export const HOOK_SCRIPT = String.raw`#!/bin/sh
n=$(basename "$0")
{
  printf '== %s' "$n"
  for a in "$@"; do printf ' [%s]' "$a"; done
  echo
  for v in GIT_INDEX_FILE GIT_EDITOR GIT_PREFIX GIT_DIR GIT_WORK_TREE GIT_REFLOG_ACTION GIT_PUSH_OPTION_COUNT GIT_QUARANTINE_PATH; do
    if env | grep -q "^$v="; then printf '%s=%s
' "$v" "$(printenv "$v")"; fi
  done
  printf 'pwd=%s
' "$(pwd)"
  input=$(cat)
  if [ -n "$input" ]; then printf 'stdin:
%s
' "$input"; fi
} >> "$HOOK_LOG"
if [ -f "$HOOK_CTL/edit-$n" ]; then cat "$HOOK_CTL/edit-$n" >> "$1"; fi
echo "hook $n out"
echo "hook $n err" >&2
if [ -f "$HOOK_CTL/exit-$n" ]; then exit "$(cat "$HOOK_CTL/exit-$n")"; fi
exit 0
`;

/** Installs the logging hook as each of `names` in `dir` (a hooks directory), executable. */
export function installHooks(dir: string, names: string[], executable = true): void {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const path = join(dir, name);
    writeFileSync(path, HOOK_SCRIPT);
    chmodSync(path, executable ? 0o755 : 0o644);
  }
}

/** One side of a twin: its repository, its hook log and control directory. */
export interface HookTwin {
  dir: string;
  log: string;
  ctl: string;
  /** The variables of git and of our runner on this side */
  env: Record<string, string>;
}

/** Two copies of `dir` (native, ours), each with its own log and control directory. */
export function hookTwins(root: string, dir: string): [HookTwin, HookTwin] {
  const make = (suffix: string): HookTwin => {
    const copy = `${dir}-${suffix}`;
    rmSync(copy, { recursive: true, force: true });
    execFileSync("cp", ["-a", dir, copy]);
    const log = `${copy}.hooklog`;
    const ctl = `${copy}.hookctl`;
    rmSync(log, { force: true });
    rmSync(ctl, { recursive: true, force: true });
    mkdirSync(ctl, { recursive: true });
    const env = testEnv(root, { HOOK_LOG: log, HOOK_CTL: ctl });
    gitRun(root, copy, ["update-index", "-q", "--refresh"], env);
    return { dir: copy, log, ctl, env };
  };
  return [make("native"), make("ours")];
}

/** Tells the hook `name` of a twin to exit with `code`. */
export function hookExit(twin: HookTwin, name: string, code: number): void {
  writeFileSync(join(twin.ctl, `exit-${name}`), `${code}\n`);
}

/** Tells the hook `name` of a twin to append `text` to the file of its first argument. */
export function hookEdit(twin: HookTwin, name: string, text: string): void {
  writeFileSync(join(twin.ctl, `edit-${name}`), text);
}

/** The twin's hook log, its directory written as `<twin>`. */
export function hookLog(twin: HookTwin): string {
  if (!existsSync(twin.log)) return "";
  return readFileSync(twin.log, "latin1").replaceAll(twin.dir, "<twin>");
}

/** Native git in a twin (with `extra` variables): exit status, stdout and stderr. */
export function nativeIn(
  twin: HookTwin,
  root: string,
  args: string[],
  extra: Record<string, string> = {},
) {
  return gitRun(root, twin.dir, args, { ...twin.env, ...extra });
}

/** The lines of a stderr that hooks wrote or that are hints about them. */
export function hookLines(stderr: string): string {
  return stderr
    .split("\n")
    .filter((l) => /^hook \S+ (out|err)$/.test(l) || /^hint: .*(hook|ignoredHook)/.test(l))
    .join("\n");
}

/** Our working copy over a twin, its hooks run by the Node runner. */
export async function oursIn(twin: HookTwin, extra: Record<string, string> = {}): Promise<Git> {
  const env = { ...twin.env, ...extra };
  return openOurs(
    twin.dir,
    createNodeGitHostEnvironment({
      env,
      hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
    }),
  );
}
