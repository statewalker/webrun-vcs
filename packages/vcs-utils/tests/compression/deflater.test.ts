import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createDeflater, deflateSync } from "../../src/compression/index.js";

/** Bytes that compress somewhat: text runs mixed with pseudo-random noise. */
function sample(size: number): Uint8Array {
  const out = new Uint8Array(size);
  let next = 7;
  for (let i = 0; i < size; i++) {
    next = (Math.imul(next, 1103515245) + 12345) >>> 0;
    out[i] = i % 1000 < 600 ? 97 + ((i >> 3) % 26) : (next >>> 16) & 0xff;
  }
  return out;
}

function chunked(data: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += size) out.push(data.subarray(at, at + size));
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

describe("createDeflater", () => {
  const data = sample(700_000);
  for (const format of ["raw", "zlib", "gzip"] as const) {
    for (const level of [-1, 1, 6, 9]) {
      it(`writes deflateSync's bytes whatever the chunks (${format}, level ${level})`, () => {
        const whole = deflateSync([data], { format, level });
        for (const size of [1, 4093, 65536, 700_000]) {
          const deflater = createDeflater({ format, level });
          const out: Uint8Array[] = [];
          for (const chunk of chunked(data, size === 1 ? 997 : size))
            out.push(...deflater.push(chunk));
          out.push(...deflater.finish());
          const bytes = concat(out);
          expect(bytes.length).toBe(whole.length);
          expect(Buffer.from(bytes).equals(Buffer.from(whole))).toBe(true);
        }
      });
    }
  }

  it("level 0 inflates back to the input", () => {
    const deflater = createDeflater({ format: "raw", level: 0 });
    const out: Uint8Array[] = [];
    for (const chunk of chunked(data, 10_000)) out.push(...deflater.push(chunk));
    out.push(...deflater.finish());
    expect(Buffer.from(inflateRawSync(concat(out))).equals(Buffer.from(data))).toBe(true);
  });

  it("an empty input is deflateSync's empty stream", () => {
    const deflater = createDeflater({ format: "raw" });
    expect(Buffer.from(concat(deflater.finish()))).toEqual(
      Buffer.from(deflateSync([new Uint8Array(0)], { format: "raw" })),
    );
  });
});
