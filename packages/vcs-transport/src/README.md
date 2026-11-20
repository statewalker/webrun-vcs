# FSM-based Git Protocol Implementation

This module provides a finite state machine (FSM) based implementation of the Git transport protocol, enabling cleaner separation of concerns and easier testing.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        ProcessContext                             │
│  ┌────────────┐  ┌─────────────┐  ┌────────────┐  ┌───────────┐ │
│  │TransportApi│  │ Repository  │  │  Protocol  │  │  Handler  │ │
│  │   (I/O)    │  │   Facade    │  │   State    │  │  Output   │ │
│  └────────────┘  └─────────────┘  └────────────┘  └───────────┘ │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │             FSM               │
              │  transitions + handlers       │
              └───────────────────────────────┘
```

### Design Principles

1. **Explicit FSM**: Transitions defined as tuples `[source, event, target]`
2. **Separated Concerns**: I/O, storage, state, and configuration are separate interfaces
3. **Stop States**: FSM can pause at specific states for HTTP protocol adaptation
4. **Composable**: Error recovery transitions merge with protocol transitions

## Core Components

### FSM Core

The FSM executes state handlers and follows transitions based on events:

```typescript
import { Fsm } from "@statewalker/vcs-transport";

// Define transitions
const transitions: FsmTransition[] = [
  ["", "START", "READ_REFS"],          // Initial → READ_REFS
  ["READ_REFS", "REFS_RECEIVED", "SEND_WANTS"],
  ["SEND_WANTS", "DONE", ""],          // → Final state
];

// Define handlers (return events)
const handlers = new Map([
  ["", async () => "START"],
  ["READ_REFS", async (ctx) => {
    await readRefs(ctx);
    return "REFS_RECEIVED";
  }],
  ["SEND_WANTS", async (ctx) => {
    await sendWants(ctx);
    return "DONE";
  }],
]);

// Run FSM
const fsm = new Fsm(transitions, handlers);
await fsm.run(context);
```

### Transition Format

| Source | Event | Target | Meaning |
|--------|-------|--------|---------|
| `""` | `"START"` | `"READ_REFS"` | Initial state → READ_REFS |
| `"STATE"` | `"EVENT"` | `""` | STATE → Final state (exit) |
| `"*"` | `"ERROR"` | `"HANDLE_ERROR"` | Any state → HANDLE_ERROR (wildcard) |
| `"RECOVER"` | `"OK"` | `"*"` | RECOVER → Previous state (return) |

### Stop States

Stop states allow pausing FSM execution at specific points:

```typescript
// HTTP GET /info/refs - run until NEGOTIATION state
await fsm.run(context, "NEGOTIATION");

// Later: HTTP POST /git-upload-pack - resume
await fsm.run(context);
```

## Context Types

### ProcessContext

Complete context passed to all FSM state handlers:

```typescript
type ProcessContext = {
  transport: TransportApi;       // Git wire protocol I/O
  repository: RepositoryFacade;  // Pack import/export, object checks
  refStore: RefStore;            // Ref management
  state: ProtocolState;          // Accumulated protocol state
  output: HandlerOutput;         // Handler results
  config: ProcessConfiguration;  // FSM execution options
};
```

### TransportApi

Handles Git wire protocol I/O:

```typescript
interface TransportApi {
  // Pkt-line level
  readPktLine(): Promise<PktLineResult>;
  writePktLine(data: string | Uint8Array): Promise<void>;
  writeFlush(): Promise<void>;
  writeDelimiter(): Promise<void>;

  // Convenience methods
  readLine(): Promise<string | null>;
  writeLine(line: string): Promise<void>;

  // Sideband multiplexing
  readSideband(): Promise<SidebandResult>;
  writeSideband(channel: 1 | 2 | 3, data: Uint8Array): Promise<void>;

