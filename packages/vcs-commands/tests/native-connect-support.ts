/**
 * Node-only hooks for git's native transports in tests: `openSocket` over a TCP socket or a
 * `git daemon --inetd` spawned per connection, `exec` running git's ssh command locally (as
 * if ssh ran it on the remote), a TCP server feeding `serveGitConnection`, and the scripts
 * that let native git reach the same daemon (`GIT_PROXY_COMMAND`) and the same "ssh"
 * (`GIT_SSH_COMMAND`).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  DEFAULT_PORT_DRAIN_TIMEOUT,
  type Duplex,
  messagePortDuplex,
  type SshTarget,
} from "@statewalker/vcs-transport";
import {
  connectSocketPort,
  listenSocketPorts,
  type SocketPeer,
} from "@statewalker/vcs-utils-node/files";

import { testEnv } from "./status-native-support.js";

/** A duplex over a readable and a writable Node stream (a socket, a child's stdio). */
export function nodeDuplex(
  readable: Readable,
  writable: Writable,
  hooks: { end(): Promise<void>; close(): Promise<void> },
): Duplex {
  const queue: Uint8Array[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  readable.on("data", (chunk: Buffer) => {
    queue.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    notify();
  });
  const finish = () => {
    ended = true;
    notify();
  };
  readable.on("end", finish);
  readable.on("close", finish);
  readable.on("error", finish);
  writable.on("error", () => {});
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    write(data) {
      if (writable.destroyed || writable.writableEnded) return;
      return new Promise<void>((resolve) => {
        writable.write(Buffer.from(data), () => resolve());
      });
    },
    end: hooks.end,
    close: hooks.close,
  };
}

/** A duplex over a child's stdin and stdout: `end` closes stdin, `close` waits for its exit. */
export function childDuplex(child: ChildProcessWithoutNullStreams): Duplex {
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.stderr.resume();
  return nodeDuplex(child.stdout, child.stdin, {
    end: async () => {
      if (!child.stdin.writableEnded) child.stdin.end();
    },
    close: async () => {
      if (!child.stdin.writableEnded) child.stdin.end();
      const timer = setTimeout(() => child.kill(), 10000);
      await exited;
      clearTimeout(timer);
    },
  });
}

/** The arguments of the test daemon: git-daemon serving every repository below `base`. */
export function daemonArgs(base: string, receivePack = true): string[] {
  return [
    "daemon",
    "--inetd",
    "--export-all",
    ...(receivePack ? ["--enable=receive-pack"] : []),
    `--base-path=${base}`,
    "--log-destination=stderr",
  ];
}

/**
 * `openSocket` that spawns `git daemon --inetd` for each connection (git-daemon's child, its
 * stdio the socket), recording each `host:port` asked for.
 */
export function daemonOpener(
  home: string,
  base: string,
  calls: string[] = [],
  receivePack = true,
): (host: string, port: number) => Promise<Duplex> {
  return async (host, port) => {
    calls.push(`${host}:${port}`);
    const child = spawn("git", daemonArgs(base, receivePack), { env: testEnv(home) });
    return childDuplex(child);
  };
}

/**
 * `openSocket` over a real TCP connection, through the socket adapter (vcs-utils-node's
 * `connectSocketPort`): the socket is a `MessagePort`, read and written as a duplex.
 */
export async function openTcpSocket(host: string, port: number): Promise<Duplex> {
  return messagePortDuplex(await connectSocketPort({ host, port }));
}

/**
 * A duplex over an accepted connection's port (`listenSocketPorts`), the serving side's:
 * `close` lets the far end take all of the answer before it abandons the rest.
 */
export function servedPortDuplex(port: MessagePort): Duplex {
  return messagePortDuplex(port, { drainTimeout: DEFAULT_PORT_DRAIN_TIMEOUT });
}

/** git's search path for helper programs first, as a git build run from elsewhere needs. */
function withExecPath(env: Record<string, string>): Record<string, string> {
  return env.GIT_EXEC_PATH ? { ...env, PATH: `${env.GIT_EXEC_PATH}:${env.PATH}` } : env;
}

/**
 * `exec` that runs git's ssh command with `sh -c` here, as sshd would there (the `env` git asks
 * ssh to send set), recording `<user@host:port> <command> <env>` per call.
 */
export function localSshExec(
  home: string,
  calls: string[] = [],
): (target: SshTarget, command: string, env: Record<string, string>) => Promise<Duplex> {
  return async (target, command, env) => {
    const who = `${target.user !== undefined ? `${target.user}@` : ""}${target.host}${
      target.port !== undefined ? `:${target.port}` : ""
    }`;
    calls.push(`${who} ${command} ${JSON.stringify(env)}`);
    const child = spawn("sh", ["-c", command], {
      env: withExecPath({ ...testEnv(home), ...env }),
    });
    return childDuplex(child);
  };
}

/**
 * Scripts for native git: `proxy` (GIT_PROXY_COMMAND: git:// through `git daemon --inetd` over
 * the proxy's stdio), `proxy-noreceive` (the same daemon without receive-pack), `ssh`
 * (GIT_SSH_COMMAND: runs the command, the last argument, with `sh -c` here).
 */
export function writeNativeScripts(
  dir: string,
  base: string,
): {
  proxy: string;
  proxyNoReceive: string;
  ssh: string;
} {
  const write = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const daemon = (receive: boolean) =>
    `exec git ${daemonArgs(base, receive)
      .map((a) => `'${a}'`)
      .join(" ")} 2>/dev/null`;
  return {
    proxy: write("git-proxy", daemon(true)),
    proxyNoReceive: write("git-proxy-noreceive", daemon(false)),
    ssh: write(
      "fake-ssh",
      'for last; do :; done\n[ -n "$GIT_EXEC_PATH" ] && PATH="$GIT_EXEC_PATH:$PATH"\nexec sh -c "$last"',
    ),
  };
}

/** Runs native git without blocking the event loop (an in-process server answers it). */
export function gitAsync(
  home: string,
  cwd: string,
  args: string[],
  extra: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env: testEnv(home, extra) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("latin1");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("latin1");
    });
    child.stdin.end();
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * A TCP server on 127.0.0.1 handing each connection, as a duplex, to `serve` (through the
 * socket adapter, `listenSocketPorts`); the duplex is closed once `serve` settles.
 */
export async function startTcpServer(
  serve: (duplex: Duplex, peer: SocketPeer) => Promise<unknown>,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = await listenSocketPorts({ host: "127.0.0.1", port: 0 }, (port, peer) => {
    const duplex = servedPortDuplex(port);
    void serve(duplex, peer)
      .catch(() => {})
      .finally(() => duplex.close?.());
  });
  const address = server.address;
  return {
    port: typeof address === "object" ? address.port : 0,
    close: () => server.close(),
  };
}
