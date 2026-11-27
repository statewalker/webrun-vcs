/**
 * upload-archive's protocol (builtin/upload-archive.c, builtin/archive.c's
 * `run_remote_archiver`) over scripted streams: the edges native twins cannot reach (more
 * than 64 arguments, a NACK, an unknown band). The exchanges with native git are in
 * vcs-commands `tests/archive-remote-native.test.ts`.
 */

import { describe, expect, it } from "vitest";
import type { Duplex } from "../src/api/duplex.js";
import { requestRemoteArchive, serveUploadArchive } from "../src/operations/upload-archive.js";
import { encodeFlush, encodePacket } from "../src/protocol/pkt-line-codec.js";
import { encodeSidebandPacket } from "../src/protocol/sideband.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A stream that yields `input` and records what is written. */
function scripted(input: Uint8Array[]): Duplex & { written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  return {
    written,
    async *[Symbol.asyncIterator]() {
      yield* input;
    },
    write(data: Uint8Array) {
      written.push(data);
    },
  };
}

const text = (chunks: Uint8Array[]) => chunks.map((c) => dec.decode(c)).join("");

describe("serveUploadArchive", () => {
  it("answers ACK and a flush, then the writer's output and stderr, then a flush", async () => {
    const duplex = scripted([
      encodePacket("argument --format=zip\n"),
      encodePacket("argument HEAD\n"),
      encodeFlush(),
    ]);
    let seen: string[] = [];
    const result = await serveUploadArchive(duplex, async (args, sink) => {
      seen = args;
      await sink.stdout(enc.encode("ARCHIVE"));
      await sink.stderr("a\n");
      return 0;
    });
    expect(result.success).toBe(true);
    expect(seen).toEqual(["--format=zip", "HEAD"]);
    expect(text(duplex.written)).toBe(
      `0008ACK\n0000${dec.decode(encodeSidebandPacket(1, enc.encode("ARCHIVE")))}` +
        `${dec.decode(encodeSidebandPacket(2, enc.encode("a\n")))}0000`,
    );
  });

  it("dies on a 65th argument (upload-archive.c's MAX_ARGS)", async () => {
    const lines = Array.from({ length: 65 }, (_, i) => encodePacket(`argument a${i}\n`));
    const duplex = scripted([...lines, encodeFlush()]);
    let ran = false;
    const result = await serveUploadArchive(duplex, async () => {
      ran = true;
      return 0;
    });
    expect(ran).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "fatal: sent error to the client: git upload-archive: archiver died with error",
    );
    const answer = text(duplex.written);
    expect(answer).toContain("\x02fatal: Too many options (>64)\n");
    expect(answer.endsWith("\x03git upload-archive: archiver died with error")).toBe(true);
  });

  it("passes non-UTF-8 argument bytes through as git path escapes", async () => {
    const client = scripted([encodePacket("ACK\n"), encodeFlush(), encodeFlush()]);
    await requestRemoteArchive(client, ["caf\udce9"]);
    const sent = client.written[0] as Uint8Array;
    expect([...sent.subarray(sent.length - 9, sent.length - 4)]).toEqual([
      0x63, 0x61, 0x66, 0xe9, 0x0a,
    ]);
    let seen: string[] = [];
    await serveUploadArchive(scripted([sent]), async (args) => {
      seen = args;
      return 0;
    });
    expect(seen).toEqual(["caf\udce9"]);
  });

  it("dies on a line that is not an argument", async () => {
    const duplex = scripted([encodePacket("want x\n"), encodeFlush()]);
    await serveUploadArchive(duplex, async () => 0);
    expect(text(duplex.written)).toContain("\x02fatal: 'argument' token or flush expected\n");
  });
});