  // Pack streaming
  readPack(): AsyncGenerator<Uint8Array>;
  writePack(data: AsyncIterable<Uint8Array>): Promise<void>;
}
```

### RepositoryFacade

Repository operations for the transport layer:

```typescript
interface RepositoryFacade {
  importPack(packStream: AsyncIterable<Uint8Array>): Promise<PackImportResult>;
  exportPack(wants: Set<string>, exclude: Set<string>): AsyncIterable<Uint8Array>;
  has(oid: string): Promise<boolean>;
  walkAncestors(startOid: string): AsyncGenerator<string>;
}
```

### ProtocolState

Accumulated state during protocol execution:

```typescript
class ProtocolState {
  refs = new Map<string, string>();      // Discovered refs
  wants = new Set<string>();             // Objects to fetch
  haves = new Set<string>();             // Objects client has
  commonBase = new Set<string>();        // Common ancestor objects
  capabilities = new Set<string>();      // Negotiated capabilities
  protocolVersion?: number;              // 1 or 2

  // Checkpoint support for error recovery
  createCheckpoint(): void;
  restoreCheckpoint(): boolean;
}
```

## Available FSMs

### Push FSM

The server side of push (receive-pack). The client side is not an FSM: it is the push client in
`push-client/` (git's send-pack: refspecs, per-ref checks, thin pack, report-status, over smart
HTTP or a duplex), used by `push` and `pushOverDuplex`.

```typescript
import { serverPushTransitions, serverPushHandlers } from "@statewalker/vcs-transport";

// Server push handler
const serverFsm = new Fsm(serverPushTransitions, serverPushHandlers);
await serverFsm.run(context);
```

**Server Push States:**
```
"" → ADVERTISE_REFS → READ_COMMANDS → READ_PACK → VALIDATE_COMMANDS
   → EXECUTE_COMMANDS → SEND_STATUS → ""
```

### Fetch FSM

The server side of fetch (upload-pack, Protocol V1). The client side is not an FSM: it is the
fetch client in `fetch-client/` (git's fetch-pack: negotiation, shallow, tags, ref updates, over
protocol v2 or v0, smart HTTP or a duplex), used by `fetch` and `fetchOverDuplex`.

```typescript
import { serverFetchTransitions, serverFetchHandlers } from "@statewalker/vcs-transport";

// Server fetch handler
const serverFsm = new Fsm(serverFetchTransitions, serverFetchHandlers);
await serverFsm.run(context);
```

**Server Fetch States:**
```
"" → SEND_ADVERTISEMENT → READ_WANTS → VALIDATE_WANTS
   → READ_SHALLOW_INFO → COMPUTE_SHALLOW → SEND_SHALLOW_UPDATE
   → READ_HAVES → SEND_ACKS → SEND_NAK → SEND_PACK → ""
```

**Fetch Features:**
- Multi-ack negotiation (`multi_ack`, `multi_ack_detailed`)
- Shallow clone support (`deepen`, `deepen-since`, `deepen-not`)
- Partial clone filtering (`filter`)
- Sideband multiplexing for progress/errors
- Request policy validation (ADVERTISED, TIP, REACHABLE_COMMIT, ANY)

### Protocol V2 FSM

Git Protocol V2 server implementation (the v2 client is the fetch client):

```typescript
import { serverV2Transitions, serverV2Handlers } from "@statewalker/vcs-transport";
```

**Protocol V2 Commands:**
- `ls-refs`: List refs with filtering and symref/peel info
- `fetch`: Fetch objects with shallow clone and partial clone support
- `object-info`: Get object sizes without fetching

### Error Recovery FSM

Composable error handling that merges with any protocol FSM:

```typescript
import {
  withErrorRecovery,
  withErrorRecoveryHandlers,
  classifyError,
  errorRecoveryTransitions,
  errorRecoveryHandlers,
} from "@statewalker/vcs-transport";

// Merge with protocol transitions
const transitions = withErrorRecovery(serverV2Transitions);
const handlers = withErrorRecoveryHandlers(serverV2Handlers);

// Use the enhanced FSM
const fsm = new Fsm(transitions, handlers);
```

**Error Categories:**
- `TIMEOUT`: Request/response timeout (retryable)
- `TRANSPORT_ERROR`: Connection issues (reconnectable)
- `PACK_ERROR`: Pack parsing/creation failed (fatal)
- `VALIDATION_ERROR`: Invalid request data (fatal)
- `PROTOCOL_ERROR`: Protocol violation (default, usually fatal)

**Error Recovery States:**
```
*:TIMEOUT         → HANDLE_TIMEOUT → RETRY_OPERATION | CLEANUP
*:TRANSPORT_ERROR → HANDLE_TRANSPORT_ERROR → ATTEMPTING_RECONNECT | CLEANUP
ATTEMPTING_RECONNECT:CONNECTED → RESTORE_STATE → * (previous state)
```

**Checkpoint/Restore:**
```typescript
// Create checkpoint before risky operation
context.state.createCheckpoint();

