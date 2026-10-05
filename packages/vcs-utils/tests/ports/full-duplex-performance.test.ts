/**
 * Full-duplex performance and non-blocking tests for bidirectional ports.
 * Tests simultaneous reading/writing by two peers without blocking.
 */

import { describe, expect, it } from "vitest";
import { callBidi, listenBidi } from "../../src/ports/index.js";

function newMessageChannel() {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  return channel;
}

async function* generateNumbers(
  count: number,
  prefix: string,
  delayMs = 0,
): AsyncGenerator<string> {
  for (let i = 0; i < count; i++) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    yield `${prefix}-${i}`;
  }
}

describe("Full-duplex bidirectional communication", () => {
  it("should handle simultaneous read/write by both peers without blocking", async () => {
    const channel = newMessageChannel();
    const serverReceived: string[] = [];
    const clientReceived: string[] = [];

    // Server: receives from client, sends back transformed data
    const close = listenBidi<string, string>(channel.port1, async function* serverHandler(input) {
      for await (const value of input) {
        serverReceived.push(value);
        // Transform and send back immediately
        yield `SERVER-ECHO-${value}`;
      }
    });

    try {
      // Client: sends data and receives responses simultaneously
      const clientInput = generateNumbers(10, "CLIENT");

      for await (const value of callBidi<string, string>(channel.port2, clientInput)) {
        clientReceived.push(value);
      }

      // Verify both sides received all messages
      expect(serverReceived.length).toBe(10);
      expect(clientReceived.length).toBe(10);

      // Verify message content
      expect(serverReceived[0]).toBe("CLIENT-0");
      expect(serverReceived[9]).toBe("CLIENT-9");
      expect(clientReceived[0]).toBe("SERVER-ECHO-CLIENT-0");
      expect(clientReceived[9]).toBe("SERVER-ECHO-CLIENT-9");
    } finally {
      close();
    }
  });

  it("should not block when server processes slowly", async () => {
    const channel = newMessageChannel();
    const startTime = performance.now();
    let serverProcessingCount = 0;

    // Server with slow processing
    const close = listenBidi<string, string>(channel.port1, async function* slowServer(input) {
      for await (const value of input) {
        // Simulate slow processing
        await new Promise((resolve) => setTimeout(resolve, 10));
        serverProcessingCount++;
        yield `processed-${value}`;
      }
    });

    try {
      const clientReceived: string[] = [];
      const clientInput = generateNumbers(5, "FAST");

      for await (const value of callBidi<string, string>(channel.port2, clientInput)) {
        clientReceived.push(value);
      }

      const duration = performance.now() - startTime;

      expect(clientReceived.length).toBe(5);
      expect(serverProcessingCount).toBe(5);

      // Should complete in reasonable time despite server delays
      // (not 5 * 10ms = 50ms because of async processing)
      expect(duration).toBeLessThan(200);
    } finally {
      close();
    }
  });

  it("should handle interleaved messages from both sides", async () => {
    const channel = newMessageChannel();
    const timeline: Array<{ side: string; type: string; value: string }> = [];

    // Server echoes and also sends its own messages
    const close = listenBidi<string, string>(
      channel.port1,
      async function* interleavedServer(input) {
        let count = 0;
        for await (const value of input) {
          timeline.push({ side: "server", type: "received", value });

          // Send back echo
          yield `echo-${value}`;
          timeline.push({ side: "server", type: "sent", value: `echo-${value}` });

          // Also send an extra message
          yield `extra-${count++}`;
          timeline.push({
            side: "server",
            type: "sent",
            value: `extra-${count - 1}`,
          });
        }
      },
    );

    try {
      const clientReceived: string[] = [];
      const clientInput = generateNumbers(3, "MSG");

      for await (const value of callBidi<string, string>(channel.port2, clientInput)) {
        timeline.push({ side: "client", type: "received", value });
        clientReceived.push(value);
      }

      // Should receive 2 messages per input (echo + extra)
      expect(clientReceived.length).toBe(6);

      // Verify we got both types of messages
      const echoMessages = clientReceived.filter((v) => v.startsWith("echo-"));
      const extraMessages = clientReceived.filter((v) => v.startsWith("extra-"));

      expect(echoMessages.length).toBe(3);
      expect(extraMessages.length).toBe(3);
    } finally {
      close();
    }
  });

  it("should measure read/write performance for large data transfers", async () => {
    const channel = newMessageChannel();
    const MESSAGE_COUNT = 10000;
    const MESSAGE_SIZE = 1024 * 10; // characters per message

    const createMessage = (index: number) => `msg-${index}-${"x".repeat(MESSAGE_SIZE - 10)}`;

    let serverReceivedCount = 0;
    let clientReceivedCount = 0;

    const startTime = performance.now();

    // Server: pass through with minimal processing
    const close = listenBidi<string, string>(
      channel.port1,
      async function* performanceServer(input) {
        for await (const value of input) {
          serverReceivedCount++;
          yield value; // Pass through
        }
      },
    );

    try {
      // Client: send many messages and receive responses
      async function* clientInput() {
        for (let i = 0; i < MESSAGE_COUNT; i++) {
          yield createMessage(i);
        }
      }

      for await (const _value of callBidi<string, string>(channel.port2, clientInput())) {
        clientReceivedCount++;
      }

      const duration = performance.now() - startTime;
      const throughput = MESSAGE_COUNT / (duration / 1000); // messages per second
      const dataTransferred = MESSAGE_COUNT * MESSAGE_SIZE * 2; // bytes (bidirectional)
      const dataThroughput = dataTransferred / (duration / 1000) / 1024; // KB/s

      // Verify all messages were transferred
      expect(serverReceivedCount).toBe(MESSAGE_COUNT);
      expect(clientReceivedCount).toBe(MESSAGE_COUNT);

      // Performance expectations (these are conservative)
      expect(throughput).toBeGreaterThan(100); // At least 100 msgs/sec
      expect(dataThroughput).toBeGreaterThan(10); // At least 10 KB/s

      console.log(`
Performance metrics:
- Messages transferred: ${MESSAGE_COUNT} (each direction)
- Message size: ${MESSAGE_SIZE} bytes
- Total data: ${(dataTransferred / 1024).toFixed(2)} KB
- Duration: ${duration.toFixed(2)}ms
- Throughput: ${throughput.toFixed(2)} msgs/sec
- Data throughput: ${dataThroughput.toFixed(2)} KB/s
      `);
    } finally {
      close();
    }
  }, 10000);

  it("should handle concurrent bidirectional streams without blocking", async () => {
    const channel = newMessageChannel();
    const serverTimestamps: number[] = [];
    const clientTimestamps: number[] = [];

    // Server processes messages with slight delay
    const close = listenBidi<number, number>(
      channel.port1,
      async function* concurrentServer(input) {
        for await (const value of input) {
          serverTimestamps.push(performance.now());
          // Small delay but should not block the pipeline
          await new Promise((resolve) => setTimeout(resolve, 5));
          yield value * 2;
        }
      },
    );

    try {
      async function* clientInput() {
        for (let i = 0; i < 20; i++) {
          yield i;
          // Don't wait - send continuously
        }
      }

      const results: number[] = [];
      const startTime = performance.now();

      for await (const value of callBidi<number, number>(channel.port2, clientInput())) {
        clientTimestamps.push(performance.now());
        results.push(value);
      }

      const totalDuration = performance.now() - startTime;

      // All messages should be processed
      expect(results.length).toBe(20);
      expect(results[0]).toBe(0);
      expect(results[19]).toBe(38);

      // Check that processing happened concurrently, not sequentially
      // If fully sequential: 20 messages * 5ms delay = 100ms minimum
      // With concurrency, should be much faster
      expect(totalDuration).toBeLessThan(200);

      // Verify messages were processed in overlapping time windows
      // (timestamps should show concurrent processing)
      const serverSpan = serverTimestamps[serverTimestamps.length - 1] - serverTimestamps[0];
      const clientSpan = clientTimestamps[clientTimestamps.length - 1] - clientTimestamps[0];

      // Both spans should be similar, indicating concurrent processing
      expect(Math.abs(serverSpan - clientSpan)).toBeLessThan(100);
    } finally {
      close();
    }
  });

  it("should maintain message order despite async processing", async () => {
    const channel = newMessageChannel();
    const receivedOrder: number[] = [];

    // Server with random delays to test ordering
    const close = listenBidi<number, number>(channel.port1, async function* orderServer(input) {
      for await (const value of input) {
        // Random small delay
        const delay = Math.random() * 10;
        await new Promise((resolve) => setTimeout(resolve, delay));
        yield value;
      }
    });

    try {
      async function* sequentialInput() {
        for (let i = 0; i < 50; i++) {
          yield i;
        }
      }

      for await (const value of callBidi<number, number>(channel.port2, sequentialInput())) {
        receivedOrder.push(value);
      }

      // Despite async delays, order should be preserved
      expect(receivedOrder.length).toBe(50);
      for (let i = 0; i < 50; i++) {
        expect(receivedOrder[i]).toBe(i);
      }
    } finally {
      close();
    }
  });

  it("should handle binary block transfers with high throughput", async () => {
    const channel = newMessageChannel();
    const BLOCK_SIZE = 64 * 1024; // 64KB blocks
    const TOTAL_BYTES = 128 * 1024 * 1024;
    const BLOCK_COUNT = TOTAL_BYTES / BLOCK_SIZE;

    // Create a test pattern for binary data
    function createBinaryBlock(index: number): Uint8Array {
      const block = new Uint8Array(BLOCK_SIZE);
      // Fill with a pattern that can be verified
      for (let i = 0; i < BLOCK_SIZE; i++) {
        block[i] = (index + i) % 256;
      }
      return block;
    }

    // Compute checksum for verification
    function checksum(data: Uint8Array): number {
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        sum = (sum + data[i]) & 0xffffffff;
      }
      return sum;
    }

    const expectedChecksums: number[] = [];
    let serverReceivedBytes = 0;
    let clientReceivedBytes = 0;
    const receivedChecksums: number[] = [];

    // Pre-calculate expected checksums
    for (let i = 0; i < BLOCK_COUNT; i++) {
      expectedChecksums.push(checksum(createBinaryBlock(i)));
    }

    const startTime = performance.now();

    // Server: pass through binary blocks
    const close = listenBidi<Uint8Array, Uint8Array>(
      channel.port1,
      async function* binaryServer(input) {
        for await (const block of input) {
          serverReceivedBytes += block.length;
          // Verify it's a Uint8Array
          expect(block instanceof Uint8Array).toBe(true);
          // Pass through
          yield block;
        }
      },
    );

    try {
      // Client: send binary blocks
      async function* binaryInput() {
        for (let i = 0; i < BLOCK_COUNT; i++) {
          yield createBinaryBlock(i);
        }
      }

      for await (const block of callBidi<Uint8Array, Uint8Array>(channel.port2, binaryInput())) {
        expect(block instanceof Uint8Array).toBe(true);
        clientReceivedBytes += block.length;
        receivedChecksums.push(checksum(block));
      }

      const duration = performance.now() - startTime;

      // Calculate throughput metrics
      const totalBytesTransferred = serverReceivedBytes + clientReceivedBytes;
      const throughputMBps = totalBytesTransferred / (1024 * 1024) / (duration / 1000);
      const blockThroughput = BLOCK_COUNT / (duration / 1000);

      // Verify all data was transferred correctly
      expect(serverReceivedBytes).toBe(TOTAL_BYTES);
      expect(clientReceivedBytes).toBe(TOTAL_BYTES);
      expect(receivedChecksums.length).toBe(BLOCK_COUNT);

      // Verify data integrity using checksums
      for (let i = 0; i < BLOCK_COUNT; i++) {
        expect(receivedChecksums[i]).toBe(expectedChecksums[i]);
      }

      // Performance expectations (conservative for binary data)
      expect(throughputMBps).toBeGreaterThan(1); // At least 1 MB/s
      expect(blockThroughput).toBeGreaterThan(10); // At least 10 blocks/sec

      console.log(`
Binary throughput metrics:
- Block size: ${(BLOCK_SIZE / 1024).toFixed(2)} KB
- Blocks transferred: ${BLOCK_COUNT} (each direction)
- Total data: ${(totalBytesTransferred / (1024 * 1024)).toFixed(2)} MB
- Duration: ${duration.toFixed(2)}ms
- Block throughput: ${blockThroughput.toFixed(2)} blocks/sec
- Data throughput: ${throughputMBps.toFixed(2)} MB/s
- Data integrity: ${receivedChecksums.length}/${BLOCK_COUNT} checksums verified
      `);
    } finally {
      close();
    }
  }, 15000);

  it("should handle mixed binary sizes efficiently", async () => {
    const channel = newMessageChannel();
    const sizes = [
      1024, // 1KB
      4 * 1024, // 4KB
      16 * 1024, // 16KB
      64 * 1024, // 64KB
      256 * 1024, // 256KB
    ];
    const BLOCKS_PER_SIZE = 10;

    function createBlock(size: number, seed: number): Uint8Array {
      const block = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        block[i] = (seed + i) % 256;
      }
      return block;
    }

    let totalSent = 0;
    let totalReceived = 0;
    const receivedSizes: number[] = [];

    const startTime = performance.now();

    // Server echoes blocks back
    const close = listenBidi<Uint8Array, Uint8Array>(
      channel.port1,
      async function* mixedSizeServer(input) {
        for await (const block of input) {
          totalSent += block.length;
          yield block;
        }
      },
    );

    try {
      async function* mixedSizeInput() {
        let seed = 0;
        for (const size of sizes) {
          for (let i = 0; i < BLOCKS_PER_SIZE; i++) {
            yield createBlock(size, seed++);
          }
        }
      }

      for await (const block of callBidi<Uint8Array, Uint8Array>(channel.port2, mixedSizeInput())) {
        totalReceived += block.length;
        receivedSizes.push(block.length);
      }

      const duration = performance.now() - startTime;
      const throughputMBps = (totalSent + totalReceived) / (1024 * 1024) / (duration / 1000);

      // Verify all blocks received
      expect(receivedSizes.length).toBe(sizes.length * BLOCKS_PER_SIZE);

      // Verify each size category
      let offset = 0;
      for (const size of sizes) {
        for (let i = 0; i < BLOCKS_PER_SIZE; i++) {
          expect(receivedSizes[offset++]).toBe(size);
        }
      }

      expect(throughputMBps).toBeGreaterThan(0.5); // At least 0.5 MB/s

      console.log(`
Mixed binary sizes metrics:
- Sizes tested: ${sizes.map((s) => `${(s / 1024).toFixed(0)}KB`).join(", ")}
- Total blocks: ${receivedSizes.length}
- Total data: ${((totalSent + totalReceived) / (1024 * 1024)).toFixed(2)} MB
- Duration: ${duration.toFixed(2)}ms
- Throughput: ${throughputMBps.toFixed(2)} MB/s
      `);
    } finally {
      close();
    }
  }, 15000);

  it("should handle true full-duplex where sender does not await receiver", async () => {
    const channel = newMessageChannel();
    const SERVER_SEND_COUNT = 100;
    const CLIENT_SEND_COUNT = 100;
    const BLOCK_SIZE = 1024;

    function createBlock(seed: number): Uint8Array {
      const block = new Uint8Array(BLOCK_SIZE);
      for (let i = 0; i < BLOCK_SIZE; i++) {
        block[i] = (seed + i) % 256;
      }
      return block;
    }

    let receivedByServer = 0;
    let sentByServer = 0;
    let receivedByClient = 0;
    let sentByClient = 0;

    const startTime = performance.now();

    // Server: receives and sends independently (not echoing)
    const closeServer = listenBidi<Uint8Array, Uint8Array>(
      channel.port1,
      async function* fullDuplexServer(input) {
        // Start receiving in background - completely independent of sending
        const receivePromise = (async () => {
          for await (const _block of input) {
            receivedByServer++;
          }
        })();

        // Send server's own data stream - decorrelated from input
        for (let i = 0; i < SERVER_SEND_COUNT; i++) {
          yield createBlock(i + 1000); // Different seed than client
          sentByServer++;
        }

        // Wait for all client data to be received
        await receivePromise;
      },
    );

    try {
      // Client: sends and receives independently
      const clientPromise = (async () => {
        const clientInput = async function* () {
          for (let i = 0; i < CLIENT_SEND_COUNT; i++) {
            yield createBlock(i);
            sentByClient++;
          }
        };

        for await (const _block of callBidi<Uint8Array, Uint8Array>(channel.port2, clientInput())) {
          receivedByClient++;
        }
      })();

      await clientPromise;

      const duration = performance.now() - startTime;

      // Verify all messages were sent and received
      expect(sentByServer).toBe(SERVER_SEND_COUNT);
      expect(sentByClient).toBe(CLIENT_SEND_COUNT);
      expect(receivedByServer).toBe(CLIENT_SEND_COUNT);
      expect(receivedByClient).toBe(SERVER_SEND_COUNT);

      // Calculate metrics
      const totalMessages = sentByServer + sentByClient;
      const totalBytes = totalMessages * BLOCK_SIZE * 2; // Both directions
      const throughputMsgs = totalMessages / (duration / 1000);
      const throughputMBps = totalBytes / (1024 * 1024) / (duration / 1000);

      console.log(`
True full-duplex metrics:
- Server sent: ${sentByServer}, received: ${receivedByServer}
- Client sent: ${sentByClient}, received: ${receivedByClient}
- Total messages: ${totalMessages}
- Duration: ${duration.toFixed(2)}ms
- Message throughput: ${throughputMsgs.toFixed(2)} msgs/sec
- Data throughput: ${throughputMBps.toFixed(2)} MB/s
      `);

      // Should complete reasonably fast due to concurrent processing
      expect(duration).toBeLessThan(5000);
    } finally {
      closeServer();
    }
  });

  it("should handle asymmetric full-duplex with different rates", async () => {
    const channel = newMessageChannel();
    const SERVER_SEND_COUNT = 50;
    const CLIENT_SEND_COUNT = 200;
    const SERVER_DELAY_MS = 10;
    const CLIENT_DELAY_MS = 2;

    let receivedByServer = 0;
    let sentByServer = 0;
    let receivedByClient = 0;
    let sentByClient = 0;

    const serverTimestamps: number[] = [];
    const clientTimestamps: number[] = [];

    const startTime = performance.now();

    // Server: slow sender, fast receiver
    const closeServer = listenBidi<number, number>(
      channel.port1,
      async function* asymmetricServer(input) {
        // Receive fast
        const receivePromise = (async () => {
          for await (const _value of input) {
            receivedByServer++;
            serverTimestamps.push(performance.now() - startTime);
          }
        })();

        // Send slow
        for (let i = 0; i < SERVER_SEND_COUNT; i++) {
          await new Promise((resolve) => setTimeout(resolve, SERVER_DELAY_MS));
          yield i;
          sentByServer++;
        }

        await receivePromise;
      },
    );

    try {
      const clientPromise = (async () => {
        // Client: fast sender, slow receiver (reversed)
        const clientInput = async function* () {
          for (let i = 0; i < CLIENT_SEND_COUNT; i++) {
            await new Promise((resolve) => setTimeout(resolve, CLIENT_DELAY_MS));
            yield i;
            sentByClient++;
          }
        };

        for await (const _value of callBidi<number, number>(channel.port2, clientInput())) {
          receivedByClient++;
          clientTimestamps.push(performance.now() - startTime);
        }
      })();

      await clientPromise;

      const duration = performance.now() - startTime;

      // Verify counts
      expect(sentByServer).toBe(SERVER_SEND_COUNT);
      expect(sentByClient).toBe(CLIENT_SEND_COUNT);
      expect(receivedByServer).toBe(CLIENT_SEND_COUNT);
      expect(receivedByClient).toBe(SERVER_SEND_COUNT);

      // Calculate actual rates
      const serverSendRate = sentByServer / (duration / 1000);
      const clientSendRate = sentByClient / (duration / 1000);

      console.log(`
Asymmetric full-duplex metrics:
- Server: sent ${sentByServer} (${serverSendRate.toFixed(1)}/s), received ${receivedByServer}
- Client: sent ${sentByClient} (${clientSendRate.toFixed(1)}/s), received ${receivedByClient}
- Duration: ${duration.toFixed(2)}ms
- First server receive: ${serverTimestamps[0]?.toFixed(2)}ms
- Last server receive: ${serverTimestamps[serverTimestamps.length - 1]?.toFixed(2)}ms
- First client receive: ${clientTimestamps[0]?.toFixed(2)}ms
- Last client receive: ${clientTimestamps[clientTimestamps.length - 1]?.toFixed(2)}ms
      `);

      // The faster sender (client) should complete before the slower one
      // This verifies true independence of send/receive streams
      expect(clientSendRate).toBeGreaterThan(serverSendRate);
    } finally {
      closeServer();
    }
  }, 10000);
});
