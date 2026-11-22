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
  /** Variables removed from the base environment (`GIT_DIR` for `worktree add`'s hook) */
  unsetEnv?: string[];
  cwd: string;
  hostCwd?: string;
  stdoutToStderr: boolean;
  /** A configured hook's shell command (`hook.<name>.command`), in place of a script */
  command?: string;
}

/** What a hook did (`HookOutcome`). */
export interface NodeHookOutcome {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** A hook running, its stdin and stdout piped (`HookProcess`). */
export interface NodeHookProcess {
  write(data: Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  readonly stdout: AsyncIterable<Uint8Array>;
  closeStdout(): void;
  wait(): Promise<NodeHookOutcome>;
  /** Kills the child (SIGTERM) */
  kill(): void;
}

/** How a started hook's stderr is handed back (`HookStartOptions`). */
export interface NodeHookStartOptions {
  /** Each chunk of its stderr as it comes (the outcome's stderr then empty) */
  onStderr?(chunk: Uint8Array): void;
}

/** The runner (`HookRunner`). */
export interface NodeHookRunner {
  run(invocation: NodeHookInvocation): Promise<NodeHookOutcome | undefined>;
  /** Starts the hook with its stdin and stdout piped (git's `in = out = -1`: proc-receive) */
  start(
    invocation: NodeHookInvocation,
    startOptions?: NodeHookStartOptions,
  ): Promise<NodeHookProcess | undefined>;
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
    start: (invocation, startOptions) => startHook(invocation, options, startOptions),
  };
}

/**
 * Starts a hook as {@link runHook} would run it, its stdin and stdout piped to the caller
 * (a script: its stdout is never sent to stderr here). Undefined when there is no script.
 */
async function startHook(
  invocation: NodeHookInvocation,
  options: NodeHookRunnerOptions,
  startOptions: NodeHookStartOptions = {},
): Promise<NodeHookProcess | undefined> {
  const base = options.env ?? process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  for (const key of invocation.unsetEnv ?? []) delete env[key];
  Object.assign(env, invocation.env);
  const cwd = invocation.hostCwd ?? options.defaultCwd ?? process.cwd();
  let command: string;
  let args: string[];
  if (invocation.command !== undefined) {
    command = "/bin/sh";
    args = ["-c", `${invocation.command} "$@"`, invocation.command, ...invocation.args];
  } else {
    const script =
      invocation.path.startsWith("/") || invocation.hostCwd ? invocation.path : invocation.hostPath;
    if (!script) return undefined;
    command = script;
    args = invocation.args;
  }
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const err: Buffer[] = [];
  // streamed as it comes (git's copy_to_sideband), else kept for the outcome
  const onStderr = startOptions.onStderr;
  child.stderr?.on("data", (chunk: Buffer) => {
    if (onStderr) onStderr(new Uint8Array(chunk));
    else err.push(chunk);
  });
  let failed: Error | undefined;
  child.on("error", (error) => {
    failed = error;
  });
  // git ignores SIGPIPE while it talks to the hook: a write after it exited fails instead
  child.stdin?.on("error", () => {});
  child.stdout?.on("error", () => {});
  const exited = new Promise<NodeHookOutcome>((resolve) => {
    child.on("close", (code, signal) => {
      if (failed) {
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
        stdout: new Uint8Array(),
        stderr: new Uint8Array(Buffer.concat(err)),
      });
    });
  });
  const stdout = child.stdout;
  return {
    write: (data) =>
      new Promise<void>((resolve, reject) => {
        const stdin = child.stdin;
        if (!stdin || stdin.destroyed || stdin.writableEnded || failed) {
          reject(new Error("the hook closed its stdin"));
          return;
        }
        stdin.write(Buffer.from(data), (error) => (error ? reject(error) : resolve()));
      }),
    closeStdin: async () => {
      child.stdin?.end();
    },
    stdout: {
      async *[Symbol.asyncIterator]() {
        if (!stdout) return;
        try {
          for await (const chunk of stdout) yield new Uint8Array(chunk as Buffer);
        } catch {
          // the pipe was closed
        }
      },
    },
    closeStdout: () => {
      stdout?.destroy();
    },
    wait: () => exited,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      // a child of the script may hold the pipes open: close our ends, so the exit is seen
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
  };
}

function runHook(
  invocation: NodeHookInvocation,
  options: NodeHookRunnerOptions,
): Promise<NodeHookOutcome | undefined> {
  const base = options.env ?? process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  for (const key of invocation.unsetEnv ?? []) delete env[key];
  Object.assign(env, invocation.env);
  const cwd = invocation.hostCwd ?? options.defaultCwd ?? process.cwd();
  // a configured hook: git's prepare_shell_cmd (with shell metacharacters `sh -c '<command>
  // "$@"' '<command>' args`, "$@" only when there are args; else the command run itself),
  // its stdout joined to stderr first where git sends it there
  if (invocation.command !== undefined) {
    const command = invocation.command;
    const toStderr = invocation.stdoutToStderr ? "exec 1>&2; " : "";
    if (/[|&;<>()$`\\"' \t\n*?[#~=%]/.test(command)) {
      const line = invocation.args.length > 0 ? `${command} "$@"` : command;
      return spawnHook(
        "/bin/sh",
        ["-c", `${toStderr}${line}`, command, ...invocation.args],
        cwd,
        env,
        invocation,
      );
    }
    return spawnHook(
      "/bin/sh",
      ["-c", `${toStderr}exec "$0" "$@"`, command, ...invocation.args],
      cwd,
      env,
      invocation,
    );
  }
  // the script as git names it (relative to the cwd), its argv[0]; else its host path
  const script =
    invocation.path.startsWith("/") || invocation.hostCwd ? invocation.path : invocation.hostPath;
  if (!script) return Promise.resolve(undefined);
  // the shell joins stdout to stderr ("1>&2") and runs a script without a "#!" line, as
  // git's run-command falls back to sh on ENOEXEC
  const [command, args] = invocation.stdoutToStderr
    ? ["/bin/sh", ["-c", 'exec "$0" "$@" 1>&2', script, ...invocation.args]]
    : [script, invocation.args];
  return spawnHook(command as string, args as string[], cwd, env, invocation);
}

/** Spawns a hook's process and collects its exit code and output. */
function spawnHook(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  invocation: NodeHookInvocation,
): Promise<NodeHookOutcome | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
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
      // a spawn that failed (ENOENT, EACCES) closes with a negative errno as its code, or
      // none: git's notify_start_failure either way
      if (failed) {
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
