/**
 * git-daemon's `--access-hook` run through the host's hook runner: the program is started as
 * daemon.c's `run_access_hook` starts it (through the shell, `<hook> <service> <path>
 * <hostname> <canonical hostname> <ip> <port>`, no stdin, stderr discarded, stdout read, in
 * the repository's git directory with `REMOTE_ADDR` / `REMOTE_PORT`), and its outcome handed
 * to vcs-transport's `serveGitConnection` / `createGitDaemon`, which refuse as git-daemon does.
 *
 * @example
 * ```ts
 * const daemon = createGitDaemon({
 *   resolveRepository: createBasePathResolver({ files, basePath: "/srv/git", openRepository }),
 *   accessHook: daemonAccessHookOf(createNodeHookRunner(), "/usr/local/bin/git-access", { files }),
 *   informativeErrors: true,
 * });
 * ```
 */

import type { DaemonAccessHook } from "@statewalker/vcs-transport";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import type { HookRunner } from "@statewalker/vcs-working-tree";

/** Options of {@link daemonAccessHookOf}. */
export interface DaemonAccessHookOptions {
  /**
   * The storage the resolver found the repository in: with a root directory on the host
   * (`rootDirectory`), the hook is told the host's path and runs in the git directory there,
   * as git-daemon's hook is; without one it gets the storage's paths and the runner's
   * default directory
   */
  files?: FilesApi;
}

/** The host's path of a storage path, where the storage has a root directory. */
function hostPathOf(files: FilesApi | undefined, path: string): string | undefined {
  const root = (files as { rootDirectory?: string } | undefined)?.rootDirectory;
  if (!root) return undefined;
  const base = root.replace(/\/+$/, "");
  const rest = path.replace(/^\/+/, "");
  return rest ? `${base}/${rest}` : base || "/";
}

/**
 * An access hook running `command` (git-daemon's `--access-hook=<command>`, a shell command)
 * through `runner`; a runner that cannot start it refuses the request ("service rejected"),
 * as git-daemon does when the hook fails to start.
 */
export function daemonAccessHookOf(
  runner: HookRunner,
  command: string,
  options: DaemonAccessHookOptions = {},
): DaemonAccessHook {
  return async (request) => {
    const path = hostPathOf(options.files, request.path) ?? request.path;
    const cwd = request.gitDir ?? "";
    const hostCwd = request.gitDir !== undefined ? hostPathOf(options.files, cwd) : undefined;
    const outcome = await runner.run({
      name: "access-hook",
      path: command,
      command,
      args: [
        request.service,
        path,
        request.hostname,
        request.canonicalHostname,
        request.ipAddress,
        request.port,
      ],
      env: {
        ...(request.remoteAddress !== undefined ? { REMOTE_ADDR: request.remoteAddress } : {}),
        ...(request.remotePort !== undefined ? { REMOTE_PORT: request.remotePort } : {}),
      },
      cwd,
      ...(hostCwd !== undefined ? { hostCwd } : {}),
      stdoutToStderr: false,
    });
    return outcome && { exitCode: outcome.exitCode, stdout: outcome.stdout };
  };
}
