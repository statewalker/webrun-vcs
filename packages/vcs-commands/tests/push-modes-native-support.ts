/**
 * What the `git push` mode twins share (push-default, delete/prune/all/tags, mirror, push
 * options): two directories built by the same steps (`n/` for native git, `o/` for ours),
 * a `git push` command line run natively in one and mapped onto `PushCommand` in the other,
 * and the comparison of what each left: exit status, the report and fatal lines on stderr,
 * the refs of the repositories named, the pusher's `branch.*` configuration and the logs of
 * the remotes' hooks (`hooks-native-support.ts`'s logging hook, with the push options).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { expect } from "vitest";

import { GitApiError, type PushCommand, type PushResult } from "../src/index.js";
import { installHooks, nativeIs25x } from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { noMaintenance } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

/** The receive hooks the twins log (and so the push options they are told). */
export const RECEIVE_HOOKS = ["pre-receive", "post-receive"];

/** Two directories built by the same steps: `n` for native git, `o` for ours. */
export interface Twins {
  root: string;
  n: string;
  o: string;
}

let counter = 0;

/** The variables of one side: its hook log, the push options its hooks log. */
export function sideEnv(root: string, side: string): Record<string, string> {
  return testEnv(root, {
    HOOK_LOG: `${side}.hooklog`,
    HOOK_CTL: `${side}.hookctl`,
    HOOK_EXTRA_VARS: "GIT_PUSH_OPTION_0 GIT_PUSH_OPTION_1 GIT_PUSH_OPTION_2",
  });
}

/** Builds both sides with `build` (native git in each). */
export function twins(root: string, build: (dir: string) => void): Twins {
  const base = join(root, `t${counter++}`);
  const t = { root, n: join(base, "n"), o: join(base, "o") };
  for (const dir of [t.n, t.o]) {
    mkdirSync(dir, { recursive: true });
    mkdirSync(`${dir}.hookctl`, { recursive: true });
    build(dir);
  }
  return t;
}

/** Runs the same native git command in `<side>/<cwd>` of both twins. */
export function both(t: Twins, cwd: string, ...args: string[]): void {
  for (const d of [t.n, t.o]) gitOut(t.root, join(d, cwd), args, sideEnv(t.root, d));
}

/** t/test-lib-functions.sh's test_commit in `<side>/<cwd>` of both twins. */
export function testCommit(t: Twins, cwd: string, name: string): void {
  for (const d of [t.n, t.o]) {
    const dir = join(d, cwd);
    putFile(dir, `${name}.t`, `${name}\n`);
    gitOut(t.root, dir, ["add", `${name}.t`]);
    gitOut(t.root, dir, ["commit", "-qm", name]);
    gitOut(t.root, dir, ["tag", name]);
  }
}

/** A bare repository `<dir>/<name>` (with the logging receive hooks when asked). */
export function bare(root: string, dir: string, name: string, hooks = false): void {
  gitOut(root, dir, ["init", "-q", "--bare", "-b", "main", name]);
  noMaintenance(join(dir, name));
  if (hooks) installHooks(join(dir, name, "hooks"), RECEIVE_HOOKS);
}

/** Every ref of a repository, with its value. */
const refsOf = (root: string, dir: string) =>
  gitOut(root, dir, ["for-each-ref", "--format=%(refname) %(objectname)"]);

/** The `branch.*` configuration of a repository. */
const branchConfig = (root: string, dir: string) =>
  gitRun(root, dir, ["config", "--get-regexp", "^branch\\."]).stdout;

/** A side's hook log, its directory and git's quarantine directory written alike. */
function hookLog(side: string): string {
  try {
    return readFileSync(`${side}.hooklog`, "latin1")
      .replaceAll(side, "<twin>")
      .replace(/tmp_objdir-incoming-[^/\s]+/g, "tmp_objdir-incoming-<id>");
  } catch {
    return "";
  }
}

/** git's stderr lines a twin compares: no hints, no lines of the transport's death. */
function stderrLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter(
      (l) =>
        l !== "" &&
        !l.startsWith("hint:") &&
        !l.startsWith("remote: ") &&
        !l.startsWith("error: failed to push some refs") &&
        l !== "fatal: the remote end hung up unexpectedly",
    );
}

/** Our error as git's stderr lines: `fatal: ` before a message that names no level. */
function errorLines(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const text = /^(fatal|error|warning): /.test(message) ? message : `fatal: ${message}`;
  return text
    .split("\n")
    .filter(
      (l) => l !== "" && !l.startsWith("hint:") && !l.startsWith("error: failed to push some refs"),
    );
}

