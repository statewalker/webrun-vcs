/**
 * Node-only hooks for git's native transports in tests: `openSocket` over a TCP socket or a
 * `git daemon --inetd` spawned per connection, `exec` running git's ssh command locally (as
 * if ssh ran it on the remote), a TCP server feeding `serveGitConnection`, and the scripts
 * that let native git reach the same daemon (`GIT_PROXY_COMMAND`) and the same "ssh"
 * (`GIT_SSH_COMMAND`).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { Duplex, SshTarget } from "@statewalker/vcs-transport";

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

/** A duplex over a TCP socket: `end` sends FIN, `close` ends it and waits until it closes. */
export function socketDuplex(socket: Socket): Duplex {
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return nodeDuplex(socket, socket, {
    end: async () => {
      if (!socket.writableEnded) socket.end();
    },
    close: async () => {
      if (!socket.writableEnded) socket.end();
      const timer = setTimeout(() => socket.destroy(), 5000);
      await closed;
      clearTimeout(timer);
    },
  });
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

/** `openSocket` over a real TCP connection. */
export async function openTcpSocket(host: string, port: number): Promise<Duplex> {
  // half-open: our end() sends FIN while the answer still comes back
  const socket = connect({ port, host, allowHalfOpen: true });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socketDuplex(socket);
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

/** A TCP server on 127.0.0.1 handing each connection, as a duplex, to `serve`. */
export async function startTcpServer(
  serve: (duplex: Duplex) => Promise<unknown>,
): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  // half-open: a client's FIN (after its request) must not end our answer
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void serve(socketDuplex(socket)).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
