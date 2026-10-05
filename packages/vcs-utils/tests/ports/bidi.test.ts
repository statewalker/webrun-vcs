/**
 * Tests for callBidi and listenBidi functions.
 */

import { describe, expect, it } from "vitest";
import { callBidi, listenBidi } from "../../src/ports/index.js";

function newMessageChannel() {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  return channel;
}

describe("listenBidi / callBidi", () => {
  it("should handle input sync streams and return back modified values", async () => {
    const channel = newMessageChannel();
    let receivedParams: unknown;

    const close = listenBidi<string, string, { foo: string }>(
      channel.port1,
      async function* read(input, params) {
        receivedParams = params;
        for await (const value of input) {
          yield value.toUpperCase();
        }
      },
    );

    try {
      const values: string[] = [];
      for await (const value of callBidi<string, string, { foo: string }>(
        channel.port2,
        ["Hello", "World"],
        { foo: "Bar" },
      )) {
        values.push(value);
      }
      expect(values).toEqual(["HELLO", "WORLD"]);
      expect(receivedParams).toBeDefined();
      expect(typeof receivedParams).toBe("object");

      const params = receivedParams as { channelName?: string; foo?: string };
      expect(params.channelName).toBeTruthy();
      expect(params.foo).toBe("Bar");
    } finally {
      close();
    }
  });

  it("should accept calls that pass the acceptor function", async () => {
    const channel = newMessageChannel();
    let handlerCallCount = 0;

    const close = listenBidi<string, string, { allowed: boolean }>(
      channel.port1,
      async function* read(input) {
        handlerCallCount++;
        for await (const value of input) {
          yield value;
        }
      },
      (params) => params.allowed === true,
    );

    try {
      // This should be accepted
      const values: string[] = [];
      for await (const value of callBidi<string, string, { allowed: boolean }>(
        channel.port2,
        ["Hello"],
        { allowed: true },
      )) {
        values.push(value);
      }

      expect(handlerCallCount).toBe(1);
      expect(values).toEqual(["Hello"]);
    } finally {
      close();
    }
  });
});
