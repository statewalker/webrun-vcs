# Port Stream Documentation

## Overview

The port-stream module provides bidirectional streaming over `MessagePortLike` with byte-based sub-stream ACK backpressure. Blocks are sent until `chunkSize` bytes are reached, then acknowledgment is requested before continuing. This reduces round-trip overhead while still preventing memory exhaustion.

## API Reference

### MessagePortLike Interface

```typescript
interface MessagePortLike {
  /** Post binary data to the remote endpoint */
  postMessage(data: ArrayBuffer | Uint8Array): void;

  /** Close the port */
  close(): void;

  /** Start receiving messages (required by MessagePort spec) */
  start(): void;

  /** Add event listener ("message", "close" or "error") */
  addEventListener<T extends MessagePortEventType>(
    type: T,
    listener: MessagePortEventListener<T>,
  ): void;

  /** Remove event listener */
  removeEventListener<T extends MessagePortEventType>(
    type: T,
    listener: MessagePortEventListener<T>,
  ): void;
}

type MessagePortEventType = "message" | "close" | "error";
// "message" listeners receive MessageEvent<ArrayBuffer>, "error" listeners an Error,
// "close" listeners no arguments.
```

### writeStream / readStream

Core functions for streaming data over MessagePort:

```typescript
async function writeStream(
  port: MessagePortLike,
  stream: AsyncIterable<Uint8Array>,
  options?: PortStreamOptions
): Promise<void>;

function readStream(port: MessagePortLike): AsyncGenerator<Uint8Array>;

interface PortStreamOptions {
  /** Byte threshold for sub-stream splitting (default: 64KB) */
  chunkSize?: number;
  /** Timeout for ACK response in milliseconds (default: 5000) */
  ackTimeout?: number;
  /** Abort signal to cancel ACK waits during graceful close */
  signal?: AbortSignal;
}
```

### createPortStream

Create a bidirectional stream over a MessagePortLike:

```typescript
function createPortStream(
  port: MessagePortLike,
  options?: PortStreamOptions
): PortStream;

interface PortStream {
  /** Send a binary stream with backpressure */
  send(stream: AsyncIterable<Uint8Array>): Promise<void>;

  /** Receive a binary stream with backpressure */
  receive(): AsyncIterable<Uint8Array>;

  /** Close the port */
  close(): void;
}
```

### createAwaitAckFunction

Factory for creating ACK wait functions:

```typescript
function createAwaitAckFunction(
  port: MessagePortLike,
  options?: { ackTimeout?: number; signal?: AbortSignal }
): () => Promise<void>;
```

If no ACK arrives within `ackTimeout`, the returned promise rejects with `Timeout waiting for acknowledgement`. A "close" event on the port, or an aborted `signal`, resolves the pending wait instead.

### sendWithAcknowledgement

Transform stream that splits into byte-based sub-streams and awaits ACK between them:

```typescript
async function* sendWithAcknowledgement(
  stream: AsyncIterable<Uint8Array>,
  awaitAck: () => Promise<void>,
  options?: { chunkSize?: number }
): AsyncGenerator<Uint8Array>;
```

### wrapNativePort

Wrap a native `MessagePort` as `MessagePortLike`:

```typescript
function wrapNativePort(port: MessagePort): MessagePortLike;
```

### createPortStreamPair

Create a connected pair of PortStreams for testing:

```typescript
function createPortStreamPair(
  options?: PortStreamOptions
): [PortStream, PortStream];
```

## Binary Protocol Specification

### Message Format (9-byte header)

Each message is encoded as an `ArrayBuffer`:

```
┌──────────┬────────────────────┬────────────────────┬─────────────────┐
│ Type     │ ID                 │ Length             │ Payload         │
│ (1 byte) │ (4 bytes LE)       │ (4 bytes LE)       │ (variable)      │
└──────────┴────────────────────┴────────────────────┴─────────────────┘
```

Total header: 9 bytes

### Message Types

| Type | Value | Payload | Description |
|------|-------|---------|-------------|
| REQUEST_ACK | 1 | (none) | Request acknowledgment from receiver |
| ACKNOWLEDGE | 2 | (none) | Acknowledgment response |
| DATA | 3 | Binary data | Block to transfer |
| END | 4 | (none) | Stream complete |

## Backpressure Mechanism

### Flow Diagram (Byte-based Sub-stream Splitting)

With `chunkSize=64KB`, the protocol looks like:

```
Sender                                    Receiver
  │                                          │
  │  ┌────────────────────────┐             │
  │  │ DATA [id=0] [payload]  │─────────────►│
  │  └────────────────────────┘             │
  │  ┌────────────────────────┐             │
  │  │ DATA [id=1] [payload]  │─────────────►│  (cumulative bytes < chunkSize)
  │  └────────────────────────┘             │
  │              ...                         │
  │  ┌────────────────────────┐             │
  │  │ DATA [id=N] [payload]  │─────────────►│  (cumulative bytes >= chunkSize)
  │  └────────────────────────┘             │
  │  ┌────────────────────────┐             │
  │  │ REQUEST_ACK [id=0]     │─────────────►│
  │  └────────────────────────┘             │
  │                                          │
  │              (Receiver processes data)   │
  │                                          │
  │             ┌──────────────────┐        │
  │◄────────────│ ACKNOWLEDGE [id=0]│        │
  │             └──────────────────┘        │
  │                                          │
  │  ┌────────────────────────┐             │
  │  │ DATA [id=N+1] [payload]│─────────────►│
  │  └────────────────────────┘             │
  │              ...                         │
  │  ┌──────────────┐                       │
  │  │ END [id=M]   │───────────────────────►│
  │  └──────────────┘                       │
```

There is no ACK after the last sub-stream: END follows the last DATA message directly, and the receiver processes all queued DATA before it sees END.

### Key Properties

1. **Byte-based Splitting**: Sub-streams are split by byte count (chunkSize), not block count
2. **Reduced Round-trips**: Multiple blocks sent before waiting for ACK
3. **Flow Control**: Sender waits for ACK after each sub-stream
4. **Memory Safety**: Limits buffering to chunkSize bytes
5. **Timeout Protection**: ACK timeout prevents indefinite blocking
6. **Uses addEventListener**: Allows multiple pending ACK requests without interference

## Usage Examples

### Basic Send/Receive

```typescript
import { writeStream, readStream, wrapNativePort } from "@statewalker/vcs-utils/streams";

// Create channel
const channel = new MessageChannel();
const port1 = wrapNativePort(channel.port1);
const port2 = wrapNativePort(channel.port2);

// Send data
async function* generateData() {
  yield new Uint8Array([1, 2, 3]);
  yield new Uint8Array([4, 5, 6]);
}

const sendPromise = writeStream(port1, generateData());

// Receive data
for await (const chunk of readStream(port2)) {
  console.log("Received:", chunk);
}

await sendPromise;
```

### Using PortStream Interface

```typescript
import { createPortStream, wrapNativePort } from "@statewalker/vcs-utils/streams";

const channel = new MessageChannel();
const stream1 = createPortStream(wrapNativePort(channel.port1));
const stream2 = createPortStream(wrapNativePort(channel.port2));

// Send
await stream1.send(generateData());

// Receive
for await (const chunk of stream2.receive()) {
  console.log("Received:", chunk);
}

// Cleanup
stream1.close();
stream2.close();
```

### With Byte-based Chunking

```typescript
const stream = createPortStream(port, {
  chunkSize: 64 * 1024,  // Request ACK after every 64KB
  ackTimeout: 10000,     // 10 second timeout
});

// Large data will be split and ACK requested after each 64KB
await stream.send(generateLargeData());
```

### Using Lower-level Functions

```typescript
import {
  createAwaitAckFunction,
  sendWithAcknowledgement
} from "@statewalker/vcs-utils/streams";

// Create ACK function
const awaitAck = createAwaitAckFunction(port, { ackTimeout: 5000 });

// Transform stream with acknowledgement
for await (const chunk of sendWithAcknowledgement(dataStream, awaitAck, { chunkSize: 32768 })) {
  // Each chunk is part of a sub-stream
  // awaitAck() is called between sub-streams
  sendData(chunk);
}
```

## Performance Considerations

### Chunk Size Selection

| Chunk Size | Round-trips | Latency | Use Case |
|------------|-------------|---------|----------|
| 1 KB | Very high | Low | Interactive, small data |
| 64 KB | Medium | Medium | General purpose (default) |
| 256 KB | Low | Higher | Bulk transfer, low latency networks |
| 1 MB | Very low | High | High bandwidth, reliable networks |

### ACK Timeout

- **Short timeout (1-5s)**: Fast failure detection, may fail on slow networks
- **Default (5s)**: Balanced for most use cases
- **Long timeout (30s+)**: For high-latency or unreliable networks

### Memory Usage

The sender buffers at most `chunkSize` bytes before waiting for ACK. Choose `chunkSize` based on:
- Available memory
- Network latency (larger = fewer round-trips)
- Desired responsiveness (smaller = faster backpressure)

## Implementation Notes

### Why addEventListener for ACK

The ACK waiting mechanism uses `addEventListener` instead of `onmessage` because:
- Allows multiple pending ACK requests simultaneously
- Does not interfere with other message handlers
- Clean listener cleanup after each ACK received or timeout

### Byte-based vs Block-based Splitting

Previous versions used block count (`subStreamSize`) for splitting. The new API uses byte count (`chunkSize`) because:
- More predictable memory usage
- Works correctly with variable-sized blocks
- Handles blocks larger than the threshold correctly (splits them)

### Cleanup

Always close the stream when done to release resources:

```typescript
stream.close();
// or
port.close();
```
