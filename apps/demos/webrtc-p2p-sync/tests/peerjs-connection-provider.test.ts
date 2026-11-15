/**
 * Tests for PeerJsConnectionProvider in isolation.
 *
 * Uses the mock PeerJS infrastructure (MockPeerConnection, MockPeerInstance, etc.)
 * extracted from the old integration test to verify the provider's bridging logic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerConnection, PeerInstance, PeerJsApi } from "../src/apis/index.js";
import { PeerJsConnectionProvider } from "../src/apis/peerjs-connection-provider.js";

// ============================================================
// Mock PeerJS Infrastructure
// ============================================================

class MockPeerConnection implements PeerConnection {
  readonly peer: string;
  open = false;
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  private port: MessagePort | null = null;
  private closed = false;
  /** Linked remote-side connection for close propagation. */
  _linkedPeer: MockPeerConnection | null = null;

  constructor(peerId: string) {
    this.peer = peerId;
  }

  setPort(port: MessagePort): void {
    this.port = port;
    port.onmessage = (event) => {
      if (!this.closed) {
        this.emit("data", event.data);
      }
    };
  }

  send(data: ArrayBuffer | Uint8Array): void {
    if (!this.port || this.closed) {
      throw new Error("Connection not open");
    }
    this.port.postMessage(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    if (this.port) {
      this.port.close();
      this.port = null;
    }
    this.emit("close");
    // Propagate close to remote side (mimics WebRTC behavior)
    if (this._linkedPeer) {
      const remote = this._linkedPeer;
      this._linkedPeer = null;
      remote._linkedPeer = null;
      setTimeout(() => remote.close(), 5);
    }
  }

  on(event: "open", handler: () => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "data", handler: (data: unknown) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  on(event: string, handler: ((...args: unknown[]) => void) | (() => void)): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)?.add(handler as (...args: unknown[]) => void);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    const handlers = [...(this.handlers.get(event) ?? [])];
    for (const h of handlers) {
      h(...args);
    }
  }

  simulateOpen(): void {
    this.open = true;
    this.emit("open");
  }
}

class MockPeerInstance implements PeerInstance {
  readonly id: string;
  open = false;
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  private _registry: MockPeerRegistry;

  constructor(id: string, registry: MockPeerRegistry) {
    this.id = id;
    this._registry = registry;
  }

  connect(
    peerId: string,
    _options?: { serialization?: string; reliable?: boolean },
  ): PeerConnection {
    const conn = new MockPeerConnection(peerId);
    this._registry.linkConnection(this.id, peerId, conn);
    return conn;
  }

  destroy(): void {
    this.open = false;
    this._registry.unregisterPeer(this.id);
    this.emit("close");
  }

  on(event: "open", handler: (id: string) => void): void;
  on(event: "connection", handler: (conn: PeerConnection) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "disconnected", handler: () => void): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  on(event: string, handler: ((...args: unknown[]) => void) | (() => void)): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)?.add(handler as (...args: unknown[]) => void);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    const handlers = [...(this.handlers.get(event) ?? [])];
    for (const h of handlers) {
      h(...args);
    }
  }

  simulateOpen(): void {
    this.open = true;
    this.emit("open", this.id);
  }

  receiveIncomingConnection(conn: MockPeerConnection): void {
    this.emit("connection", conn);
  }
}

class MockPeerRegistry {
  private peers = new Map<string, MockPeerInstance>();
  private nextId = 1;

  registerPeer(peer: MockPeerInstance): void {
    this.peers.set(peer.id, peer);
  }

  unregisterPeer(id: string): void {
    this.peers.delete(id);
  }

  generateId(): string {
    return `mock-peer-${this.nextId++}`;
  }

  linkConnection(fromPeerId: string, toPeerId: string, outgoingConn: MockPeerConnection): void {
    const targetPeer = this.peers.get(toPeerId);
    if (!targetPeer) {
      setTimeout(() => {
        outgoingConn.emit("error", new Error(`Peer ${toPeerId} not found`));
      }, 10);
      return;
    }

    const channel = new MessageChannel();
    outgoingConn.setPort(channel.port1);

    const incomingConn = new MockPeerConnection(fromPeerId);
    incomingConn.setPort(channel.port2);
    outgoingConn._linkedPeer = incomingConn;
    incomingConn._linkedPeer = outgoingConn;

    setTimeout(() => {
      targetPeer.receiveIncomingConnection(incomingConn);
      setTimeout(() => {
        outgoingConn.simulateOpen();
        incomingConn.simulateOpen();
      }, 5);
    }, 10);
  }