describe("serveUploadArchive streams (statewalker/webrun-vcs#413)", () => {
  const request = () => [encodePacket("argument HEAD\n"), encodeFlush()];

  it("sends each chunk as it is written, stderr interleaved, 16 KiB per packet", async () => {
    const duplex = scripted(request());
    const big = new Uint8Array(40000).fill(0x61);
    await serveUploadArchive(duplex, async (_args, sink) => {
      await sink.stdout(enc.encode("A"));
      // already on the wire before the writer goes on
      expect(text(duplex.written)).toContain("\x01A");
      await sink.stderr("x\n");
      await sink.stdout(big);
      await sink.stderr("y\n");
      return 0;
    });
    const answer = text(duplex.written);
    const sideband = (band: number, data: Uint8Array) =>
      dec.decode(encodeSidebandPacket(band, data));
    expect(answer).toBe(
      "0008ACK\n0000" +
        sideband(1, enc.encode("A")) +
        sideband(2, enc.encode("x\n")) +
        sideband(1, big.subarray(0, 16384)) +
        sideband(1, big.subarray(16384, 32768)) +
        sideband(1, big.subarray(32768)) +
        sideband(2, enc.encode("y\n")) +
        "0000",
    );
  });

  it("waits for the stream: a writer never runs ahead of a slow client", async () => {
    let release: () => void = () => {};
    let written = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const duplex: Duplex = {
      async *[Symbol.asyncIterator]() {
        yield* request();
      },
      async write(data: Uint8Array) {
        written += data.length;
        if (written > 1 << 16) await gate;
      },
    };
    let produced = 0;
    const serving = serveUploadArchive(duplex, async (_args, sink) => {
      for (let i = 0; i < 1024; i++) {
        await sink.stdout(new Uint8Array(1 << 16));
        produced += 1 << 16;
      }
      return 0;
    });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
    // blocked on the second chunk's write: nothing more produced, nothing buffered
    expect(produced).toBeLessThanOrEqual(1 << 16);
    release();
    expect((await serving).success).toBe(true);
    expect(produced).toBe(1 << 26);
  });

  it("a writer's failure after some output: stderr, then band 3", async () => {
    const duplex = scripted(request());
    const result = await serveUploadArchive(duplex, async (_args, sink) => {
      await sink.stdout(enc.encode("PART"));
      throw new Error("boom");
    });
    expect(result.success).toBe(false);
    expect(text(duplex.written)).toBe(
      `0008ACK\n0000${dec.decode(encodeSidebandPacket(1, enc.encode("PART")))}` +
        `${dec.decode(encodeSidebandPacket(2, enc.encode("fatal: boom\n")))}` +
        `${dec.decode(encodeSidebandPacket(3, enc.encode("git upload-archive: archiver died with error")))}`,
    );
  });

  it("stops the writer once the client is gone", async () => {
    let writes = 0;
    const duplex: Duplex = {
      async *[Symbol.asyncIterator]() {
        yield* request();
      },
      write() {
        if (++writes > 2) throw new Error("EPIPE");
      },
    };
    let chunks = 0;
    const result = await serveUploadArchive(duplex, async (_args, sink) => {
      for (;;) {
        await sink.stdout(enc.encode("x"));
        chunks++;
      }
    });
    expect(result.success).toBe(false);
    expect(chunks).toBe(1);
  });
});

describe("requestRemoteArchive", () => {
  it("hands band 1 to the output as it arrives, collecting nothing", async () => {
    const seen: string[] = [];
    const duplex = scripted([
      encodePacket("ACK\n"),
      encodeFlush(),
      encodeSidebandPacket(1, enc.encode("AR")),
      encodeSidebandPacket(2, enc.encode("a\n")),
      encodeSidebandPacket(1, enc.encode("CH")),
      encodeFlush(),
    ]);
    const result = await requestRemoteArchive(duplex, ["HEAD"], {
      output: async (chunk) => {
        seen.push(dec.decode(chunk));
      },
    });
    expect(seen).toEqual(["AR", "CH"]);
    expect(result.exitCode).toBe(0);
    expect(result.archive.length).toBe(0);
    expect(result.stderr).toBe("remote: a        \n");
  });

  it("sends the format hint first, reads the archive and the remote's lines", async () => {
    const duplex = scripted([
      encodePacket("ACK\n"),
      encodeFlush(),
      encodeSidebandPacket(1, enc.encode("AR")),
      encodeSidebandPacket(2, enc.encode("a\n\nb")),
      encodeSidebandPacket(1, enc.encode("CH")),
      encodeSidebandPacket(2, enc.encode("c\n")),
      encodeFlush(),
    ]);
    const result = await requestRemoteArchive(duplex, ["HEAD"], { formatHint: "zip" });
    expect(text(duplex.written)).toBe("001aargument --format=zip\n0012argument HEAD\n0000");
    expect(result.exitCode).toBe(0);
    expect(dec.decode(result.archive)).toBe("ARCH");
    expect(result.stderr).toBe("remote: a        \nremote: \nremote: bc        \n");
  });

  it("dies on a NACK and on a missing flush, as run_remote_archiver", async () => {
    const nack = await requestRemoteArchive(scripted([encodePacket("NACK no\n")]), ["HEAD"]);
    expect(nack).toMatchObject({ exitCode: 128, stderr: "fatal: git archive: NACK no\n" });
    const err = await requestRemoteArchive(scripted([encodePacket("ERR denied")]), ["HEAD"]);
    expect(err.stderr).toBe("fatal: remote error: denied\n");
    const noFlush = await requestRemoteArchive(
      scripted([encodePacket("ACK\n"), encodePacket("x")]),
      ["HEAD"],
    );
    expect(noFlush.stderr).toBe("fatal: git archive: expected a flush\n");
  });

  it("ends with exit status 1 on a band-3 error or an unknown band", async () => {
    const died = await requestRemoteArchive(
      scripted([
        encodePacket("ACK\n"),
        encodeFlush(),
        encodeSidebandPacket(2, enc.encode("fatal: no such ref: x\n")),
        encodeSidebandPacket(3, enc.encode("git upload-archive: archiver died with error")),
      ]),
      ["x"],
    );
    expect(died.exitCode).toBe(1);
    expect(died.stderr).toBe(
      "remote: fatal: no such ref: x        \nremote: git upload-archive: archiver died with error\n",
    );
    const band = await requestRemoteArchive(
      scripted([encodePacket("ACK\n"), encodeFlush(), encodeSidebandPacket(5, enc.encode("?"))]),
      ["x"],
    );
    expect(band).toMatchObject({ exitCode: 1, stderr: "archive: protocol error: bad band #5\n" });
  });
});
