/**
 * `git archive --remote=<repo> [--exec=<cmd>] [<options>] <tree-ish> [<path>...]`
 * (builtin/archive.c's `run_remote_archiver`): the archive made by the remote's
 * upload-archive.
 */

import {
  type Duplex,
  gitDaemonRequest,
  type RemoteArchiveOutput,
  requestRemoteArchive,
  serveUploadArchive,
} from "@statewalker/vcs-transport";
import { GitApiError } from "../../errors/index.js";
import { RemoteConfigStore } from "../../remote-config/index.js";
import { TransportCommand } from "../../transport-command.js";
import { createDuplexPair } from "../local-transport.js";
import { withRemoteSession } from "../remote-transport.js";
import { ArchiveCommand } from "./archive-command.js";
import { uploadArchiveWriterOf } from "./upload-archive-writer.js";

/** What the in-process upload-archive may write ahead of the client. */
const LOCAL_HIGH_WATER_MARK = 1 << 20;

/** What `git archive --remote` gave. */
export interface RemoteArchiveResult {
  /** 0; 1 when the remote reported an error; 128 when the client died */
  exitCode: number;
  /**
   * The archive (git's stdout, or `-o`'s file), the `--list` lines for `--list`; empty when
   * {@link RemoteArchiveCommand.setOutput} took them
   */
  archive: Uint8Array;
  /**
   * git's stderr: the remote's messages as `remote: <line>        ` lines (`-v`'s paths, its
   * `fatal:` line), `remote: git upload-archive: archiver died with error` when it failed;
   * for a local repository also the server process's own
   * `fatal: sent error to the client: ...`, which native git prints in no fixed order
   */
  stderr: string;
}

/**
 * `git archive --remote`: `git archive`'s arguments (without `--remote`, `--exec` and
 * `--output`) sent to the remote's upload-archive, the archive it makes returned. A local
 * repository is served in process (git runs `git-upload-archive` there); git:// and ssh
 * through the command's transports; smart HTTP has no upload-archive (git's `operation not
 * supported by protocol`).
 *
 * @example
 * ```typescript
 * // git archive --remote=origin --format=zip --prefix=p/ v1.0
 * const { archive, exitCode } = await git
 *   .archiveRemote()
 *   .setRemote("origin")
 *   .addArguments("--format=zip", "--prefix=p/", "v1.0")
 *   .call();
 * ```
 */
export class RemoteArchiveCommand extends TransportCommand<RemoteArchiveResult> {
  private remote?: string;
  private exec?: string;
  private outputName?: string;
  private readonly args: string[] = [];
  private output?: (chunk: Uint8Array) => void | Promise<void>;

  /** `--remote=<repo>`: a remote's name or a URL (a path for a local repository). */
  setRemote(remote: string): this {
    this.checkCallable();
    this.remote = remote;
    return this;
  }

  /** `--exec=<cmd>`: the program the remote runs (default `git-upload-archive`). */
  setExec(exec: string): this {
    this.checkCallable();
    this.exec = exec;
    return this;
  }

  /**
   * `-o <file>`: its name's extension, read with this repository's archivers, is sent first
   * as `--format=<format>` (an explicit `--format` wins). Nothing is written.
   */
  setOutputName(name: string): this {
    this.checkCallable();
    this.outputName = name;
    return this;
  }

  /**
   * Takes the archive as it arrives, chunk by chunk (git writing its stdout or `-o`'s file),
   * instead of collecting it in {@link RemoteArchiveResult.archive}: the next chunk is read
   * once the returned promise settles, so neither end holds the archive whole. A rejection
   * is the client's death (exit 128).
   *
   * @example
   * ```typescript
   * const writer = file.getWriter();
   * const { exitCode } = await git
   *   .archiveRemote()
   *   .setRemote("origin")
   *   .addArguments("HEAD")
   *   .setOutput((chunk) => writer.write(chunk))
   *   .call();
   * ```
   */
  setOutput(output: (chunk: Uint8Array) => void | Promise<void>): this {
    this.checkCallable();
    this.output = output;
    return this;
  }

  /** `git archive`'s other arguments, as given (`--format=tar`, `-v`, `HEAD`, `--`, paths). */
  addArguments(...args: string[]): this {
    this.checkCallable();
    this.args.push(...args);
    return this;
  }

  async call(): Promise<RemoteArchiveResult> {
    this.checkCallable();
    this.setCallable(false);
    if (this.remote === undefined) {
      throw new GitApiError("fatal: no remote given: setRemote() names the repository", {
        exitCode: 129,
      });
    }
    const formatHint =
      this.outputName !== undefined
        ? new ArchiveCommand(this.workingCopy).formatFromFilename(this.outputName)
        : undefined;
    const options = {
      ...(formatHint ? { formatHint } : {}),
      ...(this.output ? { output: this.output } : {}),
    };
    const url = RemoteConfigStore.from(this.workingCopy).remoteUrlOf(this.remote);
    const remote = await this.prepareRemote(url);
    if (remote.kind === "bundle") {
      throw new GitApiError("fatal: operation not supported by protocol");
    }
    if (remote.kind === "local") {
      // git spawns git-upload-archive in the repository: ours serves it in process
      const writer = uploadArchiveWriterOf(remote.repository);
      if (!writer) throw new GitApiError("fatal: operation not supported by protocol");
      // bounded, as git's pipe to its upload-archive child: the server waits for the client
      const [client, server] = createDuplexPair({ highWaterMark: LOCAL_HIGH_WATER_MARK });
      const serving = serveUploadArchive(server, writer).finally(() => server.close?.());
      const [result, served] = await Promise.all([
        requestRemoteArchive(client, this.args, options).finally(() => client.close?.()),
        serving,
      ]);
      return served.error ? { ...result, stderr: `${result.stderr}${served.error}\n` } : result;
    }
    const sessionOptions = {
      ...this.remoteSessionOptions(),
      protocolVersion: 0 as const,
      ...(this.exec !== undefined ? { program: this.exec } : {}),
    };
    return withRemoteSession(
      remote,
      "git-upload-archive",
      sessionOptions,
      async (session, request): Promise<RemoteArchiveOutput> => {
        if (session.kind !== "native") {
          throw new GitApiError("fatal: operation not supported by protocol");
        }
        const duplex: Duplex = session.duplex;
        if (session.handshake === "git-daemon") await duplex.write(gitDaemonRequest(request));
        return requestRemoteArchive(duplex, this.args, options);
      },
    );
  }
}
