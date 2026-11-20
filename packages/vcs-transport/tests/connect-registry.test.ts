/**
 * The transport registry and the session openers: which connector a URL resolves to, and
 * the pack protocol over each kind of session (smart HTTP through a fetch function, a native
 * stream the peer speaks first on, a native stream that wants git-daemon's request line).
 */

import { describe, expect, it } from "vitest";

import {
  createDefaultTransports,
  createFetchHandler,
  type Duplex,
  type GitConnectRequest,
  type GitTransportConnector,
  GitTransportRegistry,
  gitDaemonRequest,
  lsRefs,
  openReceivePack,
  openUploadPack,
  parseGitUrl,
  serveOverDuplex,
} from "../src/index.js";
import { serverRepo } from "./helpers/receive-pack-harness.js";

/** Two connected in-memory duplexes; `written` records what the left one wrote. */
function duplexPair(): { left: Duplex; right: Duplex; written: Uint8Array[] } {
  const make = () => {
    const queue: (Uint8Array | null)[] = [];
    let wake: (() => void) | undefined;
    return {
      push(chunk: Uint8Array | null) {
        queue.push(chunk);
        wake?.();
        wake = undefined;
      },
      async *read(): AsyncGenerator<Uint8Array> {
        while (true) {
          if (queue.length === 0) await new Promise<void>((r) => (wake = r));
          const next = queue.shift();
          if (next === null || next === undefined) return;
          yield next;
        }
      },
    };
  };
  const a = make();
  const b = make();
  const written: Uint8Array[] = [];
  let leftClosed = false;
  let rightClosed = false;
  return {
    written,
    left: {
      [Symbol.asyncIterator]: () => a.read()[Symbol.asyncIterator](),
      write: (data) => {
        written.push(data.slice());
        b.push(data.slice());
      },
      close: async () => {
        if (!leftClosed) b.push(null);
        leftClosed = true;
      },
    },
    right: {
      [Symbol.asyncIterator]: () => b.read()[Symbol.asyncIterator](),
      write: (data) => a.push(data.slice()),
      close: async () => {
        if (!rightClosed) a.push(null);
        rightClosed = true;
      },
    },
  };
}

const connector = (name: string, schemes?: string[], matches?: (s: string) => boolean) =>
  ({
    name,
    ...(schemes ? { schemes } : {}),
    ...(matches ? { matches: (url) => matches(url.raw) } : {}),
    connect: async () => {
      throw new Error("unused");
    },
  }) satisfies GitTransportConnector;

describe("GitTransportRegistry", () => {
  it("resolves by scheme (without case) or by matches, higher priority first", () => {
    const registry = createDefaultTransports();
    expect(registry.resolve("https://example.com/r.git")?.name).toBe("http");
    expect(registry.resolve("HTTP://example.com/r.git")?.name).toBe("http");
    expect(registry.resolve("ssh://h/r")).toBeUndefined();
    expect(registry.resolve("/local/path")).toBeUndefined();

    const ws = connector("ws", ["ws", "wss"]);
    registry.register(ws);
    expect(registry.resolve("wss://peer/r")?.name).toBe("ws");

    // a later registration for a scheme wins over an earlier one of equal priority
    const mine = connector("my-https", ["https"]);
    const off = registry.register(mine);
    expect(registry.resolve("https://example.com/r")?.name).toBe("my-https");
    off();
    expect(registry.resolve("https://example.com/r")?.name).toBe("http");

    // ... unless the earlier one has a higher priority
    registry.register(
      connector("pinned", undefined, (raw) => raw.includes("pinned")),
      {
        priority: 5,
      },
    );
    registry.register(connector("plain-https", ["https"]));
    expect(registry.resolve("https://pinned.example/r")?.name).toBe("pinned");
    expect(registry.resolve("https://other.example/r")?.name).toBe("plain-https");

    expect(registry.unregister("plain-https")).toBe(true);
    expect(registry.unregister("plain-https")).toBe(false);
    expect(registry.list().map((c) => c.name)).toEqual(["pinned", "ws", "http"]);
    // a clone is extended on its own
    const copy = registry.clone();
    copy.register(connector("extra", ["extra"]));
    expect(registry.resolve("extra://x/y")).toBeUndefined();
    expect(copy.resolve("extra://x/y")?.name).toBe("extra");
  });

  it("resolves <helper>::<address> by the helper name", () => {
    const registry = new GitTransportRegistry();
    registry.register(connector("p2p", ["p2p"]));
    expect(registry.resolve("p2p::peer-id/repo")?.name).toBe("p2p");
  });
});

