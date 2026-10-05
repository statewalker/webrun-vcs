# @statewalker/vcs-transport Architecture

## Design Philosophy

### FSM-Based Protocol Handling

Every Git protocol operation is implemented as a finite state machine (FSM). Each FSM has:
- **States** — Named protocol phases (e.g., `SENDING_WANTS`, `NEGOTIATING`, `RECEIVING_PACK`)
- **Events** — Triggers for state transitions (e.g., `REFS_RECEIVED`, `ACK_CONTINUE`, `PACK_RECEIVED`)
- **Handlers** — Functions executed on state entry, performing protocol I/O
- **Transitions** — `[source, event, target]` triples defining the state graph

This makes protocol logic explicit and testable. Each handler reads from or writes to the `TransportApi` (pkt-line/sideband I/O) and updates a shared `ProcessContext`.

### Three Abstraction Levels

```
Operations (fetch, push, clone, lsRemote)
    ↓ uses
Duplex Operations (fetchOverDuplex, pushOverDuplex, serveOverDuplex)
    ↓ uses
FSM Engine (Fsm + transitions + handlers)
    ↓ uses
TransportApi (pkt-line reader/writer, sideband read/write, pack streaming)
    ↓ uses
Duplex (bidirectional async byte stream)
```

### Protocol Independence from Storage

The transport layer never touches storage directly. Two interfaces provide the bridge:

- **`RepositoryFacade`** — Pack-level operations: export packs, import packs, check object existence, walk ancestry. Used by FSM handlers for pack generation and consumption.
- **`RepositoryAccess`** — Object-level operations: CRUD on objects and refs, HEAD resolution. Used by higher-level server code.

Storage adapters that implement these interfaces live in the separate `@statewalker/vcs-transport-adapters` package.

### Web Standard APIs

All I/O uses Web platform primitives:
- `AsyncIterable<Uint8Array>` for streaming
- `Request`/`Response` for HTTP
- `MessagePort` for cross-context communication
- No Node.js dependencies in the transport package

## Module Structure

