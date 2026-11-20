/**
 * The duplex adapters' own contracts, without a repository: the bounded byte queue, the
 * webrun bridge's backpressure and half-close over a MessageChannel, the WebSocket adapter's
 * empty-frame half-close and pausing, and the libp2p adapter's `closeWrite`.
 */

import { duplexOverPort, serveDuplexOverPort } from "@statewalker/webrun-rpc";
import { describe, expect, it } from "vitest";
import {
  createByteQueue,
  createLibp2pConnector,
  createWebSocketConnector,
  type Libp2pStreamLike,
  libp2pStreamDuplex,
  messagePortDuplex,
  parseGitUrl,
  type WebSocketLike,
  webrunClientDuplex,
  webrunServerDuplex,
  webSocketDuplex,
} from "../src/index.js";

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const chunk of iterable) out.push(...chunk);
  return out;
}

describe("createByteQueue", () => {
  it("makes push wait at the high water mark until the reader drains it", async () => {
    const queue = createByteQueue({ highWaterMark: 10, coalesce: 0 });
    expect(queue.push(bytes(4))).toBeUndefined();
    const waiting = queue.push(bytes(8));
    expect(waiting).toBeInstanceOf(Promise);
    let released = false;
    void waiting?.then(() => {
      released = true;
    });
    await tick();
    expect(released).toBe(false);
    const reader = queue.stream[Symbol.asyncIterator]();
    expect((await reader.next()).value?.length).toBe(4);
    await tick();
    expect(released).toBe(true); // 8 bytes left: below the mark
  });

  it("releases writers below the mark, coalesces small chunks and ends after the queue", async () => {
    const queue = createByteQueue({ highWaterMark: 10, coalesce: 6 });
    queue.push(bytes(2, 1));
    queue.push(bytes(3, 2));
    const waiting = queue.push(bytes(6, 3));
    queue.end();
    const reader = queue.stream[Symbol.asyncIterator]();
    expect(Array.from((await reader.next()).value as Uint8Array)).toEqual([1, 1, 2, 2, 2]);
    await waiting;
    expect((await reader.next()).value?.length).toBe(6);
    expect((await reader.next()).done).toBe(true);
    expect(queue.push(bytes(1))).toBeUndefined();
  });

  it("releases writers and drops later pushes once the reader stops", async () => {
    const queue = createByteQueue({ highWaterMark: 4 });
    const waiting = queue.push(bytes(8));
    const reader = queue.stream[Symbol.asyncIterator]();
    await reader.next();
    await reader.return?.(undefined);
    await waiting;
    expect(queue.ended).toBe(true);
    expect(queue.push(bytes(8))).toBeUndefined();
  });
});

describe("webrun bridge over a MessageChannel", () => {
  it("ends the server's input on Duplex.end while its answer goes on", async () => {
    const channel = new MessageChannel();
    const events: string[] = [];
    serveDuplexOverPort(
      channel.port2,
      webrunServerDuplex(async (duplex) => {
        let n = 0;
        for await (const chunk of duplex) n += chunk.length;
        events.push(`input ended after ${n}`);
        await duplex.write(new TextEncoder().encode(`got ${n}`));
        await duplex.close?.();
      }),
    );
    const client = messagePortDuplex(channel.port1);
    await client.write(bytes(1000));
    await client.write(bytes(234));
    await client.end?.();
    const answer = new TextDecoder().decode(new Uint8Array(await collect(client)));
    expect(answer).toBe("got 1234");
    expect(events).toEqual(["input ended after 1234"]);
    await client.close?.();
  });

  it("holds the writer back while the peer does not read", async () => {
    const channel = new MessageChannel();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let received = 0;
    serveDuplexOverPort(channel.port2, async function* (input) {
      await gate;
      for await (const chunk of input) received += chunk.length;
      yield new Uint8Array([1]);
    });
    const client = webrunClientDuplex(duplexOverPort(channel.port1), {
      highWaterMark: 64 * 1024,
    });
    let written = 0;
    let blocked = false;
    for (let i = 0; i < 64; i++) {
      const pending = client.write(bytes(16 * 1024));
      written += 16 * 1024;
      if (pending) {
        const settled = await Promise.race([pending.then(() => true), tick().then(() => false)]);
        if (!settled) {
          blocked = true;
          break;
        }
      }
    }
    expect(blocked).toBe(true);
    expect(written).toBeLessThanOrEqual(256 * 1024);
    release();
    await client.end?.();
    expect(await collect(client)).toEqual([1]);
    expect(received).toBeGreaterThanOrEqual(64 * 1024);
  });
});

