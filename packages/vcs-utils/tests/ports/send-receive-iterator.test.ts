/**
 * Tests for sendIterator, receiveIterator, send, and receive functions.
 */

import { describe, expect, it } from "vitest";
import {
  callPort,
  listenPort,
  receive,
  receiveIterator,
  send,
  sendIterator,
} from "../../src/ports/index.js";

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

describe("sendIterator", () => {
  async function testAsyncCalls(dataToSend: AsyncIterable<number> | number[], control: number[]) {
    const channel = newMessageChannel();
    let calls = 0;
    const values: number[] = [];

    const close = listenPort(channel.port1, async ({ done, value }) => {
      if (!done) values.push(value);
      await new Promise((resolve) => setTimeout(resolve, 10));
      calls++;
    });

    try {
      const sendFn = async (params: unknown) => {
        return await callPort(channel.port2, params);
      };
      await sendIterator(sendFn, dataToSend);
      expect(calls).toBe(control.length + 1);
      expect(values).toEqual(control);
    } finally {
      close();
    }
  }

  it("should send/receive sync messages over a MessageChannel port", async () => {
    await testAsyncCalls([1, 2, 3], [1, 2, 3]);
  });

  it("should send/receive async messages over a MessageChannel port", async () => {
    await testAsyncCalls(makeAsync([1, 2, 3]), [1, 2, 3]);
  });
});

describe("receiveIterator", () => {
  async function testAsyncCalls(dataToSend: AsyncIterable<number> | number[], control: number[]) {
    const channel = newMessageChannel();
    let receiveMessage: ((params: unknown) => Promise<void>) | undefined;

    const it = receiveIterator<number>((p) => {
      receiveMessage = p;
    });

    const close = listenPort(channel.port1, async ({ done, value, error }) => {
      await receiveMessage?.({ done, value, error });
    });

    try {
      // Start sending in the background
      (async () => {
        const sendMessage = async ({ done, value, error }: unknown) => {
          return await callPort(channel.port2, { done, value, error });
        };
        await sendIterator(sendMessage, dataToSend);
      })();

      const values: number[] = [];
      for await (const value of it) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        values.push(value);
      }
      expect(values).toEqual(control);
    } finally {
      close();
    }
  }

  it("should send/receive sync messages over a MessageChannel port", async () => {
    await testAsyncCalls([1, 2, 3], [1, 2, 3]);
  });

  it("should send/receive async messages over a MessageChannel port", async () => {
    await testAsyncCalls(makeAsync([1, 2, 3]), [1, 2, 3]);
  });
});

describe("send/receive over a message port", () => {
  async function testAsyncCalls(
    dataToSend: AsyncIterable<number> | number[],
    control: number[],
    channelName = "",
  ) {
    const channel = newMessageChannel();

    // Start sending in the background
    (async () => {
      await send(channel.port2, dataToSend, { channelName });
    })();

    const values: number[] = [];
    for await (const input of receive<number>(channel.port1, { channelName })) {
      for await (const value of input) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        values.push(value);
      }
      break;
    }
    expect(values).toEqual(control);
  }

  it("should send/receive sync messages over a MessageChannel port", async () => {
    await testAsyncCalls([1, 2, 3], [1, 2, 3], "");
    await testAsyncCalls([1, 2, 3], [1, 2, 3], "a");
    await testAsyncCalls([1, 2, 3], [1, 2, 3], "a:b:c");
  });

  it("should send/receive async messages over a MessageChannel port", async () => {
    await testAsyncCalls(makeAsync([1, 2, 3]), [1, 2, 3], "");
    await testAsyncCalls(makeAsync([1, 2, 3]), [1, 2, 3], "a:");
    await testAsyncCalls(makeAsync([1, 2, 3]), [1, 2, 3], "a:b:c:");
  });
});