```
packages/transport/src/
├── api/                    # Core interfaces
│   ├── credentials.ts      #   Authentication types
│   ├── duplex.ts           #   Bidirectional stream interface
│   ├── fetch-result.ts     #   FetchResult, ServeResult, RawFetchResult
│   ├── push-result.ts      #   PushResult, RefPushStatus
│   ├── options.ts          #   Base option interfaces
│   ├── repository-access.ts #  Server-side repo interface
│   ├── repository-facade.ts #  Transport-layer repo interface
│   └── transport-api.ts    #   Git wire protocol I/O interface
│
├── fsm/                    # Protocol state machines
│   ├── fsm.ts              #   FSM engine (run, transition, handler dispatch)
│   ├── types.ts            #   FsmTransition, FsmStateHandler
│   ├── fetch/              #   Fetch protocol FSMs
│   │   ├── client-fetch-fsm.ts  # Client-side fetch (39 handlers, 49 transitions)
│   │   ├── server-fetch-fsm.ts  # Server-side fetch (43 handlers, 44 transitions)
│   │   └── types.ts             # ClientFetchEvent, ServerFetchEvent
│   ├── push/               #   Push protocol FSMs
│   │   ├── client-push-fsm.ts   # Client-side push (25 handlers, 32 transitions)
│   │   ├── server-push-fsm.ts   # Server-side push (41 handlers, 41 transitions)
│   │   └── types.ts             # PushCommand, PushCommandType, PushCommandResult
│   ├── protocol-v2/        #   Protocol V2 FSMs
│   │   ├── client-v2-fsm.ts     # V2 client fetch
│   │   ├── server-v2-fsm.ts     # V2 server fetch
│   │   └── types.ts             # FetchV2Request, FetchV2ResponseSection
│   └── error-recovery/     #   Error handling FSM
│       ├── error-classifier.ts   # classifyError
│       └── error-recovery-fsm.ts # Retry, reconnect, escalate
│
├── operations/             # High-level operations
│   ├── fetch.ts            #   HTTP fetch
│   ├── push.ts             #   HTTP push
│   ├── clone.ts            #   HTTP clone
│   ├── ls-remote.ts        #   HTTP ls-remote
│   ├── fetch-over-duplex.ts    # Duplex fetch
│   ├── fetch-v2-over-duplex.ts # Duplex fetch (protocol v2)
│   ├── push-over-duplex.ts     # Duplex push
│   ├── serve-over-duplex.ts    # Duplex server
│   └── p2p-sync.ts             # Bidirectional P2P sync
│
├── protocol/               # Git wire format
│   ├── constants.ts        #   Protocol constants (pkt markers, capabilities, etc.)
│   ├── pkt-line-codec.ts   #   Pkt-line encode/decode
│   ├── sideband.ts         #   Sideband encode/demultiplex
│   ├── capabilities.ts     #   Capability parsing and negotiation
│   ├── ack-nak.ts          #   ACK/NAK parsing and formatting
│   ├── advertisement-parser.ts # Ref advertisement parsing (internal)
│   ├── report-status.ts    #   Push report-status parsing
│   ├── errors.ts           #   Transport error classes
│   ├── pack-utils.ts       #   Pack utilities (empty pack creation, internal)
│   ├── git-request-parser.ts   # Git protocol request parsing
│   └── types.ts            #   Packet, RefAdvertisement, ProgressInfo, etc.
│
├── adapters/               # Transport adapters
│   ├── http/               #   Smart-HTTP client and server handlers
│   ├── messageport/        #   MessagePort ↔ Duplex
│   ├── webrun/             #   webrun-streams Duplex ↔ transport Duplex
│   ├── webrun-http/        #   Smart-HTTP over a webrun-streams Duplex
│   └── socket/             #   Socket adapter (not exported from the package index)
│
├── context/                # FSM execution context
│   ├── context-adapters.ts #   Typed getters/setters for ProcessContext
│   ├── handler-output.ts   #   HandlerOutput
│   ├── protocol-state.ts   #   ProtocolState
│   └── process-*.ts        #   ProcessConfiguration, ProcessContext, RefStore
│
├── factories/              # Factory functions
│   ├── repository-facade-factory.ts  # RepositoryFacade from History
│   └── transport-api-factory.ts      # TransportApi from Duplex
│
└── utils/                  # Utilities
    ├── pack-stream-reader.ts #  Pack stream reading
    ├── refspec.ts           #   RefSpec parsing and matching
    └── uri.ts               #   Git URL parsing and formatting
```

## Protocol Flow

### Fetch (Client-Side FSM)

```
START → [send ref request]
  ↓ REFS_RECEIVED
PROCESS_REFS → [compute wants from remote refs]
  ↓ WANTS_SENT
NEGOTIATE → [send haves, process ACK/NAK]
  ↓ DONE_SENT
RECEIVE_PACK → [import pack via sideband]
  ↓ PACK_RECEIVED
UPDATE_REFS → [update local refs]
  ↓ REFS_UPDATED
DONE
```

### Push (Client-Side FSM)

```
START → [read server advertisement]
  ↓ REFS_RECEIVED
COMPUTE_UPDATES → [diff local vs remote refs]
  ↓ COMMANDS_SENT
SEND_PACK → [generate and send pack]
  ↓ PACK_SENT
READ_STATUS → [parse report-status response]
  ↓ STATUS_RECEIVED
DONE
```

### Server Fetch (Upload-Pack)

```
START → [send ref advertisement with capabilities]
  ↓ REFS_SENT
RECEIVE_WANTS → [validate client wants]
  ↓ WANTS_RECEIVED
NEGOTIATE → [process haves, send ACK/NAK]
  ↓ READY / DONE_RECEIVED
SEND_PACK → [generate pack, send via sideband]
  ↓ PACK_SENT
DONE
```

## Key Concepts

### Duplex Interface

The `Duplex` interface abstracts any bidirectional byte stream:

```typescript
interface Duplex {
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
  write(data: Uint8Array): void;
  close?(): Promise<void>;
}
```

