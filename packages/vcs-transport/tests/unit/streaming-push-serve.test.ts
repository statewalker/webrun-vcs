/**
 * Streaming on both ends of the smart HTTP transport: the push POST body is a ReadableStream
 * pulled from `exportPack` (fetch `duplex: "half"`), collected only where streams are not
 * supported; the upload-pack response streams the pack; Duplex writes apply backpressure.
 */
import { describe, expect, it } from "vitest";
import { handleUploadPack } from "../../src/adapters/http/http-server.js";
import type { Duplex } from "../../src/api/duplex.js";
import { ProtocolState } from "../../src/context/protocol-state.js";
import { createTransportApi } from "../../src/factories/transport-api-factory.js";
import { push } from "../../src/operations/push.js";
import { requestBody, supportsRequestStreams } from "../../src/utils/request-stream.js";
import { createMockRefStore, createMockRepository } from "../helpers/test-protocol.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const OID = "a".repeat(40);
const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
const advertisement = `${pkt("# service=git-receive-pack\n")}0000${pkt(
  `${"0".repeat(40)} capabilities^{}\0report-status\n`,
)}0000`;

/** A fake pack of `n` chunks; records how many were produced. */
function lazyPack(n: number) {
  const state = { produced: 0 };
  async function* pack() {
    const head = new Uint8Array(12);
    head.set(enc.encode("PACK"));
    new DataView(head.buffer).setUint32(4, 2);
    new DataView(head.buffer).setUint32(8, 7);
    state.produced++;
    yield head;
    for (let i = 1; i < n; i++) {
      state.produced++;
      yield new Uint8Array(1024).fill(i);
    }
  }
  return { state, pack };
}

describe("push: the request body streams", () => {
  it("detects streaming request bodies on this runtime (Node)", () => {
    expect(supportsRequestStreams()).toBe(true);
  });

  it("sends a ReadableStream with duplex half, pulled as the server reads it", async () => {
    const { state, pack } = lazyPack(50);
    let producedWhenPosted = -1;
    let received = 0;
    const result = await push({
      url: "http://example.test/repo.git",
      refspecs: ["refs/heads/main:refs/heads/main"],
      getLocalRef: async () => OID,
      exportPack: () => pack(),
      fetchImpl: async (request: Request) => {
        if (request.url.includes("/info/refs")) return new Response(advertisement);
        producedWhenPosted = state.produced;
        expect(request.body).toBeInstanceOf(ReadableStream);
        received = (await request.arrayBuffer()).byteLength;
        return new Response(`${pkt("unpack ok\n")}${pkt("ok refs/heads/main\n")}0000`);
      },
    });
    expect(producedWhenPosted).toBe(0); // nothing written before the request is read
    expect(state.produced).toBe(50);
    expect(result.ok).toBe(true);
    expect(result.objectCount).toBe(7);
    expect(result.bytesSent).toBe(received);
  });

  it("collects the body where streams are not supported (Firefox, Safari)", async () => {
    const { state, pack } = lazyPack(3);
    const init = await requestBody(pack(), false);
    expect(state.produced).toBe(3);
    expect(init.duplex).toBeUndefined();
    expect((init.body as Uint8Array).length).toBe(12 + 2 * 1024);
  });

  it("refuses to send objects without exportPack", async () => {
    await expect(
      push({
        url: "http://example.test/repo.git",
        refspecs: ["refs/heads/main:refs/heads/main"],
        getLocalRef: async () => OID,
        fetchImpl: async () => new Response(advertisement),
      }),
    ).rejects.toThrow(/exportPack/);
  });
});

describe("Duplex: write backpressure", () => {
  it("waits for each write's promise before writing more", async () => {
    let pending = 0;
    let maxPending = 0;
    const releases: (() => void)[] = [];
    const duplex: Duplex = {
      async *[Symbol.asyncIterator]() {},
      write() {
        pending++;
        maxPending = Math.max(maxPending, pending);
        return new Promise<void>((resolve) =>
          releases.push(() => {
            pending--;
            resolve();
          }),
        );
      },
    };
    const transport = createTransportApi(duplex, new ProtocolState());
    const chunks = (async function* () {
      for (let i = 0; i < 5; i++) yield new Uint8Array(10);
    })();
    const done = transport.writePack(chunks);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1));
      releases.shift()?.();
    }
    await done;
    expect(maxPending).toBe(1);
  });
});

