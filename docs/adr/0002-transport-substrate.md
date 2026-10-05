# ADR-0002 — Transport Substrate

**Status:** Accepted — 2026-07-29 (implemented)

Companion records: [ADR-0001 — Two-Axis Architecture](0001-two-axis-architecture.md),
[ADR-0003 — Large-Object Plane](0003-large-object-plane.md).

## Context

Before the two-axis refactor (ADR-0001), VCS carried its own transport plumbing: a bespoke
`Duplex` abstraction, a `vcs-transport-adapters` package to bridge it to concrete wires, and
four `vcs-port-*` packages (WebRTC, WebSocket, LiveKit, PeerJS) each re-implementing a
connection/signaling stack. That is duplicated substrate: the wider webrun ecosystem already
provides a general streaming transport seam in `webrun-streams`.

## Decision

**`webrun-streams` is the transport substrate, and VCS fully adopts its seam.**

VCS's git and sync protocols run as **webrun `Duplex` functions** over the `webrun-streams`
primitives — **`Connect` / `Serve` + `emulateMux`** for multiplexing multiple logical channels
over one connection. VCS **does not keep its own `Duplex`**: VCS's bespoke `Duplex` and the
`vcs-transport-adapters` Duplex-adapter role **retire**, superseded by this seam (see the
ADR-0001 migration table).

Concrete transports come from the webrun-streams family — VCS binds to whichever is available
rather than shipping its own:

- `webrun-streams-port` — in-process / MessagePort channels.
- `webrun-streams-ws` — WebSocket.
- `webrun-streams-webrtc` — WebRTC data channels.
- `webrun-streams-livekit` — LiveKit.
- `webrun-streams-peerjs` — PeerJS.
- `webrun-streams-libp2p` — libp2p.
- `webrun-http-streams` — **HTTP over `Duplex`**, for the git smart-HTTP protocol.

## Consequences

- The four `vcs-port-*` packages and the VCS `Duplex`/adapter layer collapse into the shared
  webrun-streams seam; P2P **signaling** helpers move to the webrun ecosystem
  (`@statewalker/webrun-streams-signaling`), not a vcs package.
- A single protocol implementation runs over every transport: the git v2 protocol and the sync
  protocol are `Duplex` functions, transport-agnostic by construction.

### As implemented

`vcs-transport-git` is the restructured `@statewalker/vcs-transport` (`packages/vcs-transport`):
the git protocol engine now runs over a webrun-streams `Duplex` (`adapters/webrun/`) and over
`webrun-http-streams` (`adapters/webrun-http/`), with **git protocol v2 wired** (client +
server, validated against real git). The `vcs-transport-adapters` package's old Duplex-adapter
role is retired; the package name survives as the storage-seam facade host
(`createStorageRepositoryFacade`) — see ADR-0001's "as implemented" note.
