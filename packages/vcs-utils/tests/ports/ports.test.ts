/**
 * Unit tests for callPort/listenPort RPC communication.
 */

import { describe, expect, it } from "vitest";
import { deserializeError, serializeError } from "../../src/ports/errors.js";
import { callPort, listenPort } from "../../src/ports/index.js";

/**
 * Create a new MessageChannel with both ports started.
 */
function newMessageChannel(): MessageChannel {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  return channel;
}

describe("callPort/listenPort", () => {
  it("should perform async calls over the port", async () => {
    const channel = newMessageChannel();

    const close = listenPort(channel.port1, async (params) => {
      return params;
    });

    try {
      const result = await callPort(channel.port2, { foo: "bar" });
      expect(result).toEqual({ foo: "bar" });
    } finally {
      close();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("should raise an exception if the call takes too much time", async () => {
    const channel = newMessageChannel();

    const close = listenPort(channel.port1, async (params) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return params;
    });

    let exception: Error | undefined;
    try {
      await callPort(channel.port2, { foo: "bar" }, { timeout: 300 });
    } catch (e) {
      exception = e as Error;
    } finally {
      close();
      channel.port1.close();
      channel.port2.close();
    }

    expect(exception).toBeDefined();
    expect(exception?.message).toContain("Call timeout");
  });

  it("should handle handler errors", async () => {
    const channel = newMessageChannel();

    const close = listenPort(channel.port1, async () => {
      throw new Error("Handler error");
    });

    let exception: Error | undefined;
    try {
      await callPort(channel.port2, {});
    } catch (e) {
      exception = e as Error;
    } finally {
      close();
      channel.port1.close();
      channel.port2.close();
    }

    expect(exception).toBeDefined();
    expect(exception?.message).toBe("Handler error");
  });

  it("should support channel names for filtering", async () => {
    const channel = newMessageChannel();
    const channelName = "test-channel";

    const close = listenPort(
      channel.port1,
      async (params: { value: number }) => {
        return { result: params.value * 2 };
      },
      { channelName },
    );

    try {
      const result = await callPort<{ value: number }, { result: number }>(
        channel.port2,
        { value: 21 },
        { channelName },
      );
      expect(result).toEqual({ result: 42 });
    } finally {
      close();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("should handle multiple concurrent calls", async () => {
    const channel = newMessageChannel();

    const close = listenPort(channel.port1, async (params: { id: number; delay: number }) => {
      await new Promise((resolve) => setTimeout(resolve, params.delay));
      return { id: params.id, processed: true };
    });

    try {
      const results = await Promise.all([
        callPort<{ id: number; delay: number }, { id: number; processed: boolean }>(
          channel.port2,
          { id: 1, delay: 50 },
          { timeout: 5000 },
        ),
        callPort<{ id: number; delay: number }, { id: number; processed: boolean }>(
          channel.port2,
          { id: 2, delay: 30 },
          { timeout: 5000 },
        ),
        callPort<{ id: number; delay: number }, { id: number; processed: boolean }>(
          channel.port2,
          { id: 3, delay: 10 },
          { timeout: 5000 },
        ),
      ]);

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.id).sort()).toEqual([1, 2, 3]);
      expect(results.every((r) => r.processed)).toBe(true);
    } finally {
      close();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("should handle binary data", async () => {
    const channel = newMessageChannel();

    const close = listenPort(channel.port1, async (params: { data: Uint8Array }) => {
      // Double each byte value
      const result = new Uint8Array(params.data.length);
      for (let i = 0; i < params.data.length; i++) {
        result[i] = (params.data[i] * 2) % 256;
      }
      return { data: result };
    });

    try {
      const input = new Uint8Array([1, 2, 3, 4, 5]);
      const result = await callPort<{ data: Uint8Array }, { data: Uint8Array }>(
        channel.port2,
        { data: input },
        { timeout: 5000 },
      );

      expect(result.data).toEqual(new Uint8Array([2, 4, 6, 8, 10]));
    } finally {
      close();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("should cleanup listener on close", async () => {
    const channel = newMessageChannel();
    let callCount = 0;

    const close = listenPort(channel.port1, async (params) => {
      callCount++;
      return params;
    });

    // First call should work
    await callPort(channel.port2, { test: 1 });
    expect(callCount).toBe(1);

    // Close the listener
    close();

    // Second call should timeout since listener is closed
    let timedOut = false;
    try {
      await callPort(channel.port2, { test: 2 }, { timeout: 100 });
    } catch {
      timedOut = true;
    }

    expect(timedOut).toBe(true);
    expect(callCount).toBe(1); // Should not have increased

    channel.port1.close();
    channel.port2.close();
  });
});

describe("error serialization", () => {
  it("should serialize and deserialize errors", () => {
    const original = new Error("Test error");
    original.name = "TestError";

    const serialized = serializeError(original);
    expect(serialized.message).toBe("Test error");
    expect(serialized.name).toBe("TestError");
    expect(serialized.stack).toBeDefined();

    const deserialized = deserializeError(serialized);
    expect(deserialized.message).toBe("Test error");
    expect(deserialized.name).toBe("TestError");
  });

  it("should handle string errors", () => {
    const serialized = serializeError("Simple error message");
    expect(serialized.message).toBe("Simple error message");

    const deserialized = deserializeError("Another error");
    expect(deserialized.message).toBe("Another error");
  });
});