describe("handleUploadPack: the response streams", () => {
  it("returns a stream body before the pack is written, and writes as it is read", async () => {
    const refStore = createMockRefStore();
    refStore._setRef("refs/heads/main", OID);
    const repository = createMockRepository();
    repository._addObject(OID);
    const { state, pack } = lazyPack(200);
    repository.exportPack = () => pack();
    const requestBody = `${pkt(`want ${OID} side-band-64k\n`)}0000${pkt("done\n")}`;
    const response = await handleUploadPack(
      {
        method: "POST",
        path: "/repo.git/git-upload-pack",
        query: {},
        headers: {},
        body: new Response(requestBody).body as ReadableStream<Uint8Array>,
      },
      repository,
      refStore,
      { requestPolicy: "ANY" },
    );
    expect(response.status).toBe(200);
    expect(response.body).toBeInstanceOf(ReadableStream);
    expect(state.produced).toBeLessThan(200);
    const text = dec.decode(await new Response(response.body).arrayBuffer());
    expect(state.produced).toBe(200);
    expect(text).toContain("PACK");
  });
});

describe("handleUploadPack: the pack follows the client's capabilities", () => {
  async function exportOptions(caps: string) {
    const refStore = createMockRefStore();
    refStore._setRef("refs/heads/main", OID);
    const repository = createMockRepository();
    repository._addObject(OID);
    let seen: unknown;
    repository.exportPack = async function* (_w, _h, options) {
      seen = options;
      yield enc.encode("PACK");
    };
    const response = await handleUploadPack(
      {
        method: "POST",
        path: "/repo.git/git-upload-pack",
        query: {},
        headers: {},
        body: new Response(`${pkt(`want ${OID} ${caps}\n`)}0000${pkt("done\n")}`)
          .body as ReadableStream<Uint8Array>,
      },
      repository,
      refStore,
      { requestPolicy: "ANY" },
    );
    await new Response(response.body).arrayBuffer();
    return seen as { thin?: boolean; ofsDelta?: boolean };
  }

  it("no thin pack and REF deltas unless the client asks for thin-pack and ofs-delta", async () => {
    expect(await exportOptions("side-band-64k")).toMatchObject({ thin: false, ofsDelta: false });
    expect(await exportOptions("side-band-64k thin-pack ofs-delta")).toMatchObject({
      thin: true,
      ofsDelta: true,
    });
  });
});

// ─── Review fixes (P2.5) ────────────────────────────────────────────────────

/** POSTs `body` to handleUploadPack; the response body as bytes (or the error reading it). */
async function uploadPack(
  body: string,
  exportPack: MockRepositoryExport,
  options: Parameters<typeof handleUploadPack>[3] = {},
): Promise<{ status: number; bytes?: Uint8Array; error?: unknown }> {
  const refStore = createMockRefStore();
  refStore._setRef("refs/heads/main", OID);
  const repository = createMockRepository();
  repository._addObject(OID);
  repository.exportPack = exportPack;
  const response = await handleUploadPack(
    {
      method: "POST",
      path: "/repo.git/git-upload-pack",
      query: {},
      headers: {},
      body: new Response(body).body as ReadableStream<Uint8Array>,
    },
    repository,
    refStore,
    { requestPolicy: "ANY", ...options },
  );
  try {
    return {
      status: response.status,
      bytes: new Uint8Array(await new Response(response.body).arrayBuffer()),
    };
  } catch (error) {
    return { status: response.status, error };
  }
}
type MockRepositoryExport = ReturnType<typeof createMockRepository>["exportPack"];

