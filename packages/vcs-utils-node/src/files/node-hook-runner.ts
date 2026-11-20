/**
 * The hook runner of Node hosts: spawns the hook the commands found (an executable file of
 * the repository's hooks directory) as git's run-command.c starts it, and hands back its exit
 * code and output. Its shape is `HookRunner` of `@statewalker/vcs-working-tree`; pass it to
 * `createNodeGitHostEnvironment({ hookRunner })`.
 */
import { spawn } from "node:child_process";

/** One hook to run (`HookInvocation` of `@statewalker/vcs-working-tree`). */
export interface NodeHookInvocation {
  name: string;
  path: string;
  hostPath?: string;
  args: string[];
  stdin?: Uint8Array;
  env: Record<string, string>;
  cwd: string;
  hostCwd?: string;
  stdoutToStderr: boolean;
}

/** What a hook did (`HookOutcome`). */
export interface NodeHookOutcome {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** The runner (`HookRunner`). */
export interface NodeHookRunner {
  run(invocation: NodeHookInvocation): Promise<NodeHookOutcome | undefined>;
  compatibility?: "2.43" | "2.56";
}

/** How hooks are spawned. */
export interface NodeHookRunnerOptions {
  /** The variables every hook starts from (default: `process.env`) */
  env?: Record<string, string | undefined>;
  /**
   * The directory a hook runs in when the repository's files have no host directory
   * (an in-memory FilesApi): default the process's current directory
   */
  defaultCwd?: string;
  /** The git version whose wording the hooks follow where versions differ (default 2.56) */
  compatibility?: "2.43" | "2.56";
}

/**
 * A runner that spawns each hook with the host's environment plus the variables git sets for
 * it, in the worktree top. A hook whose stdout goes to stderr (most hooks) runs with its
 * stdout joined to its stderr, so their order is kept, as git's `stdout_to_stderr` does.
 *
 * @example
 * ```typescript
 * const environment = createNodeGitHostEnvironment({ hookRunner: createNodeHookRunner() });
 * ```
 */
export function createNodeHookRunner(options: NodeHookRunnerOptions = {}): NodeHookRunner {
  return {
    ...(options.compatibility ? { compatibility: options.compatibility } : {}),
    run: (invocation) => runHook(invocation, options),
  };
}

function runHook(
  invocation: NodeHookInvocation,
  options: NodeHookRunnerOptions,
): Promise<NodeHookOutcome | undefined> {
  const base = options.env ?? process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  Object.assign(env, invocation.env);
  const cwd = invocation.hostCwd ?? options.defaultCwd ?? process.cwd();
  // the script as git names it (relative to the cwd), its argv[0]; else its host path
  const script =
    invocation.path.startsWith("/") || invocation.hostCwd ? invocation.path : invocation.hostPath;
  if (!script) return Promise.resolve(undefined);
  // the shell joins stdout to stderr ("1>&2") and runs a script without a "#!" line, as
  // git's run-command falls back to sh on ENOEXEC
  const [command, args] = invocation.stdoutToStderr
    ? ["/bin/sh", ["-c", 'exec "$0" "$@" 1>&2', script, ...invocation.args]]
    : [script, invocation.args];
  return new Promise((resolve) => {
    const child = spawn(command as string, args as string[], {
      cwd,
      env,
      stdio: [invocation.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    let failed: Error | undefined;
    child.on("error", (error) => {
      failed = error;
    });
    if (invocation.stdin && child.stdin) {
      // a hook that does not read its stdin closes the pipe: git ignores SIGPIPE there
      child.stdin.on("error", () => {});
      child.stdin.end(Buffer.from(invocation.stdin));
    }
    child.on("close", (code, signal) => {
      if (failed && code === null) {
        resolve({
          exitCode: 1,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode(
            `error: cannot run ${invocation.path}: ${failed.message}\n`,
          ),
        });
        return;
      }
      const signalNumber = signal ? (signalNumbers[signal] ?? 0) : 0;
      resolve({
        exitCode: code ?? 128 + signalNumber,
        stdout: new Uint8Array(Buffer.concat(out)),
        stderr: new Uint8Array(Buffer.concat(err)),
      });
    });
  });
}

const signalNumbers: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};
