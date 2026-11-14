/**
 * The peer mux runs `webrun-rpc`'s port stack over one pipe in both
 * directions: each side serves the other and calls it.
 */

import { describe, expect, it } from "vitest";
import { createPeerMux } from "../src/utils/peer-mux.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

function tagging(tag: string) {
  return async function* (input: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    for await (const chunk of input) yield encoder.encode(`${tag}:${decoder.decode(chunk)}`);
  };
}

describe("createPeerMux", () => {
  it("calls and serves over the same pipe from both ends", async () => {
    const channel = new MessageChannel();
    const a = createPeerMux(channel.port1, { side: "initiator" });
    const b = createPeerMux(channel.port2, { side: "responder" });
    const stopA = a.serve(tagging("a"));
    const stopB = b.serve(tagging("b"));

    try {
      const [fromB, fromA] = await Promise.all([
        collect(a.call([encoder.encode("x"), encoder.encode("y")])),
        collect(b.call([encoder.encode("z")])),
      ]);
      expect(fromB).toBe("b:xb:y");
      expect(fromA).toBe("a:z");

      // Stopping one side's server leaves its calls working.
      await stopA();
      expect(await collect(a.call([encoder.encode("w")]))).toBe("b:w");
    } finally {
      await stopB();
      await a.close();
      await b.close();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("fails calls once the mux is closed", async () => {
    const channel = new MessageChannel();
    const a = createPeerMux(channel.port1, { side: "initiator" });
    const b = createPeerMux(channel.port2, { side: "responder" });
    b.serve(tagging("b"));
    await a.close();
    await expect(collect(a.call([encoder.encode("x")]))).rejects.toThrow();
    await b.close();
    channel.port1.close();
    channel.port2.close();
  });
});
