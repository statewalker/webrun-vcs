import { describe, expect, it } from "vitest";
import { fetch as fetchPack } from "../../src/operations/fetch.js";
import { lsRemote } from "../../src/operations/ls-remote.js";
import { push } from "../../src/operations/push.js";

const enc = new TextEncoder();
const pkt = (line: string) =>
  `${(enc.encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;

const HEAD = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";
const TEST = "b3cbd5bbd7e81436d2eee04537ea2b4c0cad4cdf";

/** An /info/refs answer laid out as GitHub sends it: service line, flush, refs, flush. */
const advertisement =
  pkt("# service=git-upload-pack\n") +
  "0000" +
  pkt(
    `${HEAD} HEAD\0multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag symref=HEAD:refs/heads/master\n`,
  ) +
  pkt(`${HEAD} refs/heads/master\n`) +
  pkt(`${TEST} refs/heads/test\n`) +
  "0000";

/** A fake server: answers /info/refs and records the upload-pack request body. */
function fakeServer() {
  const requests: string[] = [];
  const fetchImpl = async (request: Request): Promise<Response> => {
    if (request.url.endsWith("/info/refs?service=git-upload-pack"))
      return new Response(advertisement);
    requests.push(new TextDecoder().decode(await request.arrayBuffer()));
    return new Response("0008NAK\n");
  };
  return { fetchImpl, requests };
}

describe("smart-HTTP operations against a real-format advertisement", () => {
  it("lsRemote reads the first ref after the service line's flush correctly", async () => {
    const { fetchImpl } = fakeServer();
    const refs = await lsRemote("https://example.test/repo.git", { fetchImpl });
    expect(refs.get("HEAD")).toBe(HEAD);
    expect(refs.get("refs/heads/master")).toBe(HEAD);
    expect(refs.get("refs/heads/test")).toBe(TEST);
  });

  it("a fetch without haves sends wants, one flush, then done", async () => {
    const { fetchImpl, requests } = fakeServer();
    await fetchPack({ url: "https://example.test/repo.git", fetchImpl }).catch(() => {});
    const body = requests[0] ?? "";
    expect(body).toMatch(/^[0-9a-f]{4}want /);
    // A second flush before `done` ends the negotiation: the server answers NAK and sends no pack.
    expect(body).not.toContain("00000000");
    expect(body.endsWith(`0000${pkt("done\n")}`)).toBe(true);
  });
});

describe("smart-HTTP operations with a token", () => {
  const url = "https://example.test/repo.git";
  const auth = { token: "ghp_secret" };
  const tokenBasic = `Basic ${btoa("x-access-token:ghp_secret")}`;

  /** A fake server that records the Authorization header of every request. */
  function recordingServer(service: string) {
    const authorizations: (string | null)[] = [];
    const fetchImpl = async (request: Request): Promise<Response> => {
      authorizations.push(request.headers.get("Authorization"));
      if (request.url.endsWith(`/info/refs?service=${service}`))
        return new Response(advertisement.replace("git-upload-pack", service));
      return new Response("0000");
    };
    return { fetchImpl, authorizations };
  }

  it("push sends the token as the Basic auth password", async () => {
    const { fetchImpl, authorizations } = recordingServer("git-receive-pack");
    await push({
      url,
      auth,
      fetchImpl,
      refspecs: ["refs/heads/master:refs/heads/master"],
      getLocalRef: async () => TEST,
      getObjectsToPush: async function* () {},
    }).catch(() => {});
    // GET /info/refs, then POST /git-receive-pack
    expect(authorizations).toEqual([tokenBasic, tokenBasic]);
  });

  it("fetch and lsRemote send the token as the Basic auth password", async () => {
    const { fetchImpl, authorizations } = recordingServer("git-upload-pack");
    await lsRemote(url, { auth, fetchImpl });
    await fetchPack({ url, auth, fetchImpl }).catch(() => {});
    expect(authorizations).toEqual([tokenBasic, tokenBasic, tokenBasic]);
  });

  it("username and password still go as Basic auth", async () => {
    const { fetchImpl, authorizations } = recordingServer("git-upload-pack");
    await lsRemote(url, { auth: { username: "user", password: "secret" }, fetchImpl });
    expect(authorizations).toEqual([`Basic ${btoa("user:secret")}`]);
  });
});

describe("fetch: the upload-pack response", () => {
  const url = "https://example.test/repo.git";
  /** A pack of no objects: what git sends when every want is already present. */
  const emptyPack = Uint8Array.from([
    ...enc.encode("PACK"),
    0,
    0,
    0,
    2,
    0,
    0,
    0,
    0,
    ...Array.from({ length: 20 }, (_, i) => i),
  ]);
  const sideband = (channel: number, data: Uint8Array) => {
    const out = new Uint8Array(data.length + 5);
    out.set(enc.encode((data.length + 5).toString(16).padStart(4, "0")));
    out[4] = channel;
    out.set(data, 5);
    return out;
  };
  const join = (parts: (string | Uint8Array)[]) => {
    const bytes = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
    const out = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of bytes) {
      out.set(b, o);
      o += b.length;
    }
    return out;
  };
  /** Answers /info/refs, then upload-pack with `body` (a stream, to observe cancellation). */
  function server(body: () => ReadableStream<Uint8Array> | Uint8Array) {
    return async (request: Request): Promise<Response> => {
      if (request.url.endsWith("/info/refs?service=git-upload-pack"))
        return new Response(advertisement);
      await request.arrayBuffer();
      const b = body();
      return new Response(b instanceof Uint8Array ? new Blob([b]) : b);
    };
  }

  it("an ERR line instead of a pack fails the fetch", async () => {
    const fetchImpl = server(() => join([pkt("ERR upload-pack: not our ref\n")]));
    await expect(fetchPack({ url, fetchImpl })).rejects.toThrow(/not our ref/);
  });

  it("no pack after the wants fails the fetch, so no refs are written", async () => {
    const fetchImpl = server(() => join([pkt("NAK\n"), "0000"]));
    await expect(fetchPack({ url, fetchImpl })).rejects.toThrow(/no pack/);
    let called = false;
    await expect(
      fetchPack({
        url,
        fetchImpl,
        onPack: async (p) => {
          called = true;
          for await (const _ of p) {
            // nothing arrives
          }
        },
      }),
    ).rejects.toThrow(/no pack/);
    expect(called).toBe(true);
  });

  it("an empty pack (every want already present) is a success", async () => {
    const fetchImpl = server(() => join([pkt("NAK\n"), sideband(1, emptyPack), "0000"]));
    const r = await fetchPack({ url, fetchImpl });
    expect(r.packData).toEqual(emptyPack);
  });

  it("a failed import cancels the response body", async () => {
    let cancelled = false;
    const fetchImpl = server(
      () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(join([pkt("NAK\n"), sideband(1, emptyPack.subarray(0, 12))]));
          },
          cancel() {
            cancelled = true;
          },
        }),
    );
    await expect(
      fetchPack({
        url,
        fetchImpl,
        onPack: async (p) => {
          for await (const _ of p) throw new Error("corrupt pack");
        },
      }),
    ).rejects.toThrow(/corrupt pack/);
    expect(cancelled).toBe(true);
  });

  it("the timeout limits each wait for the server, not the time spent importing", async () => {
    // a server that honours the abort signal, sending the pack in two packets
    const fetchImpl = async (request: Request): Promise<Response> => {
      if (request.url.endsWith("/info/refs?service=git-upload-pack"))
        return new Response(advertisement);
      await request.arrayBuffer();
      const signal = request.signal;
      const parts = [
        join([pkt("NAK\n"), sideband(1, emptyPack.subarray(0, 12))]),
        join([sideband(1, emptyPack.subarray(12)), "0000"]),
      ];
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (signal.aborted) c.error(new DOMException("aborted", "AbortError"));
            else if (parts.length) c.enqueue(parts.shift() as Uint8Array);
            else c.close();
          },
        }),
      );
    };
    const r = await fetchPack({
      url,
      fetchImpl,
      timeout: 50,
      onPack: async (p) => {
        for await (const _ of p) await new Promise((res) => setTimeout(res, 150)); // a slow store
      },
    });
    expect(r.isEmpty).toBe(false);

    // a server that stops sending is still cut off
    const stalled = async (request: Request): Promise<Response> => {
      if (request.url.endsWith("/info/refs?service=git-upload-pack"))
        return new Response(advertisement);
      await request.arrayBuffer();
      const signal = request.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(pkt("NAK\n")));
            signal.addEventListener("abort", () =>
              c.error(new DOMException("aborted", "AbortError")),
            );
          },
        }),
      );
    };
    await expect(fetchPack({ url, fetchImpl: stalled, timeout: 50 })).rejects.toThrow(/timeout/);
  });
});

describe("readableStreamToAsyncIterable", () => {
  it("cancels the stream when iteration stops before its end", async () => {
    const { readableStreamToAsyncIterable } = await import(
      "../../src/adapters/http/http-duplex.js"
    );
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      (async () => {
        for await (const _ of readableStreamToAsyncIterable(stream)) throw new Error("consumer");
      })(),
    ).rejects.toThrow("consumer");
    expect(cancelled).toBe(true);
  });
});

describe("httpFetch: no pack after the wants", () => {
  it("fails without writing refs", async () => {
    const { httpFetch } = await import("../../src/adapters/http/http-client.js");
    const fetchFn = (async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.endsWith("/info/refs?service=git-upload-pack")) return new Response(advertisement);
      return new Response(`${pkt("NAK\n")}0000`);
    }) as typeof fetch;
    const updates: string[] = [];
    const refStore = {
      listAll: async () => new Map<string, string>(),
      update: async (name: string) => {
        updates.push(name);
      },
    };
    const repository = {
      has: async () => false,
      importPack: async (p: AsyncIterable<Uint8Array>) => {
        for await (const _ of p) {
          // nothing arrives
        }
        return { objectsImported: 0 };
      },
    };
    const r = await httpFetch(
      "https://example.test/repo.git",
      repository as never,
      refStore as never,
      { fetchFn },
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no pack/);
    expect(updates).toEqual([]);
  });
});
