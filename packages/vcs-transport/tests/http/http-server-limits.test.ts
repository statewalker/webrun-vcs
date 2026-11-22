/**
 * Smart-HTTP server request handling: gzip request bodies, the request body limit (413),
 * "not our ref" for an unadvertised want, and only implemented capabilities advertised.
 */

import { describe, expect, it } from "vitest";

import {
  defaultUploadPackCapabilities,
  type HttpRequest,
  type HttpResponse,
  handleReceivePack,
  handleReceivePackInfoRefs,
  handleUploadPack,
} from "../../src/index.js";
import { encodeFlush, encodePacketLine } from "../../src/protocol/pkt-line-codec.js";
import { commitInRepo, createTransportRepo } from "../interop/helpers.js";

const decoder = new TextDecoder();

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function streamOf(bytes: Uint8Array, chunkSize = 16): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream({
    pull(controller) {
      if (pos >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(pos, pos + chunkSize));
      pos += chunkSize;
    },
  });
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = streamOf(bytes, 1024).pipeThrough(
    new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function bodyBytes(response: HttpResponse): Promise<Uint8Array> {
  if (response.body instanceof ReadableStream) {
    return new Uint8Array(await new Response(response.body).arrayBuffer());
  }
  return response.body;
}

function uploadPackRequest(wants: string[], haves: string[] = []): Uint8Array {
  return concat([
    ...wants.map((w, i) =>
      encodePacketLine(i === 0 ? `want ${w} side-band-64k ofs-delta\n` : `want ${w}\n`),
    ),
    encodeFlush(),
    ...haves.map((h) => encodePacketLine(`have ${h}\n`)),
    encodePacketLine("done\n"),
  ]);
}

function post(
  path: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
  chunkSize = 16,
): HttpRequest {
  return { method: "POST", path, query: {}, headers, body: streamOf(body, chunkSize) };
}

async function serverRepo() {
  const repo = await createTransportRepo();
  const c1 = await commitInRepo(repo, "c1", { "a.txt": "hello\n" });
  const c2 = await commitInRepo(repo, "c2", { "b.txt": "world\n" }, [c1]);
  await repo.refStore.update("refs/heads/main", c2);
  return { repo, c1, c2 };
}

describe("smart-HTTP server: request bodies", () => {
  it("accepts a gzip request body (Content-Encoding: gzip)", async () => {
    const { repo, c2 } = await serverRepo();
    const body = await gzip(uploadPackRequest([c2]));
    const response = await handleUploadPack(
      post("/repo.git/git-upload-pack", body, { "content-encoding": "gzip" }),
      repo.facade,
      repo.refStore,
    );
    expect(response.status).toBe(200);
    const text = decoder.decode(await bodyBytes(response));
    expect(text).toContain("NAK");
    expect(text).toContain("PACK");
  });

  it("answers 413 once the streamed body passes the limit", async () => {
    const { repo, c2 } = await serverRepo();
    const haves = Array.from({ length: 50 }, (_, i) => i.toString(16).padStart(40, "0"));
    const response = await handleUploadPack(
      post("/repo.git/git-upload-pack", uploadPackRequest([c2], haves)),
      repo.facade,
      repo.refStore,
      { maxRequestBodyBytes: 1024 },
    );
    expect(response.status).toBe(413);
  });

  it("answers 413 for a declared Content-Length over the limit, without reading", async () => {
    const { repo, c2 } = await serverRepo();
    const response = await handleUploadPack(
      post("/repo.git/git-upload-pack", uploadPackRequest([c2]), { "content-length": "999999" }),
      repo.facade,
      repo.refStore,
      { maxRequestBodyBytes: 1024 },
    );
    expect(response.status).toBe(413);
  });

  it("limits the inflated size of a gzip body", async () => {
    const { repo, c2 } = await serverRepo();
    const filler = Array.from({ length: 2000 }, () => encodePacketLine(`have ${"0".repeat(40)}\n`));
    const raw = concat([uploadPackRequest([c2]).slice(0, -9), ...filler, encodeFlush()]);
    const body = await gzip(raw);
    expect(body.length).toBeLessThan(4096);
    const response = await handleUploadPack(
      post("/repo.git/git-upload-pack", body, { "content-encoding": "gzip" }, 512),
      repo.facade,
      repo.refStore,
      { maxRequestBodyBytes: 8192 },
    );
    expect(response.status).toBe(413);
  });

  it("answers 415 for a content encoding it cannot undo", async () => {
    const { repo, c2 } = await serverRepo();
    const response = await handleUploadPack(
      post("/repo.git/git-upload-pack", uploadPackRequest([c2]), { "content-encoding": "br" }),
      repo.facade,
      repo.refStore,
    );
    expect(response.status).toBe(415);
  });

  it("answers 413 for a push over the limit", async () => {
    const { repo, c2 } = await serverRepo();
    const zero = "0".repeat(40);
    const body = concat([
      encodePacketLine(`${zero} ${c2} refs/heads/new\0report-status\n`),
      ...Array.from({ length: 40 }, (_, i) =>
        encodePacketLine(`${zero} ${c2} refs/heads/new-${i}\n`),
      ),
      encodeFlush(),
    ]);
    const response = await handleReceivePack(
      post("/repo.git/git-receive-pack", body, {}, 256),
      repo.facade,
      repo.refStore,
      { maxRequestBodyBytes: 1024 },
    );
    expect(response.status).toBe(413);
  });
});

describe("smart-HTTP server: wants and capabilities", () => {
  it("refuses an unadvertised want with ERR upload-pack: not our ref", async () => {
    const { repo, c1 } = await serverRepo();
    const response = await handleUploadPack(
      post("/repo.git/git-upload-pack", uploadPackRequest([c1])),
      repo.facade,
      repo.refStore,
    );
    const text = decoder.decode(await bodyBytes(response));
    expect(text).toContain(`ERR upload-pack: not our ref ${c1}`);
    expect(text).not.toContain("PACK");
  });

  it("receive-pack advertises report-status and report-status-v2, as git's", async () => {
    const { repo } = await serverRepo();
    const response = await handleReceivePackInfoRefs(repo.refStore);
    const text = decoder.decode(await bodyBytes(response));
    expect(text).toContain("report-status report-status-v2");
  });

  it("upload-pack (v0) advertises only what it implements, by policy", () => {
    const plain = defaultUploadPackCapabilities(undefined, {});
    expect(plain).not.toContain("filter");
    expect(plain).not.toContain("deepen-relative");
    expect(plain).not.toContain("deepen-since");
    expect(plain).not.toContain("allow-tip-sha1-in-want");
    expect(plain).not.toContain("allow-reachable-sha1-in-want");

    const reachable = defaultUploadPackCapabilities("REACHABLE_COMMIT", {
      getCommitInfo: () => {},
    });
    expect(reachable).toContain("allow-reachable-sha1-in-want");
    expect(reachable).not.toContain("allow-tip-sha1-in-want");
    expect(reachable).toContain("deepen-since");
    expect(reachable).toContain("deepen-not");
    expect(reachable).toContain("deepen-relative");
  });
});

/** A body source that counts the bytes pulled from it and notes whether it was cancelled. */
function trackedStream(bytes: Uint8Array, chunkSize: number) {
  const log = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (log.pulled >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(log.pulled, log.pulled + chunkSize));
        log.pulled += chunkSize;
      },
      cancel() {
        log.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, log };
}

