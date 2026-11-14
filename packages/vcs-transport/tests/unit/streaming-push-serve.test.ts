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