/** A WebSocket-like pair: what one sends, the other's listeners get (async, as a socket). */
function socketPair(): [WebSocketLike & { paused: number }, WebSocketLike & { paused: number }] {
  type Listener = (event: { data?: unknown }) => void;
  const make = () => {
    const listeners = new Map<string, Listener[]>();
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      binaryType: "blob",
      paused: 0,
      peer: undefined as unknown as {
        readyState: number;
        emit(type: string, data?: unknown): void;
      },
      send(data: Uint8Array) {
        const copy = data.slice().buffer;
        setTimeout(() => socket.peer.emit("message", copy), 0);
      },
      close() {
        if (socket.readyState >= 2) return;
        socket.readyState = 3;
        setTimeout(() => {
          socket.emit("close");
          socket.peer.readyState = 3;
          socket.peer.emit("close");
        }, 1);
      },
      addEventListener(type: string, listener: Listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      emit(type: string, data?: unknown) {
        for (const l of listeners.get(type) ?? []) l({ data });
      },
      pause() {
        socket.paused++;
      },
      resume() {},
    };
    return socket;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe("webSocketDuplex", () => {
  it("carries binary frames, an empty frame for end, and closes the socket", async () => {
    const [a, b] = socketPair();
    const client = webSocketDuplex(a);
    const server = webSocketDuplex(b);
    expect(a.binaryType).toBe("arraybuffer");
    await client.write(new Uint8Array([1, 2]));
    await client.write(new Uint8Array(0)); // never sent: an empty frame means the end
    await client.write(new Uint8Array([3]));
    await client.end?.();
    expect(await collect(server)).toEqual([1, 2, 3]);
    await server.write(new Uint8Array([9]));
    await server.close?.();
    expect(await collect(client)).toEqual([9]);
    expect(b.readyState).toBe(3); // the server closed its socket; the client read to its end frame
  });

  it("pauses a socket that can pause while its reader lags", async () => {
    const [a, b] = socketPair();
    const server = webSocketDuplex(b, { receiveHighWaterMark: 1000 });
    for (let i = 0; i < 4; i++) a.send(bytes(600));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(b.paused).toBe(1);
    a.close();
    expect((await collect(server)).length).toBe(2400);
  });

  it("the connector opens a socket per session to the URL, the request line written by the session", async () => {
    const opened: string[] = [];
    const connector = createWebSocketConnector({
      createWebSocket: (url) => {
        opened.push(url);
        return socketPair()[0];
      },
    });
    const session = await connector.connect({
      url: parseGitUrl("wss://git.example.com/r.git"),
      service: "git-upload-pack",
      protocolVersion: 2,
    });
    expect(opened).toEqual(["wss://git.example.com/r.git"]);
    expect(session.kind === "native" && session.handshake).toBe("git-daemon");
  });
});

describe("libp2pStreamDuplex", () => {
  it("reads list-like chunks, writes through the sink, ends with closeWrite", async () => {
    const sunk: number[] = [];
    let writeClosed = false;
    let closed = false;
    const stream: Libp2pStreamLike = {
      source: (async function* () {
        yield new Uint8Array([1, 2]);
        yield { subarray: () => new Uint8Array([3]) };
      })(),
      async sink(source) {
        for await (const chunk of source) sunk.push(...chunk);
      },
      closeWrite: () => {
        writeClosed = true;
      },
      close: () => {
        closed = true;
      },
    };
    const duplex = libp2pStreamDuplex(stream);
    await duplex.write(new Uint8Array([7, 8]));
    await duplex.end?.();
    expect(await collect(duplex)).toEqual([1, 2, 3]);
    await duplex.close?.();
    expect(sunk).toEqual([7, 8]);
    expect(writeClosed).toBe(true);
    expect(closed).toBe(true);
  });

  it("the connector dials the URL's peer with /git/1.0.0", async () => {
    const dialed: string[] = [];
    const connector = createLibp2pConnector({
      dial: async (peer, protocol) => {
        dialed.push(`${peer} ${protocol}`);
        return { source: (async function* () {})(), sink: async () => {} };
      },
    });
    const session = await connector.connect({
      url: parseGitUrl("libp2p://12D3KooWPeer/r.git"),
      service: "git-receive-pack",
      protocolVersion: 0,
    });
    expect(dialed).toEqual(["12D3KooWPeer /git/1.0.0"]);
    expect(session.kind === "native" && session.handshake).toBe("git-daemon");
  });
});
