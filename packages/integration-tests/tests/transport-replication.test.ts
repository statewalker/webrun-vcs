/**
 * Transport Replication Integration Tests
 *
 * Tests that verify data can be replicated correctly over MessagePort
 * using the new MessagePort adapter APIs.
 */

import { createMessagePortDuplex, type Duplex } from "@statewalker/vcs-transport";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryFactory } from "./backend-factories.js";
import type { SimpleHistory } from "./helpers/simple-history.js";
import { createCommit, createInitializedGitFromFactory, toArray } from "./test-helper.js";

/**
 * Test transport endpoint wrapping a MessagePort Duplex.
 */
interface TestTransportEndpoint {
  writer(data: Uint8Array): void;
  reader: AsyncGenerator<Uint8Array>;
  close(): Promise<void>;
}

function wrapDuplex(duplex: Duplex, port: MessagePort): TestTransportEndpoint {
  return {
    writer: (data: Uint8Array) => duplex.write(data),
    reader: duplex[Symbol.asyncIterator]() as AsyncGenerator<Uint8Array>,
    close: async () => {
      port.postMessage("__close__");
    },
  };
}

/**
 * Create a connected pair of MessagePort transports for testing.
 */
function createTestTransportPair(): {
  local: TestTransportEndpoint;
  remote: TestTransportEndpoint;
  cleanup: () => void;
} {
  const channel = new MessageChannel();

  return {
    local: wrapDuplex(createMessagePortDuplex(channel.port1), channel.port1),
    remote: wrapDuplex(createMessagePortDuplex(channel.port2), channel.port2),
    cleanup: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

// Helper to create Uint8Array from string
function text(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Helper to decode Uint8Array to string
function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

// Collect all chunks from a reader
async function collectChunks(reader: AsyncGenerator<Uint8Array>): Promise<Uint8Array[]> {
  const result: Uint8Array[] = [];
  for await (const chunk of reader) {
    result.push(chunk);
  }
  return result;
}

describe("Transport Replication", () => {
  let _localWorkingCopy: WorkingCopy;
  let remoteWorkingCopy: WorkingCopy;
  let remoteRepository: SimpleHistory;
  let localCleanup: (() => Promise<void>) | undefined;
  let remoteCleanup: (() => Promise<void>) | undefined;
  let transport: ReturnType<typeof createTestTransportPair>;

  beforeEach(async () => {
    // Create two in-memory repositories
    const localCtx = await createInitializedGitFromFactory(memoryFactory);
    _localWorkingCopy = localCtx.workingCopy;
    localCleanup = localCtx.cleanup;

    const remoteCtx = await createInitializedGitFromFactory(memoryFactory);
    remoteWorkingCopy = remoteCtx.workingCopy;
    remoteRepository = remoteCtx.repository;
    remoteCleanup = remoteCtx.cleanup;

    // Create connected transports
    transport = createTestTransportPair();
  });

  afterEach(async () => {
    transport?.cleanup();
    if (localCleanup) await localCleanup();
    if (remoteCleanup) await remoteCleanup();
  });

  // =============================================================================
  // Basic transport tests
  // =============================================================================

  it("should send and receive data chunks", async () => {
    // Send some data
    await transport.local.writer(text("want abc123\n"));
    await transport.local.writer(text("have def456\n"));
    await transport.local.close();

    const received = await collectChunks(transport.remote.reader);

    expect(received).toHaveLength(2);
    expect(decode(received[0])).toBe("want abc123\n");
    expect(decode(received[1])).toBe("have def456\n");
  });

  it("should handle bidirectional communication (request/response)", async () => {
    // Phase 1: Client -> Server
    await transport.local.writer(text("want refs/heads/main\n"));
    await transport.local.close();

    const serverReceived = await collectChunks(transport.remote.reader);
    expect(serverReceived).toHaveLength(1);
    expect(decode(serverReceived[0])).toContain("want");

    // Phase 2: Server -> Client (recreate transport for second phase)
    const transport2 = createTestTransportPair();

    await transport2.remote.writer(text("ACK refs/heads/main\n"));
    await transport2.remote.writer(text("PACK data here..."));
    await transport2.remote.close();

    const clientReceived = await collectChunks(transport2.local.reader);
    expect(clientReceived).toHaveLength(2);
    expect(decode(clientReceived[0])).toContain("ACK");

    transport2.cleanup();
  });

  // =============================================================================
  // Large data transfer tests
  // =============================================================================

  it("should transfer large binary blobs with integrity", async () => {
    // Create a large blob in chunks
    const chunkSize = 60000;
    const totalSize = 1024 * 1024;
    const numChunks = Math.ceil(totalSize / chunkSize);

    // Send chunks
    for (let i = 0; i < numChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalSize);
      const chunk = new Uint8Array(end - start);
      for (let j = 0; j < chunk.length; j++) {
        chunk[j] = (start + j) % 256;
      }
      await transport.local.writer(chunk);
    }
    await transport.local.close();

    const received = await collectChunks(transport.remote.reader);
    expect(received).toHaveLength(numChunks);

    // Reconstruct and verify data integrity
    const reconstructed = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of received) {
      reconstructed.set(chunk, offset);
      offset += chunk.length;
    }

    expect(offset).toBe(totalSize);

    // Verify pattern
    expect(reconstructed[0]).toBe(0);
    expect(reconstructed[1023]).toBe(255);
    expect(reconstructed[1024]).toBe(0);
    expect(reconstructed[totalSize - 1]).toBe((totalSize - 1) % 256);
  });

  it("should transfer many small packets efficiently", async () => {
    const packetCount = 100;

    for (let i = 0; i < packetCount; i++) {
      await transport.local.writer(text(`packet-${i.toString().padStart(3, "0")}\n`));
    }
    await transport.local.close();

    const received = await collectChunks(transport.remote.reader);
    expect(received).toHaveLength(packetCount);

    // Verify packet order
    expect(decode(received[0])).toBe("packet-000\n");
    expect(decode(received[49])).toBe("packet-049\n");
    expect(decode(received[99])).toBe("packet-099\n");
  });

  // =============================================================================
  // Backpressure tests
  // =============================================================================

  it("should handle backpressure with slow receiver", async () => {
    const chunkSize = 50000;
    const numChunks = 10;
    const totalSize = chunkSize * numChunks;

    // Send data
    const sendPromise = (async () => {
      for (let i = 0; i < numChunks; i++) {
        const chunk = new Uint8Array(chunkSize);
        for (let j = 0; j < chunkSize; j++) {
          chunk[j] = (i * chunkSize + j) % 256;
        }
        await transport.local.writer(chunk);
      }
      await transport.local.close();
    })();

    let receivedBytes = 0;
    let totalTime = 0;

    const receivePromise = (async () => {
      const start = performance.now();
      for await (const chunk of transport.remote.reader) {
        receivedBytes += chunk.length;
        // Simulate slow processing
        await new Promise((r) => setTimeout(r, 5));
      }
      totalTime = performance.now() - start;
    })();

    await Promise.all([sendPromise, receivePromise]);

    // All data should be received
    expect(receivedBytes).toBe(totalSize);
    // Processing should take at least some time due to delays
    expect(totalTime).toBeGreaterThan(0);
  });

  // =============================================================================
  // Repository data transfer tests
  // =============================================================================

  it("should transfer blob content between repositories", async () => {
    // Add a file to remote repository
    await createCommit(remoteWorkingCopy, "Add test file", {
      "test.txt": "Hello, world!",
    });

    // Get the HEAD commit
    const headRef = await remoteRepository.refs.resolve("HEAD");
    if (!headRef) {
      throw new Error("HEAD ref not found");
    }

    const commit = await remoteRepository.commits.load(headRef.objectId);
    if (!commit) throw new Error("Commit not found");
    const tree = await toArray(remoteRepository.trees.load(commit.tree));

    // Find the test.txt entry
    const testFileEntry = tree.find((e) => e.name === "test.txt");
    if (!testFileEntry) {
      const names = tree.map((e) => e.name);
      throw new Error(`test.txt not found in tree. Available names: ${names.join(", ")}`);
    }

    // Load blob content
    const blobChunks: Uint8Array[] = [];
    const blobStream = await remoteRepository.blobs.load(testFileEntry.id);
    if (!blobStream) throw new Error("Blob not found");
    for await (const chunk of blobStream) {
      blobChunks.push(chunk);
    }
    const blobContent = new Uint8Array(blobChunks.reduce((sum, c) => sum + c.length, 0));
    let offset = 0;
    for (const chunk of blobChunks) {
      blobContent.set(chunk, offset);
      offset += chunk.length;
    }

    // Transfer blob via transport
    await transport.local.writer(blobContent);
    await transport.local.close();

    const received = await collectChunks(transport.remote.reader);

    // Verify transfer
    expect(received).toHaveLength(1);
    expect(decode(received[0])).toBe("Hello, world!");
  });

  it("should transfer commit metadata", async () => {
    // Create commit in remote
    const commitId = await createCommit(remoteWorkingCopy, "Test commit message", {
      "file.txt": "content",
    });

    // Load commit data
    const commit = await remoteRepository.commits.load(commitId);
    if (!commit) throw new Error("Commit not found");
    const commitData = text(
      JSON.stringify({
        tree: commit.tree,
        parents: commit.parents,
        message: commit.message,
        author: commit.author,
        committer: commit.committer,
      }),
    );

    // Transfer commit via transport
    await transport.local.writer(commitData);
    await transport.local.close();

    const received = await collectChunks(transport.remote.reader);

    // Verify transfer
    expect(received).toHaveLength(1);
    const parsedCommit = JSON.parse(decode(received[0]));

    expect(parsedCommit.message).toBe("Test commit message");
    expect(parsedCommit.tree).toBe(commit.tree);
  });

  // =============================================================================
  // Error handling tests
  // =============================================================================

  it("should handle closed connection gracefully", async () => {
    // Close the local side
    await transport.local.close();

    // The remote reader should end (no more data)
    const received = await collectChunks(transport.remote.reader);
    expect(received).toHaveLength(0);
  });
});