  reset(): void {
    for (const peer of this.peers.values()) {
      peer.destroy();
    }
    this.peers.clear();
    this.nextId = 1;
  }
}

class MockPeerJsApi implements PeerJsApi {
  private registry: MockPeerRegistry;

  constructor(registry: MockPeerRegistry) {
    this.registry = registry;
  }

  createPeer(id?: string): PeerInstance {
    const peerId = id ?? this.registry.generateId();
    const peer = new MockPeerInstance(peerId, this.registry);
    this.registry.registerPeer(peer);
    setTimeout(() => {
      peer.simulateOpen();
    }, 5);
    return peer;
  }
}

// ============================================================
// Tests
// ============================================================

async function flushPromises(iterations = 10): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("PeerJsConnectionProvider", () => {
  let registry: MockPeerRegistry;
  let peerJsApi: MockPeerJsApi;

  beforeEach(() => {
    registry = new MockPeerRegistry();
    peerJsApi = new MockPeerJsApi(registry);
  });

  afterEach(() => {
    registry.reset();
  });

  it("share() creates peer and resolves with sessionId", async () => {
    const provider = new PeerJsConnectionProvider(peerJsApi);
    const onConnection = vi.fn();

    const sessionId = await provider.share({ onConnection });

    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe("string");

    provider.disconnect();
  });

  it("connect() connects to host and resolves with MessagePort", async () => {
    const hostProvider = new PeerJsConnectionProvider(peerJsApi);
    const onConnection = vi.fn();

    const sessionId = await hostProvider.share({ onConnection });

    const guestProvider = new PeerJsConnectionProvider(peerJsApi);
    const result = await guestProvider.connect(sessionId);

    expect(result.port).toBeInstanceOf(MessagePort);
    expect(result.peerId).toBe(sessionId);

    // Wait for host to receive the connection
    await flushPromises(20);
    expect(onConnection).toHaveBeenCalledTimes(1);
    expect(onConnection.mock.calls[0][1]).toBeInstanceOf(MessagePort);

    hostProvider.disconnect();
    guestProvider.disconnect();
  });

  it("bidirectional message passing through bridge", async () => {
    const hostProvider = new PeerJsConnectionProvider(peerJsApi);
    let hostPort = null as MessagePort | null; // assigned in a callback, so keep the declared type

    const sessionId = await hostProvider.share({
      onConnection(_peerId, port) {
        hostPort = port;
      },
    });

    const guestProvider = new PeerJsConnectionProvider(peerJsApi);
    const { port: guestPort } = await guestProvider.connect(sessionId);

    // Wait for connection to establish
    await flushPromises(20);
    expect(hostPort).not.toBeNull();

    // Guest → Host
    const hostReceived: unknown[] = [];
    hostPort?.addEventListener("message", (e) => hostReceived.push(e.data));
    hostPort?.start();

    guestPort.postMessage(new Uint8Array([1, 2, 3]));
    await flushPromises(5);

    expect(hostReceived.length).toBe(1);

    // Host → Guest
    const guestReceived: unknown[] = [];
    guestPort.addEventListener("message", (e) => guestReceived.push(e.data));
    guestPort.start();

    hostPort?.postMessage(new Uint8Array([4, 5, 6]));
    await flushPromises(5);

    expect(guestReceived.length).toBe(1);

    hostProvider.disconnect();
    guestProvider.disconnect();
  });

  it("onPeerDisconnected fires on connection close", async () => {
    const hostProvider = new PeerJsConnectionProvider(peerJsApi);
    const onPeerDisconnected = vi.fn();

    const sessionId = await hostProvider.share({
      onConnection() {},
      onPeerDisconnected,
    });

    const guestProvider = new PeerJsConnectionProvider(peerJsApi);
    await guestProvider.connect(sessionId);
    await flushPromises(20);

    // Simulate guest disconnecting
    guestProvider.disconnect();
    await flushPromises(10);

    // onPeerDisconnected should have been called via the connection close event
    expect(onPeerDisconnected).toHaveBeenCalled();

    hostProvider.disconnect();
  });

  it("disconnect() destroys peer and clears bridges", async () => {
    const provider = new PeerJsConnectionProvider(peerJsApi);
    const onConnection = vi.fn();

    await provider.share({ onConnection });

    // Create a guest to establish a bridge
    const guestProvider = new PeerJsConnectionProvider(peerJsApi);
    const sessionId = onConnection.mock?.lastCall?.[0];
    if (sessionId) {
      await guestProvider.connect(sessionId);
      await flushPromises(20);
    }

    // Disconnect should not throw
    provider.disconnect();
    guestProvider.disconnect();

    // Calling disconnect again should be safe
    provider.disconnect();
  });
});
