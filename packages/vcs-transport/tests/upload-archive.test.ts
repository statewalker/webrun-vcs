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
    const result = await serveUploadArchive(duplex, async (args) => {
      seen = args;
      return { exitCode: 0, stdout: enc.encode("ARCHIVE"), stderr: "a\n" };
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
      return { exitCode: 0, stdout: new Uint8Array(0), stderr: "" };
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

  it("dies on a line that is not an argument", async () => {
    const duplex = scripted([encodePacket("want x\n"), encodeFlush()]);
    await serveUploadArchive(duplex, async () => ({
      exitCode: 0,
      stdout: new Uint8Array(0),
      stderr: "",
    }));
    expect(text(duplex.written)).toContain("\x02fatal: 'argument' token or flush expected\n");
  });
});

describe("requestRemoteArchive", () => {
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
