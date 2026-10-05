/**
 * Tests for ioHandle and ioSend functions.
 */

import { describe, expect, it } from "vitest";
import { ioHandle, ioSend } from "../../src/ports/index.js";

async function* makeAsync<T>(it: Iterable<T>, maxTimeout = 20): AsyncGenerator<T> {
  for (const value of it) {
    const timeout = Math.random() * maxTimeout;
    await new Promise((resolve) => setTimeout(resolve, timeout));
    yield value;
  }
}

function newMessageChannel() {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  return channel;
}

describe("ioHandle / ioSend", () => {
  async function testAsyncCalls(dataToSend: AsyncIterable<string> | string[], control: string[]) {
    const controller = new AbortController();
    try {
      const channel = newMessageChannel();
      const options = {
        channelName: "test",
      };
      const calls: number[] = [];

      // Start the handler in the background
      (async () => {
        async function* handler(input: AsyncGenerator<string>) {
          for await (const value of input) {
            yield value.toUpperCase();
          }
        }
        for await (const callId of ioHandle<string, string>(channel.port2, handler, options)) {
          if (controller.signal.aborted) break;
          calls.push(callId);
        }
      })();

      const values: string[] = [];
      for await (const value of ioSend<string, string>(channel.port1, dataToSend, options)) {
        values.push(value);
      }
      expect(values).toEqual(control);
    } finally {
      controller.abort();
    }
  }

  it("should handle input sync streams and return back modified values", async () => {
    await testAsyncCalls(["a", "b", "c"], ["A", "B", "C"]);
  });

  it("should handle input async streams and return back modified values", async () => {
    await testAsyncCalls(makeAsync(["a", "b", "c"]), ["A", "B", "C"]);
  });
});
