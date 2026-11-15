/**
 * Test helpers: in-memory repositories, a hub that mints membership tokens, and peers connected
 * over webrun duplexes (in-process, or across a MessageChannel).
 */

import { generateSigner, mintToken, type Signer } from "@statewalker/httpeers-access/issuer";
import { createMonotonicClock } from "@statewalker/httpeers-core";
import {
  createMemoryHistoryWithOperations,
  type HistoryWithOperations,
} from "@statewalker/vcs-core";
import {
  createRepositoryFacade,
  createTransportRefStore,
  type RefStore,
  type RepositoryFacade,
} from "@statewalker/vcs-transport";
import type { WebrunDuplex } from "../src/index.js";

export interface TestRepo {
  history: HistoryWithOperations;
  facade: RepositoryFacade;
  refStore: RefStore;
  close(): Promise<void>;
}

export async function createRepo(): Promise<TestRepo> {
  const history = createMemoryHistoryWithOperations();
  await history.initialize();
  return {
    history,
    facade: createRepositoryFacade({ history }),
    refStore: createTransportRefStore(history.refs),
    close: () => history.close(),
  };
}

const ident = {
  name: "Mesh Tester",
  email: "mesh@example.com",
  timestamp: 1700000000,
  tzOffset: "+0000",
};

/** A commit of `files` (flat) on `parents`; its oid. */
export async function commit(
  repo: TestRepo,
  message: string,
  files: Record<string, string>,
  parents: string[] = [],
): Promise<string> {
  const encoder = new TextEncoder();
  const entries = [];
  for (const [name, content] of Object.entries(files)) {
    const id = await repo.history.blobs.store([encoder.encode(content)]);
    entries.push({ name, mode: 0o100644, id });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const tree = await repo.history.trees.store(entries);
  return repo.history.commits.store({
    tree,
    parents,
    author: ident,
    committer: ident,
    message: `${message}\n`,
  });
}

/** A hub: its signer and a clock shared by minting and revocation (no same-millisecond ties). */
export interface Hub {
  signer: Signer;
  issuer: string;
  now: () => number;
  token(peer: string, roles: string[], ttlMs?: number): Promise<string>;
}

export async function createHub(): Promise<Hub> {
  const signer = await generateSigner();
  const now = createMonotonicClock();
  return {
    signer,
    issuer: signer.mesh,
    now,
    token: (peer, roles, ttlMs = 60_000) => mintToken({ signer, sub: peer, roles, ttlMs, now }),
  };
}

/** The bytes of a stream of chunks, joined. */
export async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const c of source) {
    parts.push(c);
    size += c.length;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return all;
}

/** Deterministic pseudo-random bytes. */
export function prng(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed * 2654435761 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/**
 * A webrun `Duplex` call carried across a MessageChannel: each call opens its own channel, whose
 * port goes over `port`; input chunks go one way and output chunks the other.
 */
export function messagePortCaller(port: MessagePort): WebrunDuplex {
  return async function* call(input) {
    const channel = new MessageChannel();
    port.postMessage({ type: "call" }, [channel.port2]);
    const local = channel.port1;
    const queue: { chunk?: Uint8Array; end?: boolean; error?: string }[] = [];
    let wake = () => {};
    local.onmessage = (event: MessageEvent) => {
      queue.push(event.data);
      wake();
    };
    void (async () => {
      try {
        for await (const chunk of input) local.postMessage({ chunk });
        local.postMessage({ end: true });
      } catch (e) {
        local.postMessage({ error: String(e) });
      }
    })();
    try {
      for (;;) {
        const next = queue.shift();
        if (!next) {
          await new Promise<void>((r) => {
            wake = r;
          });
          continue;
        }
        if (next.error) throw new Error(next.error);
        if (next.end) return;
        if (next.chunk) yield next.chunk;
      }
    } finally {
      local.close();
    }
  };
}

/** Serves `handler` (a webrun `Duplex`) for every call arriving on `port`. */
export function messagePortServe(port: MessagePort, handler: WebrunDuplex): void {
  port.onmessage = (event: MessageEvent) => {
    const remote = event.ports[0];
    if (!remote) return;
    const queue: { chunk?: Uint8Array; end?: boolean; error?: string }[] = [];
    let wake = () => {};
    remote.onmessage = (e: MessageEvent) => {
      queue.push(e.data);
      wake();
    };
    async function* input(): AsyncGenerator<Uint8Array> {
      for (;;) {
        const next = queue.shift();
        if (!next) {
          await new Promise<void>((r) => {
            wake = r;
          });
          continue;
        }
        if (next.error) throw new Error(next.error);
        if (next.end) return;
        if (next.chunk) yield next.chunk;
      }
    }
    void (async () => {
      try {
        for await (const chunk of handler(input())) remote.postMessage({ chunk });
        remote.postMessage({ end: true });
      } catch (e) {
        remote.postMessage({ error: String(e) });
      } finally {
        setTimeout(() => remote.close(), 0);
      }
    })();
  };
}