describe("gitDaemonRequest", () => {
  const request = (url: string, service: GitConnectRequest["service"], v: 0 | 1 | 2) =>
    new TextDecoder().decode(
      gitDaemonRequest({ url: parseGitUrl(url), service, protocolVersion: v }),
    );

  it("writes git's request line: host=<host[:port]>, version after a second NUL", () => {
    expect(request("git://h.example/r.git", "git-upload-pack", 2)).toBe(
      "0035git-upload-pack /r.git\0host=h.example\0\0version=2\0",
    );
    expect(request("git://[::1]:9418/~u/r", "git-upload-pack", 0)).toBe(
      "0029git-upload-pack ~u/r\0host=[::1]:9418\0",
    );
    // receive-pack has no v2: v0, no version parameter
    expect(request("git://h/r", "git-receive-pack", 2)).toBe("001fgit-receive-pack /r\0host=h\0");
    expect(request("git://h/r", "git-receive-pack", 1)).toBe(
      "002agit-receive-pack /r\0host=h\0\0version=1\0",
    );
  });

  it("refuses a newline in the host or path", () => {
    expect(() =>
      gitDaemonRequest({
        url: parseGitUrl("git://h/r%0Ax"),
        service: "git-upload-pack",
        protocolVersion: 0,
      }),
    ).toThrow("newline is forbidden in git:// hosts and repo paths");
  });
});

describe("openUploadPack / openReceivePack", () => {
  it("speaks smart HTTP through the session's fetch function", async () => {
    const { repo, c2 } = await serverRepo();
    const handler = createFetchHandler({
      resolveRepository: async (path) =>
        path === "/repo.git" ? { repository: repo.facade, refStore: repo.refStore } : null,
    });
    const seen: string[] = [];
    const session = {
      kind: "http" as const,
      baseUrl: "http://in-process/repo.git",
      fetchImpl: async (req: Request) => {
        seen.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("x-test")}`);
        return handler(req);
      },
      headers: { "x-test": "yes" },
    };
    const request: GitConnectRequest = {
      url: parseGitUrl(session.baseUrl),
      service: "git-upload-pack",
      protocolVersion: 2,
    };
    const connection = await openUploadPack(session, request);
    try {
      expect(connection.version).toBe(2);
      const refs = await lsRefs(connection, ["refs/heads/"]);
      expect(refs.find((r) => r.name === "refs/heads/main")?.oid).toBe(c2);
    } finally {
      await connection.close();
    }
    const push = await openReceivePack(session, { ...request, service: "git-receive-pack" });
    expect(push.advertisedRefs.find((r) => r.name === "refs/heads/main")?.oid).toBe(c2);
    await push.close();
    expect(seen[0]).toBe("GET /repo.git/info/refs yes");
    expect(seen).toContain("POST /repo.git/git-upload-pack yes");
  });

  for (const handshake of ["implicit", "git-daemon"] as const) {
    it(`speaks over a native ${handshake} session`, async () => {
      const { repo, c2 } = await serverRepo();
      const { left, right, written } = duplexPair();
      const request: GitConnectRequest = {
        url: parseGitUrl("git://peer/repo.git"),
        service: "git-upload-pack",
        protocolVersion: 2,
      };
      // the "server": with git-daemon framing it reads the request line first
      const serving = (async () => {
        let duplex: Duplex = right;
        if (handshake === "git-daemon") {
          const iterator = right[Symbol.asyncIterator]();
          const first = await iterator.next();
          expect(new TextDecoder().decode(first.value)).toBe(
            "0033git-upload-pack /repo.git\0host=peer\0\0version=2\0",
          );
          duplex = { ...right, [Symbol.asyncIterator]: () => iterator };
        }
        return serveOverDuplex({
          duplex,
          repository: repo.facade,
          refStore: repo.refStore,
          service: "git-upload-pack",
          protocolVersion: "2",
        });
      })();
      const connection = await openUploadPack({ kind: "native", duplex: left, handshake }, request);
      const refs = await lsRefs(connection, ["refs/heads/"]);
      expect(refs.find((r) => r.name === "refs/heads/main")?.oid).toBe(c2);
      await connection.close();
      await serving;
      await right.close?.();
      if (handshake === "implicit") {
        expect(new TextDecoder().decode(written[0])).toMatch(/^[0-9a-f]{4}command=ls-refs/);
      }
    });
  }
});