// On reconnection, restore state
if (context.state.restoreCheckpoint()) {
  // Resume from checkpoint
}
```

## Usage Examples

### Serve with Error Recovery

```typescript
import {
  Fsm,
  type ProcessContext,
  ProtocolState,
  HandlerOutput,
  ProcessConfiguration,
  createTransportApi,
  createRepositoryFacade,
  withErrorRecovery,
  withErrorRecoveryHandlers,
  serverV2Transitions,
  serverV2Handlers,
} from "@statewalker/vcs-transport";

// Create context
const state = new ProtocolState();
const context: ProcessContext = {
  transport: createTransportApi(duplex, state),
  repository: createRepositoryFacade({ history }),
  refStore,
  state,
  output: new HandlerOutput(),
  config: new ProcessConfiguration(),
};

// Configure
context.config.maxRetries = 3;
context.config.allowReconnect = true;
context.config.reconnect = async () => createNewConnection();

// Create FSM with error recovery
const transitions = withErrorRecovery(serverV2Transitions);
const handlers = withErrorRecoveryHandlers(serverV2Handlers);
const fsm = new Fsm(transitions, handlers);

// Run
await fsm.run(context);
```

### HTTP Smart Protocol Adaptation

The FSM supports stop states for HTTP's request/response model:

```typescript
// GET /info/refs
const fsm = new Fsm(serverTransitions, serverHandlers);
await fsm.run(context, "WAIT_FOR_REQUEST");  // Stop after ref advertisement

// POST /git-upload-pack
await fsm.run(context);  // Resume and complete
```

### Custom FSM Composition

Compose your own FSM by combining transitions:

```typescript
const myTransitions: FsmTransition[] = [
  ...baseProtocolTransitions,
  ...errorRecoveryTransitions,
  // Add custom transitions
  ["CUSTOM_STATE", "CUSTOM_EVENT", "NEXT_STATE"],
];

const myHandlers = new Map([
  ...baseProtocolHandlers,
  ...errorRecoveryHandlers,
  ["CUSTOM_STATE", async (ctx) => { /* ... */ return "CUSTOM_EVENT"; }],
]);
```

## Transports and Adapters

A remote URL becomes a session through a connector in a `GitTransportRegistry`. Smart HTTP
is built in (`createDefaultTransports`); every other transport carries git's own native
protocol over a byte stream (a `Duplex`), with git-daemon's request line first
(`git-upload-pack /repo.git\0host=<host>\0`) so one server serves any repository its
resolver finds. On the serving side, every adapter ends in `serveGitConnection`:

```ts
const serve = {
  enableReceivePack: true,
  resolveRepository: createBasePathResolver({ files, basePath: "/srv/git", openRepository }),
};
```

Each adapter below is a client connector plus a server entry point taking `serve`.

### MessagePort (Workers, iframes, a MessageChannel)

```ts
// one session per MessageChannel; webrun-rpc's stream tier bounds both directions
transports.register(createMessagePortConnector({
  name: "worker", schemes: ["worker"],
  openPort: () => openPortToWorker(),          // a fresh port per session
}));
serveGitOverPort(port, serve);                  // in the worker, per port

// many sessions over one port (webrun-rpc's multiplexer, a window per session)
await serveGitOverPortMux(port, serve);         // in the worker
const peer = await connectGitOverPortMux(port1);
transports.register(createWebrunConnector({ name: "worker", schemes: ["worker"], call: () => peer.call }));
```

`Duplex.end` ends the client's input, which the server sees as the end of its input while
its answer goes on. The deprecated `createMessagePortDuplex` posted writes without
backpressure and ended with a `"__close__"` string.

### WebSocket

```ts
transports.register(createWebSocketConnector());           // ws:// and wss://, global WebSocket
await git.clone().setURI("wss://git.example.com/repo.git").setTransports(transports).call();

