/**
 * sidebandPackStream: the pack of an upload-pack response, demultiplexed as it arrives.
 */
import { describe, expect, it } from "vitest";
import { ServerError } from "../src/protocol/errors.js";
import { encodeFlush, encodePacketLine } from "../src/protocol/pkt-line-codec.js";
import { encodeSidebandPacket } from "../src/protocol/sideband.js";
import { sidebandPackStream } from "../src/protocol/sideband-pack-stream.js";

const enc = new TextEncoder();
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
async function* split(bytes: Uint8Array, size: number) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
/** Direct comparison: `toEqual` on 200 KB takes seconds (and timed out under load). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function collect(s: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const c of s) parts.push(c);
  return concat(parts);
}

const pack = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7) & 255);
function response(extra: Uint8Array[] = []) {
  const parts: Uint8Array[] = [
    encodePacketLine("shallow 0123456789012345678901234567890123456789"),
    encodeFlush(),
    encodePacketLine("NAK"),
    encodeSidebandPacket(2, enc.encode("Counting objects\n")),
  ];
  for (let o = 0; o < pack.length; o += 65515) {
    parts.push(encodeSidebandPacket(1, pack.subarray(o, o + 65515)));
  }
  parts.push(...extra, encodeFlush());
  return concat(parts);
}

describe("sidebandPackStream", () => {
  it("yields the channel-1 bytes whatever the chunking; skips protocol lines and flushes", async () => {
    for (const size of [1, 3, 4096, 1 << 20]) {
      const progress: string[] = [];
      const got = await collect(
        sidebandPackStream(split(response(), size), { onProgress: (m) => progress.push(m) }),
      );
      expect(sameBytes(got, pack)).toBe(true);
      expect(progress).toEqual(["Counting objects\n"]);
    }
  });

  it("pulls the body only as far as the importer reads", async () => {
    const body = response();
    let pulled = 0;
    const counted = (async function* () {
      for await (const c of split(body, 1000)) {
        pulled += c.length;
        yield c;
      }
    })();
    const it = sidebandPackStream(counted)[Symbol.asyncIterator]();
    await it.next();
    expect(pulled).toBeLessThan(70_000); // one sideband packet, not the whole response
    await it.return?.();
  });

  it("a server error (channel 3) throws ServerError", async () => {
    const body = response([encodeSidebandPacket(3, enc.encode("upload-pack: boom\n"))]);
    await expect(collect(sidebandPackStream(split(body, 777)))).rejects.toThrow(ServerError);
  });

  it("a body ending inside a packet, or a bad length, throws", async () => {
    const body = response();
    await expect(
      collect(sidebandPackStream(split(body.subarray(0, body.length - 9), 512))),
    ).rejects.toThrow(/Incomplete/);
    await expect(collect(sidebandPackStream(split(enc.encode("zz00"), 4)))).rejects.toThrow(
      /Invalid packet length/,
    );
  });
});

describe("sidebandPackStream: ERR lines", () => {
  it("an ERR pkt-line (instead of the pack) throws ServerError", async () => {
    const body = concat([encodePacketLine("ERR upload-pack: not our ref deadbeef\n")]);
    const err = await collect(sidebandPackStream(split(body, 3))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect((err as Error).message).toBe("upload-pack: not our ref deadbeef");
  });
});
