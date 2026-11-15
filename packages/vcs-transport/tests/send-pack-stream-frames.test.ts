/**
 * sendPackStream frames the pack as git's upload-pack does: band-1 packets as full as the
 * side-band allows (65515 payload bytes with side-band-64k, 995 with side-band), whatever the
 * chunking of the pack source, holding at most one frame.
 */
import { describe, expect, it } from "vitest";

import { createHttpHandler } from "../src/index.js";
import type { TransportApi } from "../src/api/transport-api.js";
import {
  SIDEBAND_64K_MAX_PAYLOAD,
  SIDEBAND_MAX_PAYLOAD,
  sendPackStream,
} from "../src/fsm/fetch/send-pack-stream.js";
import { encodeDelim, encodeFlush, encodePacketLine } from "../src/protocol/pkt-line-codec.js";
import { createTransportRepo } from "./interop/helpers.js";

interface Recorded {
  band: number;
  size: number;
  bytes: Uint8Array;
}

function recordingTransport(frames: Recorded[]): TransportApi {
  return {
    writeSideband: async (band: number, data: Uint8Array) => {
      frames.push({ band, size: data.length, bytes: data.slice() });
    },
    writeFlush: async () => {},
    writePktLine: async () => {},
  } as unknown as TransportApi;
}

async function* chunks(total: number, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < total; offset += size) {
    const chunk = new Uint8Array(Math.min(size, total - offset));
    for (let i = 0; i < chunk.length; i++) chunk[i] = (offset + i) & 255;
    yield chunk;
  }
}

describe("sendPackStream: side-band frames", () => {
  it("fills band-1 frames up to 65515 bytes with side-band-64k", async () => {
    const frames: Recorded[] = [];
    const total = 300_000;
    const result = await sendPackStream(recordingTransport(frames), chunks(total, 1000), {
      sideband: true,
      keepAliveMs: 0,
    });
    expect(result).toEqual({ ok: true, bytes: total });
    expect(SIDEBAND_64K_MAX_PAYLOAD).toBe(65515);
    expect(frames.map((f) => f.size)).toEqual([65515, 65515, 65515, 65515, total - 4 * 65515]);
    // the bytes are the pack's, in order
    let offset = 0;
    for (const frame of frames) {
      for (let i = 0; i < frame.size; i++) {
        if (frame.bytes[i] !== ((offset + i) & 255)) throw new Error(`byte ${offset + i}`);
      }
      offset += frame.size;
    }
  });

  it("splits a chunk larger than a frame", async () => {
    const frames: Recorded[] = [];
    await sendPackStream(recordingTransport(frames), chunks(150_000, 150_000), {
      sideband: true,
      keepAliveMs: 0,
    });
    expect(frames.map((f) => f.size)).toEqual([65515, 65515, 150_000 - 2 * 65515]);
  });

  it("uses 995-byte frames for plain side-band (1000-byte packets)", async () => {
    const frames: Recorded[] = [];
    await sendPackStream(recordingTransport(frames), chunks(2500, 700), {
      sideband: true,
      maxPayload: SIDEBAND_MAX_PAYLOAD,
      keepAliveMs: 0,
    });
    expect(SIDEBAND_MAX_PAYLOAD).toBe(995);
    expect(frames.map((f) => f.size)).toEqual([995, 995, 510]);
  });

  it("flushes a partial frame when the source is slow (keep-alive interval)", async () => {
    const frames: Recorded[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* slow(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(10);
      await gate;
      yield new Uint8Array(20);
    }
    const sending = sendPackStream(recordingTransport(frames), slow(), {
      sideband: true,
      keepAliveMs: 20,
    });
    await new Promise((r) => setTimeout(r, 100));
    // the first 10 bytes went out while the source stalled
    expect(frames.map((f) => f.size)).toEqual([10]);
    release();
    await sending;
    expect(frames.map((f) => f.size)).toEqual([10, 20]);
  });
});

describe("sendPackStream: frames of a real multi-object pack over HTTP v2", () => {
  it("sends full 65515-byte band-1 frames, then the rest", async () => {
    const repo = await createTransportRepo();
    try {
      // incompressible blobs: the pack is larger than two frames
      const entries = [];
      for (let i = 0; i < 4; i++) {
        const content = new Uint8Array(40_000);
        crypto.getRandomValues(content);
        const id = await repo.history.blobs.store([content]);
        entries.push({ name: `blob-${i}.bin`, mode: 0o100644, id });
      }
      const tree = await repo.history.trees.store(entries);
      const ident = { name: "T", email: "t@example.com", timestamp: 1, tzOffset: "+0000" };
      const commit = await repo.history.commits.store({
        tree,
        parents: [],
        author: ident,
        committer: ident,
        message: "blobs\n",
      });
      await repo.refStore.update("refs/heads/main", commit);
      const handler = createHttpHandler({
        resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
      });
      const parts = [
        encodePacketLine("command=fetch\n"),
        encodeDelim(),
        encodePacketLine(`want ${commit}\n`),
        encodePacketLine("no-progress\n"),
        encodePacketLine("done\n"),
        encodeFlush(),
      ];
      const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) {
        body.set(p, o);
        o += p.length;
      }
      const response = await handler({
        method: "POST",
        path: "/r/git-upload-pack",
        query: {},
        headers: { "git-protocol": "version=2" },
        body: new Response(body).body as ReadableStream<Uint8Array>,
      });
      const bytes = new Uint8Array(await new Response(response.body as BodyInit).arrayBuffer());
      const sizes: number[] = [];
      let pos = 0;
      const decoder = new TextDecoder();
      while (pos + 4 <= bytes.length) {
        const len = Number.parseInt(decoder.decode(bytes.subarray(pos, pos + 4)), 16);
        if (len > 4 && bytes[pos + 4] === 1) sizes.push(len - 5);
        pos += len < 4 ? 4 : len;
      }
      const total = sizes.reduce((n, s) => n + s, 0);
      expect(total).toBeGreaterThan(2 * 65515);
      expect(sizes.length).toBe(Math.ceil(total / 65515));
      for (const size of sizes.slice(0, -1)) expect(size).toBe(65515);
    } finally {
      await repo.close();
    }
  });
});