new WebSocketServer({ port: 8080 }).on("connection", (socket) => serveGitOverWebSocket(socket, serve));
```

One session per socket, binary frames. A WebSocket has no half-close, so **an empty binary
frame ends its sender's direction** (data frames are never empty). Writes wait while
`bufferedAmount` is above the high water mark; a socket that can pause (the `ws` package's)
pauses while its reader lags. A browser WebSocket cannot pause, so its reader must keep up.

### libp2p streams (duck-typed, no dependency)

```ts
await node.handle(GIT_LIBP2P_PROTOCOL, ({ stream }) => serveGitOverLibp2pStream(stream, serve));
transports.register(createLibp2pConnector({
  dial: (peer, protocol) => node.dialProtocol(peerIdFromString(peer), protocol),
}));
await git.fetch().setRemote(`libp2p://${peerId}/repo.git`).setTransports(transports).call();
```

Any `{ source, sink, closeWrite?, close? }` stream fits; `Duplex.end` is `closeWrite`.

### webrun-streams channels (WebRTC, LiveKit, any `Serve`)

```ts
const handler = serveGitOverWebrun(serve);      // register with the channel's serve
transports.register(createWebrunConnector({ name: "peer", schemes: ["peer"], call: () => call }));
```

`webrunClientDuplex` / `webrunServerDuplex` bridge a webrun `Duplex` and a transport
`Duplex` both ways through bounded queues (`createByteQueue`, 1 MiB by default).

### Any other stream

```ts
transports.register(createDuplexConnector({ name: "tcp", schemes: ["tcp"], open: (req) => openStream(req.url) }));
await serveGitConnection({ ...serve, duplex });
```

## Testing

Each FSM module has unit tests:

```
packages/vcs-transport/src/tests/unit/
├── fsm.test.ts                  # Core FSM tests (12 tests)
├── push-fsm.test.ts             # Push FSM tests (21 tests)
├── fetch-fsm.test.ts            # Fetch FSM tests (45 tests)
├── protocol-v2-fsm.test.ts      # Protocol V2 tests (44 tests)
└── error-recovery-fsm.test.ts   # Error recovery tests (36 tests)
```

Note: the package's `vitest.config.ts` only includes `tests/**/*.test.ts`, so
`pnpm --filter @statewalker/vcs-transport test` does not currently run these
files. The package-level tests live in `packages/vcs-transport/tests/`.

## Module Structure

```
packages/vcs-transport/src/
├── adapters/
│   ├── http/                # smart HTTP client and server
│   ├── libp2p-stream/       # git over a libp2p stream (duck-typed)
│   ├── messageport/         # git over a MessagePort (webrun-rpc)
│   ├── webrun/              # webrun-streams Duplex bridge, serveGitOverWebrun
│   ├── webrun-http/         # smart HTTP over a webrun Duplex
│   └── websocket/           # git over a WebSocket (binary frames)
├── api/
│   ├── duplex.ts            # Duplex stream interface
│   ├── repository-facade.ts # Repository operations facade
│   └── transport-api.ts     # Transport I/O interface
├── connect/
│   ├── git-url.ts           # parseGitUrl: remote URLs as git's transport_get reads them
│   ├── connector.ts         # GitTransportConnector, GitSession (native or smart HTTP)
│   ├── duplex-connector.ts  # createDuplexConnector: a connector over any byte stream
│   ├── registry.ts          # GitTransportRegistry, createDefaultTransports
│   └── open-session.ts      # openUploadPack / openReceivePack over a session
├── context/
│   ├── handler-output.ts    # Handler result accumulator
│   ├── process-config.ts    # FSM configuration options
│   ├── process-context.ts   # Complete context type
│   └── protocol-state.ts    # Protocol negotiation state
├── fsm/
│   ├── fsm.ts               # Core FSM implementation
│   ├── types.ts             # FSM type definitions
│   ├── push/                # Push FSM (client + server)
│   ├── fetch/               # Fetch FSM (client + server)
│   ├── protocol-v2/         # Protocol V2 FSM (client + server)
│   └── error-recovery/      # Error recovery FSM
└── tests/
    └── unit/                # Unit tests
```

## Related Documentation

- [Transport Package README](../README.md) - Package overview and public API
- [Transport Architecture](../ARCHITECTURE.md) - Overall architecture