HTTP, MessagePort, and webrun-streams channels are all adapted to this interface. Operations like `fetchOverDuplex` work with any `Duplex`, making the protocol transport-agnostic.

### TransportApi

The `TransportApi` wraps a `Duplex` with Git protocol-aware I/O:

```typescript
interface TransportApi {
  readPktLine(): Promise<PktLineResult>;
  writePktLine(data: string | Uint8Array): Promise<void>;
  writeFlush(): Promise<void>;
  writeDelimiter(): Promise<void>;
  readLine(): Promise<string | null>;
  writeLine(line: string): Promise<void>;
  readSideband(): Promise<SidebandResult>;
  writeSideband(channel: 1 | 2 | 3, data: Uint8Array): Promise<void>;
  readPack(): AsyncGenerator<Uint8Array>;
  readRawPack(): AsyncGenerator<Uint8Array>;
  writePack(data: AsyncIterable<Uint8Array>): Promise<void>;
  writeRawPack(data: AsyncIterable<Uint8Array>): Promise<void>;
  close?(): Promise<void>;
}
```

### ProcessContext

FSM handlers communicate through a typed key-value context (`ProcessContext`). Typed accessor pairs ensure type safety:

```typescript
const [getRefStore, setRefStore] = newAdapter<RefStore>("refStore");

// In handler:
const refs = getRefStore(ctx);
```

### RepositoryFacade vs RepositoryAccess

Two interfaces bridge transport and storage:

- **`RepositoryFacade`** — Optimized for pack-based protocol operations. Exposes pack export/import, ancestry walking, reachability checking. Used by FSM handlers. Created via `createVcsRepositoryFacade()` or `createStorageRepositoryFacade()` (in `@statewalker/vcs-transport-adapters`), or `createRepositoryFacade()` (in this package).

- **`RepositoryAccess`** — Optimized for object-level server operations. Exposes object/ref CRUD, HEAD resolution, graph walking. Used by HTTP server routing. Created via `createVcsRepositoryAccess()`.

Both are implemented in `@statewalker/vcs-transport-adapters`.

## Pkt-Line Format

Git uses pkt-line framing for all protocol messages:

```
┌──────────────────────────────────────┐
│ 4-byte hex length │ payload          │
├──────────────────────────────────────┤
│ "001e"            │ "# service=..."  │
└──────────────────────────────────────┘

Special packets:
  0000  flush-pkt   End of message/section
  0001  delim-pkt   Section delimiter (v2)
  0002  response-end End of response (v2)
```

## Sideband Multiplexing

Pack data and progress messages share a single connection via sideband channels:

```
Channel 1: Pack data
Channel 2: Progress messages (stderr)
Channel 3: Fatal error messages
```

Each pkt-line payload starts with a channel byte, followed by channel-specific data.

## Capability Negotiation

During initial ref advertisement, both sides announce supported features. The intersection determines available protocol modes:

| Capability | Purpose |
|------------|---------|
| `multi_ack_detailed` | Detailed ACK responses during negotiation |
| `thin-pack` | Deltified objects referencing base outside pack |
| `side-band-64k` | Multiplex data/progress/errors |
| `ofs-delta` | Offset-based delta references |
| `include-tag` | Auto-include tags for fetched commits |
| `shallow` | Shallow clone support |
| `report-status` | Return status after push |
| `atomic` | All-or-nothing ref updates |

## Protocol V2

Protocol V2 uses explicit command-based communication:

```
command=fetch
agent=statewalker-vcs/1.0
capability=thin-pack
0001
want <oid>
have <oid>
done
0000
```

Supported V2 commands: `ls-refs`, `fetch`, `object-info`.

## Error Recovery

The error recovery FSM classifies errors and determines retry strategy:

```
ERROR → [classify: network/protocol/auth/server]
  ↓ RETRIABLE
WAITING → [backoff delay]
  ↓ RETRY
RECONNECT → [re-establish connection]
  ↓ SUCCESS / MAX_RETRIES
DONE / FAILED
```
