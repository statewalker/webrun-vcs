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

Client and server implementations for push operations:

```typescript
import {
  clientPushTransitions,
  clientPushHandlers,
  serverPushTransitions,
  serverPushHandlers,
} from "@statewalker/vcs-transport";

// Client push
const clientFsm = new Fsm(clientPushTransitions, clientPushHandlers);
await clientFsm.run(context);

// Server push handler
const serverFsm = new Fsm(serverPushTransitions, serverPushHandlers);
await serverFsm.run(context);
```

**Client Push States:**
```
"" → DISCOVER_REFS → NEGOTIATE_CAPABILITIES → BUILD_COMMANDS
   → SEND_COMMANDS → SEND_PACK → READ_STATUS → ""
```

**Server Push States:**
```
"" → ADVERTISE_REFS → READ_COMMANDS → READ_PACK → VALIDATE_COMMANDS
   → EXECUTE_COMMANDS → SEND_STATUS → ""
```

### Fetch FSM

Client and server implementations for fetch/clone operations (Protocol V1):

```typescript
import {
  clientFetchTransitions,
  clientFetchHandlers,
  serverFetchTransitions,
  serverFetchHandlers,
} from "@statewalker/vcs-transport";

// Client fetch
const clientFsm = new Fsm(clientFetchTransitions, clientFetchHandlers);
await clientFsm.run(context);

// Server fetch handler
const serverFsm = new Fsm(serverFetchTransitions, serverFetchHandlers);
await serverFsm.run(context);
```

**Client Fetch States:**
```
"" → READ_ADVERTISEMENT → SEND_WANTS → SEND_SHALLOW_INFO
   → SEND_HAVES → READ_ACKS → SEND_DONE → READ_FINAL_ACK
   → RECEIVE_PACK → UPDATE_REFS → ""
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

Git Protocol V2 client and server implementations:

```typescript
import {
  clientV2Transitions,
  clientV2Handlers,
  serverV2Transitions,
  serverV2Handlers,
} from "@statewalker/vcs-transport";
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
const transitions = withErrorRecovery(clientV2Transitions);
const handlers = withErrorRecoveryHandlers(clientV2Handlers);

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

### Fetch with Error Recovery

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
  clientV2Transitions,
  clientV2Handlers,
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
const transitions = withErrorRecovery(clientV2Transitions);
const handlers = withErrorRecoveryHandlers(clientV2Handlers);
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

## Testing

Each FSM module has unit tests:

```
packages/transport/src/tests/unit/
├── fsm.test.ts                  # Core FSM tests (12 tests)
├── push-fsm.test.ts             # Push FSM tests (21 tests)
├── fetch-fsm.test.ts            # Fetch FSM tests (45 tests)
├── protocol-v2-fsm.test.ts      # Protocol V2 tests (44 tests)
└── error-recovery-fsm.test.ts   # Error recovery tests (36 tests)
```

Note: the package's `vitest.config.ts` only includes `tests/**/*.test.ts`, so
`pnpm --filter @statewalker/vcs-transport test` does not currently run these
files. The package-level tests live in `packages/transport/tests/`.

## Module Structure

```
packages/transport/src/
├── api/
│   ├── duplex.ts            # Duplex stream interface
│   ├── repository-facade.ts # Repository operations facade
│   └── transport-api.ts     # Transport I/O interface
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