/** The `-c <key>[=<value>]` options before `push`, as git's `GIT_CONFIG_PARAMETERS`. */
function configParameters(entries: string[]): string {
  return entries
    .map((entry) => {
      const eq = entry.indexOf("=");
      return eq < 0 ? `'${entry}'` : `'${entry.slice(0, eq)}'='${entry.slice(eq + 1)}'`;
    })
    .join(" ");
}

/**
 * The `git push` arguments (after `push`) as calls of our command: the options, the remote
 * and the refspecs.
 */
export function configurePush(p: PushCommand, args: string[]): PushCommand {
  const positional: string[] = [];
  const options: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--all" || a === "--branches") p.setPushAll(true);
    else if (a === "--mirror") p.setMirror(true);
    else if (a === "-d" || a === "--delete") p.setDelete(true);
    else if (a === "--tags") p.setPushTags(true);
    else if (a === "--prune") p.setPrune(true);
    else if (a === "-n" || a === "--dry-run") p.setDryRun(true);
    else if (a === "-f" || a === "--force") p.setForce(true);
    else if (a === "-u" || a === "--set-upstream") p.setSetUpstream(true);
    else if (a === "--atomic") p.setAtomic(true);
    else if (a === "--follow-tags") p.setFollowTags(true);
    else if (a === "-q" || a === "--porcelain") {
      // the report is compared as git prints it without them
    } else if (a === "-o") options.push(args[++i] as string);
    else if (a.startsWith("--push-option=")) options.push(a.slice("--push-option=".length));
    else if (a.startsWith("-")) throw new Error(`unmapped option ${a}`);
    else positional.push(a);
  }
  if (options.length > 0) p.setPushOptions(options);
  const [remote, ...refspecs] = positional;
  if (remote !== undefined) p.setRemote(remote);
  if (refspecs.length > 0) p.setRefSpecs(...refspecs);
  return p;
}

export interface PushOutcome {
  native: { status: number | null; stdout: string; stderr: string };
  result?: PushResult;
  error?: unknown;
}

/**
 * `git [-c ...] push <args>` natively in `<n>/<cwd>`, mapped onto ours in `<o>/<cwd>`;
 * compares the exit status (0, 1 for refused refs, 128 for a death), stderr (the report, or
 * the fatal lines), the refs of each repository in `compare` (`cwd` always), the pusher's
 * `branch.*` configuration and the hook logs.
 */
export async function pushBoth(
  t: Twins,
  cwd: string,
  argv: string[],
  compare: string[] = [],
): Promise<PushOutcome> {
  const config: string[] = [];
  let i = 0;
  while (argv[i] === "-c") {
    config.push(argv[i + 1] as string);
    i += 2;
  }
  expect(argv[i], "the command").toBe("push");
  const args = argv.slice(i + 1);
  const label = `git ${argv.join(" ")}`;

  const native = gitRun(t.root, join(t.n, cwd), argv, sideEnv(t.root, t.n));
  const env = {
    ...sideEnv(t.root, t.o),
    ...(config.length > 0 ? { GIT_CONFIG_PARAMETERS: configParameters(config) } : {}),
  };
  let result: PushResult | undefined;
  let error: unknown;
  try {
    const ours = await openOurs(
      t.o,
      createNodeGitHostEnvironment({
        env,
        hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
      }),
      undefined,
      cwd,
    );
    result = await configurePush(ours.push(), args).call();
  } catch (e) {
    error = e;
  }

  const nativeLines = stderrLines(native.stderr);
  if (error !== undefined) {
    // a death (128), or a refusal before anything is sent (1)
    if (!(error instanceof GitApiError)) throw error;
    expect(error.exitCode, `${label}: exit status (${native.stderr})`).toBe(native.status);
    // ours names a config file from the FilesApi's root (the twin), git from its cwd
    const lines = errorLines(error).map((l) => l.replace(` in file '${cwd}/`, " in file '"));
    expect(lines, `${label}: stderr`).toEqual(nativeLines);
  } else {
    const refused =
      (result?.remoteUpdates ?? []).some((u) => u.status !== "ok" && u.status !== "up-to-date") ||
      !!result?.failed;
    expect(refused ? 1 : 0, `${label}: exit status (${native.stderr})`).toBe(native.status);
    const ours = [
      ...(result?.warnings ?? []),
      ...(result?.display ?? []),
      ...(result?.errors ?? []),
    ];
    expect(ours, `${label}: stderr`).toEqual(nativeLines);
  }
  for (const dir of new Set([cwd, ...compare])) {
    expect(refsOf(t.root, join(t.o, dir)), `${label}: refs of ${dir}`).toBe(
      refsOf(t.root, join(t.n, dir)),
    );
  }
  expect(branchConfig(t.root, join(t.o, cwd)), `${label}: branch config`).toBe(
    branchConfig(t.root, join(t.n, cwd)),
  );
  expect(hookLog(t.o), `${label}: hooks`).toBe(hookLog(t.n));
  return { native, result, error };
}
