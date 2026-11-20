/**
 * The duplex adapters' own contracts, without a repository: the bounded byte queue, the
 * webrun bridge's backpressure and half-close over a MessageChannel, the WebSocket adapter's
 * empty-frame half-close and pausing, and the libp2p adapter's `closeWrite`; then their
 * error paths: failed and stalled streams, abnormal closes, frame limits, connect timeouts.
 */

import { duplexOverPort, serveDuplexOverPort } from "@statewalker/webrun-rpc";
import { describe, expect, it } from "vitest";
import {
  connectGitOverPortMux,
  createByteQueue,
  createLibp2pConnector,
  createWebSocketConnector,
  DEFAULT_GIT_MAX_PORTS,
  DEFAULT_WEBSOCKET_FRAME_SIZE,
  DEFAULT_WEBSOCKET_MAX_FRAME_SIZE,
  type Libp2pMessageStreamLike,
  type Libp2pStreamLike,
  libp2pStreamDuplex,
  messagePortDuplex,
  parseGitUrl,
  serveGitOverLibp2pStream,
  serveGitOverPortMux,
  type WebSocketLike,
  webrunClientDuplex,
  webrunServerDuplex,
  webSocketDuplex,
} from "../src/index.js";
import { serverRepo } from "./helpers/receive-pack-harness.js";

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
    await expect(queue.push(bytes(1))).rejects.toThrow(/after the end/);
  });

  it("releases writers and refuses later pushes once the reader stops", async () => {
    const queue = createByteQueue({ highWaterMark: 4 });
    const waiting = queue.push(bytes(8));
    const reader = queue.stream[Symbol.asyncIterator]();
    await reader.next();
    await reader.return?.(undefined);
    await waiting;
    expect(queue.ended).toBe(true);
    await expect(queue.push(bytes(8))).rejects.toThrow(/reader stopped/);
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

/** One end of {@link socketPair}. */
type TestSocket = WebSocketLike & {
  paused: number;
  readyState: number;
  sent: Uint8Array[];
  listenerCount(): number;
  emit(type: string, data?: unknown, code?: number): void;
};

/** A WebSocket-like pair: what one sends, the other's listeners get (async, as a socket). */
function socketPair(): [TestSocket, TestSocket] {
  type Listener = (event: { data?: unknown; code?: number }) => void;
  const make = () => {
    const listeners = new Map<string, Listener[]>();
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      binaryType: "blob",
      paused: 0,
      sent: [] as Uint8Array[],
      peer: undefined as unknown as {
        readyState: number;
        emit(type: string, data?: unknown, code?: number): void;
      },
      send(data: Uint8Array) {
        socket.sent.push(data.slice());
        const copy = data.slice().buffer;
        setTimeout(() => socket.peer.emit("message", copy), 0);
      },
      close() {
        if (socket.readyState >= 2) return;
        socket.readyState = 3;
        setTimeout(() => {
          socket.emit("close", undefined, 1000);
          socket.peer.readyState = 3;
          socket.peer.emit("close", undefined, 1000);
        }, 1);
      },
      addEventListener(type: string, listener: Listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      removeEventListener(type: string, listener: Listener) {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((l) => l !== listener),
        );
      },
      listenerCount() {
        let n = 0;
        for (const list of listeners.values()) n += list.length;
        return n;
      },
      emit(type: string, data?: unknown, code?: number) {
        for (const l of listeners.get(type) ?? [])
          l({ data, ...(code !== undefined ? { code } : {}) });
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

describe("error paths (review of the duplex adapters)", () => {
  const never = () => new Promise<never>(() => {});
  /** A source that never yields (a peer that sends nothing). */
  async function* silent(): AsyncGenerator<Uint8Array> {
    yield await never();
  }

  it("createByteQueue: end(error) rejects the waiting writers and every later push with it", async () => {
    const queue = createByteQueue({ highWaterMark: 4 });
    const waiting = queue.push(bytes(8));
    queue.end(new Error("the stream was reset"));
    await expect(waiting).rejects.toThrow("the stream was reset");
    await expect(queue.push(bytes(1))).rejects.toThrow("the stream was reset");
    await expect(collect(queue.stream)).rejects.toThrow("the stream was reset");
  });

  it("libp2p: a sink that rejects before it pulls fails the waiting and later writes", async () => {
    const stream: Libp2pStreamLike = {
      source: silent(),
      sink: async () => {
        throw new Error("StreamStateError: the stream is closed");
      },
    };
    const duplex = libp2pStreamDuplex(stream, { highWaterMark: 4 });
    await expect(duplex.write(bytes(8))).rejects.toThrow("StreamStateError");
    await expect(duplex.write(bytes(1))).rejects.toThrow("StreamStateError");
  });

  it("libp2p: close aborts a stream whose peer stopped reading, within closeTimeout", async () => {
    const aborted: string[] = [];
    const stream: Libp2pStreamLike = {
      source: silent(),
      async sink(source) {
        await source[Symbol.asyncIterator]().next(); // one chunk, then it blocks
        await never();
      },
      abort: (error) => {
        aborted.push(error.message);
      },
      close: never, // a graceful close would wait for the peer too
    };
    const duplex = libp2pStreamDuplex(stream, { highWaterMark: 4, coalesce: 0, closeTimeout: 30 });
    await duplex.write(bytes(8)); // taken by the sink
    void duplex.write(bytes(8)); // never taken
    const started = Date.now();
    await duplex.close?.();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(aborted[0]).toMatch(/closed before the peer took its data/);
    await expect(duplex.write(bytes(1))).rejects.toThrow();
  });

  it("libp2p 3: send/onDrain to write, close for the end, abort when close hangs", async () => {
    const events: string[] = [];
    let closeHangs = false;
    const stream: Libp2pMessageStreamLike = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([1]);
        yield { subarray: () => new Uint8Array([2, 3]) };
      },
      send(data) {
        events.push(`send ${data.length}`);
        return data.length < 4;
      },
      async onDrain() {
        events.push("drain");
      },
      close() {
        events.push("close");
        return closeHangs ? never() : Promise.resolve();
      },
      abort(error) {
        events.push(`abort ${error.message}`);
      },
    };
    const duplex = libp2pStreamDuplex(stream, { closeTimeout: 30 });
    await duplex.write(bytes(2));
    await duplex.write(bytes(6));
    await duplex.end?.();
    await expect(duplex.write(bytes(1))).rejects.toThrow(/after the end/);
    expect(await collect(duplex)).toEqual([1, 2, 3]);
    await duplex.close?.();
    expect(events).toEqual(["send 2", "send 6", "drain", "close"]);

    events.length = 0;
    closeHangs = true;
    const stalled = libp2pStreamDuplex(stream, { closeTimeout: 30 });
    await stalled.close?.();
    expect(events).toEqual([
      "close",
      "abort the libp2p stream was closed before the peer took its data",
    ]);
  });

  it("libp2p 3: a send that throws (a reset stream) fails the write", async () => {
    const stream: Libp2pMessageStreamLike = {
      [Symbol.asyncIterator]: silent,
      send() {
        throw new Error("StreamStateError: the stream is reset");
      },
      close: async () => {},
      abort: () => {},
    };
    await expect(libp2pStreamDuplex(stream).write(bytes(1))).rejects.toThrow("reset");
  });

  it("serveGitConnection's timeout frees a libp2p session whose peer stopped reading", async () => {
    const { repo } = await serverRepo();
    const aborted: string[] = [];
    const request = new TextEncoder().encode("git-upload-pack /r.git\0host=h\0");
    const length = (request.length + 4).toString(16).padStart(4, "0");
    const stream: Libp2pStreamLike = {
      source: (async function* () {
        yield new Uint8Array([...new TextEncoder().encode(length), ...request]);
        await never();
      })(),
      async sink(source) {
        await source[Symbol.asyncIterator]().next();
        await never();
      },
      abort: (error) => {
        aborted.push(error.message);
      },
      close: never,
    };
    const started = Date.now();
    const result = await serveGitOverLibp2pStream(stream, {
      resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
      timeout: 100,
      highWaterMark: 1,
      coalesce: 0,
      closeTimeout: 50,
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/);
    // the close the timeout started does not wait for the peer: the stream is dropped
    for (let i = 0; i < 100 && aborted.length === 0; i++) await tick();
    expect(aborted[0]).toMatch(/closed before the peer took its data/);
  });

  it("webSocketDuplex: an abnormal close fails the read side after what arrived", async () => {
    const [a, b] = socketPair();
    const server = webSocketDuplex(b);
    a.send(bytes(3));
    await tick();
    b.readyState = 3;
    b.emit("close", undefined, 1006);
    const reader = server[Symbol.asyncIterator]();
    expect((await reader.next()).value?.length).toBe(3);
    await expect(reader.next()).rejects.toThrow(/code 1006/);

    const [c, d] = socketPair();
    const failed = webSocketDuplex(d);
    d.emit("error");
    await expect(collect(failed)).rejects.toThrow(/failed/);
    expect(c.readyState).toBe(1);
  });

  it("webSocketDuplex: writes to a closed socket, or after the end, fail", async () => {
    const [a] = socketPair();
    const client = webSocketDuplex(a);
    await client.end?.();
    await expect(client.write(bytes(1))).rejects.toThrow(/after the end/);

    const [c] = socketPair();
    const closing = webSocketDuplex(c);
    c.close();
    await expect(closing.write(bytes(1))).rejects.toThrow();
  });

  it("webSocketDuplex: frames of at most frameSize out, larger than maxFrameSize refused in", async () => {
    const [a, b] = socketPair();
    const client = webSocketDuplex(a, { frameSize: 1000 });
    const server = webSocketDuplex(b);
    await client.write(bytes(2500));
    await client.end?.();
    expect(a.sent.map((frame) => frame.length)).toEqual([1000, 1000, 500, 0]);
    expect((await collect(server)).length).toBe(2500);
    expect(DEFAULT_WEBSOCKET_FRAME_SIZE).toBeLessThanOrEqual(DEFAULT_WEBSOCKET_MAX_FRAME_SIZE);

    const [c, d] = socketPair();
    const limited = webSocketDuplex(d, { maxFrameSize: 100 });
    c.send(bytes(101));
    await expect(collect(limited)).rejects.toThrow(/exceeds the limit of 100 bytes/);
    expect(d.readyState).toBe(3);
  });

  it("webSocketDuplex: close removes the adapter's listeners", async () => {
    const [a, b] = socketPair();
    const before = b.listenerCount();
    const server = webSocketDuplex(b);
    expect(b.listenerCount()).toBeGreaterThan(before);
    await server.close?.();
    expect(b.listenerCount()).toBe(before);
    expect(a.listenerCount()).toBe(0);
  });

  it("connectors give up after connectTimeout", async () => {
    const [pending] = socketPair();
    pending.readyState = 0; // never opens
    const ws = createWebSocketConnector({ createWebSocket: () => pending, connectTimeout: 30 });
    await expect(
      ws.connect({
        url: parseGitUrl("ws://slow.example/r.git"),
        service: "git-upload-pack",
        protocolVersion: 2,
      }),
    ).rejects.toThrow(/unable to connect to ws:\/\/slow.example\/r.git: timed out/);
    expect(pending.readyState).toBe(3);
    expect(pending.listenerCount()).toBe(0);

    let signal: AbortSignal | undefined;
    const p2p = createLibp2pConnector({
      connectTimeout: 30,
      dial: (_peer, _protocol, options) => {
        signal = options.signal;
        return never();
      },
    });
    await expect(
      p2p.connect({
        url: parseGitUrl("libp2p://12D3KooWPeer/r.git"),
        service: "git-upload-pack",
        protocolVersion: 2,
      }),
    ).rejects.toThrow(/timed out/);
    expect(signal?.aborted).toBe(true);
  });

  it("webrunServerDuplex: onSettled hears a call whose output is dropped before its first pull", async () => {
    const settled: Array<[unknown, unknown]> = [];
    const handler = webrunServerDuplex(
      async (duplex) => {
        await tick();
        await duplex.write(bytes(1));
        return 42;
      },
      { onSettled: (result, error) => settled.push([result, error]) },
    );
    const output = handler((async function* () {})());
    await output.return(undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toHaveLength(1);
    expect(settled[0]?.[0]).toBeUndefined();
    expect(String(settled[0]?.[1])).toMatch(/abandoned/);

    const quiet = webrunServerDuplex(async () => 7, {
      onSettled: (result, error) => settled.push([result, error]),
    });
    void quiet((async function* () {})());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled[1]).toEqual([7, undefined]);
  });

  it("serveGitOverPortMux refuses sessions past DEFAULT_GIT_MAX_PORTS", async () => {
    expect(DEFAULT_GIT_MAX_PORTS).toBe(64);
    const channel = new MessageChannel();
    const stop = await serveGitOverPortMux(channel.port2, {
      resolveRepository: async () => undefined,
      initTimeout: 2000,
    });
    const peer = await connectGitOverPortMux(channel.port1, { maxPorts: 1000 });
    const outcomes: Array<Promise<string>> = [];
    for (let i = 0; i <= DEFAULT_GIT_MAX_PORTS; i++) {
      const output = peer.call(silent());
      outcomes.push(
        output.next().then(
          () => "answered",
          () => "refused",
        ),
      );
    }
    const first = await Promise.race(outcomes.map((o, i) => o.then((r) => `${i} ${r}`)));
    expect(first).toBe(`${DEFAULT_GIT_MAX_PORTS} refused`);
    await peer.close();
    await stop();
    channel.port1.close();
  });
});