/** `have` lines with random ids: hex text, so gzip only halves it. */
function randomHaves(count: number): Uint8Array[] {
  const random = new Uint8Array(20 * count);
  for (let i = 0; i < random.length; i += 65536) {
    crypto.getRandomValues(random.subarray(i, Math.min(i + 65536, random.length)));
  }
  const lines: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const hex = Array.from(random.subarray(i * 20, i * 20 + 20), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    lines.push(encodePacketLine(`have ${hex}\n`));
  }
  return lines;
}

describe("smart-HTTP server: request body limit stops reading", () => {
  it("stops pulling a gzip body at the limit and cancels its source", async () => {
    const { repo, c2 } = await serverRepo();
    const raw = concat([
      encodePacketLine(`want ${c2} side-band-64k\n`),
      encodeFlush(),
      ...randomHaves(100_000), // ~5 MB inflated, ~2.5 MB compressed
    ]);
    const body = await gzip(raw);
    expect(body.length).toBeGreaterThan(2 * 1024 * 1024);
    const { stream, log } = trackedStream(body, 16384);
    const limit = 64 * 1024;
    const response = await handleUploadPack(
      {
        method: "POST",
        path: "/repo.git/git-upload-pack",
        query: {},
        headers: { "content-encoding": "gzip" },
        body: stream,
      },
      repo.facade,
      repo.refStore,
      { maxRequestBodyBytes: limit },
    );
    expect(response.status).toBe(413);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log.cancelled).toBe(true);
    expect(log.pulled).toBeLessThan(4 * limit);
  });

  it("stops pulling a plain body at the limit and cancels its source", async () => {
    const { repo, c2 } = await serverRepo();
    const raw = concat([
      encodePacketLine(`want ${c2} side-band-64k\n`),
      encodeFlush(),
      ...randomHaves(20_000),
    ]);
    const { stream, log } = trackedStream(raw, 1000);
    const response = await handleUploadPack(
      { method: "POST", path: "/repo.git/git-upload-pack", query: {}, headers: {}, body: stream },
      repo.facade,
      repo.refStore,
      { maxRequestBodyBytes: 10_000 },
    );
    expect(response.status).toBe(413);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log.cancelled).toBe(true);
    expect(log.pulled).toBeLessThanOrEqual(11_000);
  });

  it("answers 413 for an upload-pack body over the limit even after a have batch", async () => {
    const { repo, c2 } = await serverRepo();
    // a first batch of haves ends in a flush: upload-pack answers it (NAK) before reading on
    const raw = concat([
      encodePacketLine(`want ${c2} side-band-64k multi_ack_detailed\n`),
      encodeFlush(),
      ...randomHaves(32),
      encodeFlush(),
      ...randomHaves(2000),
      encodePacketLine("done\n"),
    ]);
    const response = await handleUploadPack(
      post("/repo.git/git-upload-pack", raw, {}, 512),
      repo.facade,
      repo.refStore,
      { maxRequestBodyBytes: 8192 },
    );
    expect(response.status).toBe(413);
  });
});