/** Position of `needle` in `bytes`, or -1. */
function indexOfBytes(bytes: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

describe("upload-pack: a first want without capabilities asks for none", () => {
  it("no thin pack, no OFS deltas and no side-band", async () => {
    let seen: { thin?: boolean; ofsDelta?: boolean } | undefined;
    const { bytes } = await uploadPack(
      `${pkt(`want ${OID}\n`)}0000${pkt("done\n")}`,
      async function* (_w, _h, options) {
        seen = options;
        yield enc.encode("PACKDATA");
      },
    );
    expect(seen).toMatchObject({ thin: false, ofsDelta: false });
    const text = dec.decode(bytes);
    // raw pack right after the NAK, no band-1 framing ("\x01PACK")
    expect(text).toBe(`${pkt("NAK\n")}PACKDATA`);
  });

  it("ignores capabilities on later wants", async () => {
    let seen: { thin?: boolean; ofsDelta?: boolean } | undefined;
    await uploadPack(
      `${pkt(`want ${OID}\n`)}${pkt(`want ${OID} thin-pack ofs-delta side-band-64k\n`)}0000${pkt("done\n")}`,
      async function* (_w, _h, options) {
        seen = options;
        yield enc.encode("PACK");
      },
    );
    expect(seen).toMatchObject({ thin: false, ofsDelta: false });
  });

  it("does not turn on what the server did not advertise", async () => {
    let seen: { thin?: boolean; ofsDelta?: boolean } | undefined;
    await uploadPack(
      `${pkt(`want ${OID} thin-pack ofs-delta\n`)}0000${pkt("done\n")}`,
      async function* (_w, _h, options) {
        seen = options;
        yield enc.encode("PACK");
      },
      { capabilities: ["multi_ack_detailed", "ofs-delta"] },
    );
    expect(seen).toMatchObject({ thin: false, ofsDelta: true });
  });
});

describe("request bodies: when to stream", () => {
  it("streams by default outside browsers only, where supported", async () => {
    const { shouldStreamRequestBody } = await import("../../src/utils/request-stream.js");
    expect(shouldStreamRequestBody(undefined, { browser: false, supported: true })).toBe(true);
    expect(shouldStreamRequestBody(undefined, { browser: false, supported: false })).toBe(false);
    // Chromium passes the feature test but refuses streamed bodies over HTTP/1.1
    expect(shouldStreamRequestBody(undefined, { browser: true, supported: true })).toBe(false);
    expect(shouldStreamRequestBody(true, { browser: true, supported: true })).toBe(true);
    expect(shouldStreamRequestBody(false, { browser: false, supported: true })).toBe(false);
  });

  it("tells a window or a worker from Node", async () => {
    const { isBrowserContext } = await import("../../src/utils/request-stream.js");
    expect(isBrowserContext()).toBe(false);
    expect(isBrowserContext({ document: {} })).toBe(true);
    class WorkerGlobalScope {}
    const worker = Object.assign(new WorkerGlobalScope(), { WorkerGlobalScope });
    expect(isBrowserContext(worker)).toBe(true);
    expect(isBrowserContext({ WorkerGlobalScope })).toBe(false);
  });

  it("retries a streamed request refused with a TypeError once, with a collected body", async () => {
    const { fetchWithRequestBody } = await import("../../src/utils/request-stream.js");
    let made = 0;
    const bodies: unknown[] = [];
    const response = await fetchWithRequestBody(
      () => {
        made++;
        return lazyPack(3).pack();
      },
      async (init) => {
        bodies.push(init.body);
        if (init.duplex === "half") {
          // the stream was started, then refused (HTTP/1.1)
          await (init.body as ReadableStream).getReader().read();
          throw new TypeError("Failed to fetch");
        }
        return new Response("ok");
      },
      true,
      true, // a browser: Chromium may read the first chunk before refusing HTTP/1.1
    );
    expect(await response.text()).toBe("ok");
    expect(made).toBe(2);
    expect(bodies[0]).toBeInstanceOf(ReadableStream);
    expect((bodies[1] as Uint8Array).length).toBe(12 + 2 * 1024);
  });

  it("does not retry when the body's source failed or the error is not a TypeError", async () => {
    const { fetchWithRequestBody } = await import("../../src/utils/request-stream.js");
    let made = 0;
    await expect(
      fetchWithRequestBody(
        () => {
          made++;
          return (async function* () {
            yield new Uint8Array(1);
            throw new Error("export failed");
          })();
        },
        async (init) => {
          await new Response(init.body).arrayBuffer().catch(() => {});
          throw new TypeError("network");
        },
        true,
      ),
    ).rejects.toThrow("export failed");
    expect(made).toBe(1);
    await expect(
      fetchWithRequestBody(
        () => lazyPack(1).pack(),
        async () => {
          throw new Error("other");
        },
        true,
      ),
    ).rejects.toThrow("other");
  });

  it("push retries a refused streamed body with a collected one and counts it once", async () => {
    let exports = 0;
    let posts = 0;
    const result = await push({
      url: "http://example.test/repo.git",
      refspecs: ["refs/heads/main:refs/heads/main"],
      getLocalRef: async () => OID,
      streamRequestBody: true,
      exportPack: () => {
        exports++;
        return lazyPack(3).pack();
      },
      fetchImpl: async (request: Request) => {
        if (request.url.includes("/info/refs")) return new Response(advertisement);
        posts++;
        if (posts === 1) {
          // refused before the body was read (Chromium over HTTP/1.1)
          throw new TypeError("Failed to fetch");
        }
        await request.arrayBuffer();
        return new Response(`${pkt("unpack ok\n")}${pkt("ok refs/heads/main\n")}0000`);
      },
    });
    expect(result.ok).toBe(true);
    expect(exports).toBe(1); // the refused attempt never read its body, so never exported
    expect(result.objectCount).toBe(7);
    expect(result.bytesSent).toBeLessThan(2 * (12 + 2 * 1024));
  });
});

describe("upload-pack: an error after the first byte reaches the client", () => {
  async function* failingPack() {
    yield enc.encode("PACK");
    throw new Error("boom");
  }

  it("v0 with side-band: ERR on band 3", async () => {
    const { bytes } = await uploadPack(
      `${pkt(`want ${OID} side-band-64k\n`)}0000${pkt("done\n")}`,
      failingPack,
    );
    expect(dec.decode(bytes)).toContain("\x03ERR Error: boom");
  });

  it("v0 without side-band: the response stream errors instead of ending", async () => {
    const result = await uploadPack(`${pkt(`want ${OID}\n`)}0000${pkt("done\n")}`, failingPack);
    expect(result.status).toBe(200);
    expect(result.bytes).toBeUndefined();
    expect(String(result.error)).toContain("boom");
  });

  async function v2Packfile(sideband: boolean) {
    const { serverV2Handlers } = await import("../../src/fsm/protocol-v2/server-v2-fsm.js");
    const { HandlerOutput } = await import("../../src/context/handler-output.js");
    const { ProcessConfiguration } = await import("../../src/context/process-config.js");
    const written: Uint8Array[] = [];
    const duplex: Duplex = {
      async *[Symbol.asyncIterator]() {},
      async write(data) {
        written.push(data);
      },
    };
    const state = new ProtocolState();
    if (sideband) state.capabilities.add("side-band-64k");
    state.wants.add(OID);
    const repository = createMockRepository();
    repository.exportPack = failingPack;
    const ctx = {
      transport: createTransportApi(duplex, state),
      repository,
      refStore: createMockRefStore(),
      state,
      output: new HandlerOutput(),
      config: new ProcessConfiguration(),
    };
    const event = await serverV2Handlers.get("SEND_PACKFILE")?.(ctx);
    const all = new Uint8Array(written.reduce((n, w) => n + w.length, 0));
    let at = 0;
    for (const w of written) {
      all.set(w, at);
      at += w.length;
    }
    return { event, text: dec.decode(all), output: ctx.output };
  }

  it("v2: ERR on band 3 of the packfile section", async () => {
    const { event, text, output } = await v2Packfile(true);
    expect(event).toBe("ERROR");
    expect(text).toContain("\x03ERR Error: boom");
    expect(output.streamBroken).toBeFalsy();
  });

  it("v2 without side-band: tells the transport to break the stream", async () => {
    const { event, output } = await v2Packfile(false);
    expect(event).toBe("ERROR");
    expect(output.streamBroken).toBe(true);
  });
});

describe("upload-pack: keep-alive while the pack is prepared", () => {
  it("sends empty band-1 packets until the first pack byte", async () => {
    const { bytes } = await uploadPack(
      `${pkt(`want ${OID} side-band-64k no-progress\n`)}0000${pkt("done\n")}`,
      async function* () {
        await new Promise((r) => setTimeout(r, 80));
        yield enc.encode("PACK");
      },
      { keepAliveMs: 10 },
    );
    const text = dec.decode(bytes);
    const firstKeepAlive = text.indexOf("0005\x01");
    expect(firstKeepAlive).toBeGreaterThan(-1);
    expect(firstKeepAlive).toBeLessThan(text.indexOf("\x01PACK"));
    expect(text.split("0005\x01").length - 1).toBeGreaterThanOrEqual(2);
    // none after the pack started
    expect(text.indexOf("0005\x01", text.indexOf("\x01PACK"))).toBe(-1);
  });

  it("sends none without side-band", async () => {
    const { bytes } = await uploadPack(
      `${pkt(`want ${OID}\n`)}0000${pkt("done\n")}`,
      async function* () {
        await new Promise((r) => setTimeout(r, 40));
        yield enc.encode("PACK");
      },
      { keepAliveMs: 5 },
    );
    expect(indexOfBytes(bytes ?? new Uint8Array(), enc.encode("0005\x01"))).toBe(-1);
  });

  it("the fetch client skips keep-alives", async () => {
    const state = new ProtocolState();
    state.capabilities.add("side-band-64k");
    const body = enc.encode(`0005\x01${pkt("\x01PACK")}0005\x010000`);
    const duplex: Duplex = {
      async *[Symbol.asyncIterator]() {
        yield body;
      },
      async write() {},
    };
    const chunks: string[] = [];
    for await (const c of createTransportApi(duplex, state).readPack()) chunks.push(dec.decode(c));
    expect(chunks).toEqual(["PACK"]);
  });
});

describe("push: OFS deltas only when the server advertised ofs-delta", () => {
  async function pushWith(caps: string) {
    let seen: { ofsDelta: boolean } | undefined;
    let commands = "";
    const advert = `${pkt("# service=git-receive-pack\n")}0000${pkt(
      `${"0".repeat(40)} capabilities^{}\0${caps}\n`,
    )}0000`;
    await push({
      url: "http://example.test/repo.git",
      refspecs: ["refs/heads/main:refs/heads/main"],
      getLocalRef: async () => OID,
      exportPack: (_w, _e, options) => {
        seen = options;
        return lazyPack(1).pack();
      },
      fetchImpl: async (request: Request) => {
        if (request.url.includes("/info/refs")) return new Response(advert);
        commands = dec.decode(await request.arrayBuffer());
        return new Response(`${pkt("unpack ok\n")}${pkt("ok refs/heads/main\n")}0000`);
      },
    });
    return { seen, commands };
  }

  it("push()", async () => {
    const without = await pushWith("report-status");
    expect(without.seen).toEqual({ ofsDelta: false });
    expect(without.commands).not.toContain("ofs-delta");
    const withOfs = await pushWith("report-status ofs-delta");
    expect(withOfs.seen).toEqual({ ofsDelta: true });
    expect(withOfs.commands).toContain("ofs-delta");
  });

  it("httpPush()", async () => {
    const { httpPush } = await import("../../src/adapters/http/http-client.js");
    for (const [caps, expected] of [
      ["report-status", false],
      ["report-status ofs-delta", true],
    ] as const) {
      let seen: { ofsDelta?: boolean } | undefined;
      const repository = createMockRepository();
      repository.exportPack = async function* (_w, _e, options) {
        seen = options;
        yield* lazyPack(1).pack();
      };
      const refStore = createMockRefStore();
      refStore._setRef("refs/heads/main", OID);
      const advert = `${pkt("# service=git-receive-pack\n")}0000${pkt(
        `${"0".repeat(40)} capabilities^{}\0${caps}\n`,
      )}0000`;
      await httpPush("http://example.test/repo.git", repository, refStore, {
        refspecs: ["refs/heads/main:refs/heads/main"],
        fetchFn: (async (url: string, init: RequestInit) => {
          if (url.includes("/info/refs")) return new Response(advert);
          await new Response(init.body).arrayBuffer();
          return new Response(`${pkt("unpack ok\n")}${pkt("ok refs/heads/main\n")}0000`);
        }) as typeof fetch,
      });
      expect(seen?.ofsDelta).toBe(expected);
    }
  });

  it("the client push FSM", async () => {
    const { clientPushHandlers } = await import("../../src/fsm/push/client-push-fsm.js");
    const { createTestContext } = await import("../helpers/test-protocol.js");
    for (const [caps, expected] of [
      [["report-status"], false],
      [["report-status", "ofs-delta"], true],
    ] as const) {
      let seen: { ofsDelta?: boolean } | undefined;
      const repository = createMockRepository();
      repository.exportPack = async function* (_w, _e, options) {
        seen = options;
        yield enc.encode("PACK");
      };
      const ctx = createTestContext({ repository });
      for (const c of caps) ctx.state.capabilities.add(c);
      (ctx.state as ProtocolState & { pushCommands?: unknown[] }).pushCommands = [
        { type: "CREATE", oldOid: "0".repeat(40), newOid: OID, refName: "refs/heads/main" },
      ];
      await clientPushHandlers.get("SEND_PACK")?.(ctx);
      expect(seen?.ofsDelta).toBe(expected);
    }
  });
});

describe("fetchWithRequestBody: when a refused streamed push may be sent again", () => {
  const refuse = (pulls: number | "all") => async (init: { body: BodyInit; duplex?: "half" }) => {
    if (init.duplex === "half") {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      if (pulls === "all") while (!(await reader.read()).done) {}
      else for (let i = 0; i < pulls; i++) await reader.read();
      throw new TypeError("fetch failed");
    }
    return new Response("ok");
  };

  it("outside browsers, a connection lost after part of the body is not retried", async () => {
    const { fetchWithRequestBody } = await import("../../src/utils/request-stream.js");
    let made = 0;
    const chunks = () => {
      made++;
      return lazyPack(3).pack();
    };
    await expect(fetchWithRequestBody(chunks, refuse(1), true, false)).rejects.toThrow(TypeError);
    expect(made).toBe(1);
  });

  it("outside browsers, a request refused before reading the body is retried", async () => {
    const { fetchWithRequestBody } = await import("../../src/utils/request-stream.js");
    let made = 0;
    const chunks = () => {
      made++;
      return lazyPack(3).pack();
    };
    const response = await fetchWithRequestBody(chunks, refuse(0), true, false);
    expect(await response.text()).toBe("ok");
    expect(made).toBe(1); // the refused attempt never started its pack (produced on first read)
  });

  it("a body read to its end is never retried (the server may have applied the push)", async () => {
    const { fetchWithRequestBody } = await import("../../src/utils/request-stream.js");
    let made = 0;
    const chunks = () => {
      made++;
      return lazyPack(3).pack();
    };
    await expect(fetchWithRequestBody(chunks, refuse("all"), true, true)).rejects.toThrow(
      TypeError,
    );
    expect(made).toBe(1);
  });
});

describe("isBrowserContext: server runtimes with worker globals", () => {
  it("is false in a Deno or Bun worker", async () => {
    const { isBrowserContext } = await import("../../src/utils/request-stream.js");
    class WorkerGlobalScope {}
    const deno = Object.assign(new WorkerGlobalScope(), { WorkerGlobalScope, Deno: {} });
    const bun = Object.assign(new WorkerGlobalScope(), { WorkerGlobalScope, Bun: {} });
    expect(isBrowserContext(deno)).toBe(false);
    expect(isBrowserContext(bun)).toBe(false);
  });
});

describe("sendPackStream: a client that goes away", () => {
  it("ends the pack source, so its readers are released", async () => {
    const { sendPackStream } = await import("../../src/fsm/fetch/index.js");
    let released = false;
    async function* pack() {
      try {
        yield new Uint8Array(4);
        yield new Uint8Array(4);
      } finally {
        released = true;
      }
    }
    const failing = {
      writeSideband: async () => {
        throw new Error("connection reset");
      },
      writePktLine: async () => {},
      writeFlush: async () => {},
    };
    const r = await sendPackStream(failing as never, pack(), { sideband: true, keepAliveMs: 0 });
    expect(r.ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(true);
  });
});
