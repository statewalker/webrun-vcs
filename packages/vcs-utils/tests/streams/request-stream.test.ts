import { describe, expect, it } from "vitest";
import {
  fetchWithRequestBody,
  requestBody,
  shouldStreamRequestBody,
  toReadableStream,
} from "../../src/streams/index.js";

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield new TextEncoder().encode(p);
}

describe("request-stream (shared streaming request bodies)", () => {
  it("streams outside browsers where supported, collects in browsers by default", () => {
    expect(shouldStreamRequestBody(undefined, { browser: false, supported: true })).toBe(true);
    expect(shouldStreamRequestBody(undefined, { browser: true, supported: true })).toBe(false);
    expect(shouldStreamRequestBody(true, { browser: true, supported: false })).toBe(true);
  });

  it("produces a stream body with duplex half, or one collected buffer", async () => {
    const streamed = await requestBody(chunks("ab", "cd"), true);
    expect(streamed.duplex).toBe("half");
    expect(streamed.body).toBeInstanceOf(ReadableStream);
    const collected = await requestBody(chunks("ab", "cd"), false);
    expect(collected.duplex).toBeUndefined();
    expect(new TextDecoder().decode(collected.body as Uint8Array)).toBe("abcd");
  });

  it("pulls the next chunk only when the reader asks for it", async () => {
    let produced = 0;
    async function* lazy(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 3; i++) {
        produced++;
        yield new Uint8Array([i]);
      }
    }
    const reader = toReadableStream(lazy()).getReader();
    expect(produced).toBe(0);
    await reader.read();
    expect(produced).toBe(1);
  });

  it("retries once with a collected body when a streamed send is refused before reading", async () => {
    const seen: Array<"stream" | "buffer"> = [];
    const res = await fetchWithRequestBody(
      () => chunks("x"),
      async (init) => {
        if (init.body instanceof ReadableStream) {
          seen.push("stream");
          throw new TypeError("refused");
        }
        seen.push("buffer");
        return new Response("ok");
      },
      true,
      true,
    );
    expect(await res.text()).toBe("ok");
    expect(seen).toEqual(["stream", "buffer"]);
  });
});
