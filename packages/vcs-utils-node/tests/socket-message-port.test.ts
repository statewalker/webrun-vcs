/**
 * `socketMessagePort` / `connectSocketPort` / `listenSocketPorts`: sockets as MessagePorts
 * speaking webrun-rpc's stream tier. A plain `net` peer on one side (half-open, as git's
 * simple-ipc and git:// peers are), a `duplexOverPort` caller on the other.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexOverPort } from "@statewalker/webrun-rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectSocketPort, listenSocketPorts } from "../src/files/index.js";

const describeUnix = process.platform === "win32" ? describe.skip : describe;

/** The peers' sockets, destroyed after each test (a half-open one keeps its server open). */
const peerSockets = new Set<Socket>();

/** A Unix-socket server whose connections `onSocket` handles. */
function serve(path: string, onSocket: (socket: Socket) => void): Promise<Server> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    peerSockets.add(socket);
    socket.on("error", () => {});
    onSocket(socket);
  });
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

async function collect(socket: Socket): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of socket.iterator({ destroyOnReturn: false })) chunks.push(chunk);
  return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function call(port: MessagePort, input: AsyncIterable<Uint8Array> | Uint8Array[]) {
  const output = duplexOverPort(port)(input);
  port.start();
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of output) chunks.push(chunk);
    return concat(chunks);
  } finally {
    // the caller's part: its port is closed once the stream is over
    port.close();
  }
}

const text = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

describeUnix("socketMessagePort", () => {
  let dir: string;
  const servers: Server[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "socket-port-"));
  });
  afterEach(async () => {
    for (const socket of peerSockets) socket.destroy();
    peerSockets.clear();
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it("half-close: the caller's end is the peer's end of file, the peer still answers", async () => {
    const path = join(dir, "s");
    servers.push(
      await serve(path, async (socket) => {
        // reads to end of file first: only a half-close lets this answer
        const request = await collect(socket);
        socket.end(text(`got ${str(request)}`));
      }),
    );
    const port = await connectSocketPort(path);
    expect(str(await call(port, [text("hello "), text("world")]))).toBe("got hello world");
  });

  it("the peer's FIN ends the output while the caller's input is still open", async () => {
    const path = join(dir, "s");
    servers.push(
      await serve(path, (socket) => {
        socket.end(text("early"));
      }),
    );
    const port = await connectSocketPort(path);
    let release!: () => void;
    const later = new Promise<void>((r) => {
      release = r;
    });
    async function* input() {
      yield text("a");
      await later;
    }
    // the output ends at the peer's end of file, not when the input does
    expect(str(await call(port, input()))).toBe("early");
    release();
  });

  it("moves 16 MiB both ways with bounded buffers", async () => {
    const path = join(dir, "s");
    servers.push(
      await serve(path, (socket) => {
        socket.pipe(socket); // echo, with the stream's own backpressure
      }),
    );
    const size = 16 << 20;
    const chunk = 64 << 10;
    async function* input() {
      for (let at = 0; at < size; at += chunk) {
        const c = new Uint8Array(chunk);
        for (let i = 0; i < chunk; i += 4096) c[i] = (at + i) & 0xff;
        yield c;
      }
    }
    const port = await connectSocketPort(path);
    const out = await call(port, input());
    expect(out.byteLength).toBe(size);
    for (let at = 0; at < size; at += 4096) {
      if (out[at] !== (at & 0xff)) throw new Error(`byte ${at} differs`);
    }
  });

  it("a slow reader throttles the peer instead of queueing what it sends", async () => {
    const path = join(dir, "s");
    let written = 0;
    let peerDone = false;
    servers.push(
      await serve(path, async (socket) => {
        const block = new Uint8Array(64 << 10);
        for (let i = 0; i < 1024 && !socket.destroyed; i++) {
          written += block.byteLength;
          if (!socket.write(block)) await new Promise((r) => socket.once("drain", r));
        }
        peerDone = true;
        socket.end();
      }),
    );
    const port = await connectSocketPort(path);
    const output = duplexOverPort(port)([]);
    port.start();
    const first = await output.next();
    expect(first.done).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    // 64 MiB offered: without backpressure all of it would be in memory by now
    expect(peerDone).toBe(false);
    expect(written).toBeLessThan(32 << 20);
    await output.return(undefined);
  });

  it("a connection that cannot be made rejects", async () => {
    await expect(connectSocketPort(join(dir, "missing"))).rejects.toThrow(/ENOENT/);
  });

  it("an error in the caller's input destroys the socket and fails the output (TCP)", async () => {
    let peerEnded!: () => void;
    const closed = new Promise<void>((r) => {
      peerEnded = r;
    });
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      peerSockets.add(socket);
      socket.on("error", () => {});
      socket.on("end", () => peerEnded());
      socket.resume();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const address = server.address() as { port: number };
    const port = await connectSocketPort({ port: address.port });
    await expect(
      call(
        port,
        (async function* () {
          yield text("a");
          throw new Error("input failed");
        })(),
      ),
    ).rejects.toThrow();
    await closed;
  });

  it("the caller closing its port closes the socket", async () => {
    const path = join(dir, "s");
    const closed = new Promise<void>((resolve) => {
      void serve(path, (socket) => {
        socket.resume();
        socket.on("end", () => resolve());
      }).then((s) => servers.push(s));
    });
    await new Promise((r) => setTimeout(r, 20));
    const port = await connectSocketPort(path);
    port.start();
    port.close();
    await closed;
  });

  it("listenSocketPorts serves each connection as a port", async () => {
    const path = join(dir, "s");
    let gotFromClient!: (bytes: Uint8Array) => void;
    const fromClient = new Promise<Uint8Array>((r) => {
      gotFromClient = r;
    });
    const server = await listenSocketPorts(path, (port) => {
      // the serving side calls through its port too: its input goes to the client,
      // its output is what the client sent
      void call(port, [text("ready")]).then(gotFromClient);
    });
    try {
      expect(server.address).toBe(path);
      const port = await connectSocketPort(path);
      // both ends are ports: the bytes cross a real socket in between
      expect(str(await call(port, [text("x"), text("y")]))).toBe("ready");
      expect(str(await fromClient)).toBe("xy");
    } finally {
      await server.close();
    }
  });

  it("listenSocketPorts names a TCP client's address and port, none for a Unix socket", async () => {
    const peers: unknown[] = [];
    const tcp = await listenSocketPorts({ port: 0 }, (port, peer) => {
      peers.push(peer);
      void call(port, []);
    });
    const unix = await listenSocketPorts(join(dir, "u"), (port, peer) => {
      peers.push(peer);
      void call(port, []);
    });
    try {
      const { port } = tcp.address as { port: number };
      await call(await connectSocketPort({ port }), []);
      await call(await connectSocketPort(join(dir, "u")), []);
      expect(peers).toEqual([{ remoteAddress: "127.0.0.1", remotePort: expect.any(Number) }, {}]);
    } finally {
      await tcp.close();
      await unix.close();
    }
  });
});
