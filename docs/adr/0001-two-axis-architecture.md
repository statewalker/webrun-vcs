# ADR-0001 — Two-Axis Architecture

**Status:** Accepted — 2026-07-29 (implemented)

Companion records: [ADR-0002 — Transport Substrate](0002-transport-substrate.md),
[ADR-0003 — Large-Object Plane](0003-large-object-plane.md). Together these three ADRs
supersede [`ARCHITECTURE.md`](../../ARCHITECTURE.md) as the authoritative description of
the StateWalker VCS architecture.

## Context

`@statewalker/vcs-*` began as a Git-wire-compatible, pure-TypeScript VCS in which file
synchronisation (the `vcs-transport` package and the four `vcs-port-*` P2P adapters) was
welded onto the Git object core. Two forces pushed on that shape at once: a request to
**considerably simplify** the implementation, and a request to **add rclone-style file-sync
features**. Most of what "sync" needs — copy, mirror, bidirectional reconciliation — has
nothing to do with Git objects, refs, or packs.

The design that survived an 8-surface planning grill models the system as **two orthogonal,
independent axes over one working tree**:

- **Axis A — file sync** (rclone-like): move bytes between two file trees.
- **Axis B — versioning** (Git-like): record, address, and exchange immutable history.

The simplification *is* the axis split: carve the git-independent sync axis out, extract the
shared engines (`merge-core`, `storage`, `content-store`) down out of the git core, reuse the
existing `@statewalker/webrun-files*` FilesApi ecosystem for all generic filesystem features
(COW / overlay / read-only view), and re-draw package boundaries around the two axes so each
vcs package holds only git or rclone code. This ADR pins that target. It has since been
**implemented** in this repository; where the build refined the plan, the "as implemented"
notes below record the divergence honestly.

## Decision

### The two axes and their operations

One working tree, two engines, disjoint operation vocabularies:

| Axis | Engine package | Operations |
| --- | --- | --- |
| **A — file sync** | `files-sync` | `copy`, `sync`, `bisync`, `move`, `check` |
| **B — versioning** | `vcs-core` | `status`, `commit`, `checkout`, `log`, `diff`, `merge`, `fetch`, `push` |

### The bidirectional dependency ban

The two engines are independent. Stated in quotable words:

> **`files-sync` and `vcs-core` may not depend on each other in either direction.**

There is no `files-sync → vcs-core` edge and no `vcs-core → files-sync` edge. `files-sync`
compiles, tests, and ships with no git code on its path; `vcs-core` compiles, tests, and ships
with no sync code on its path. The forbidden edge is `files-sync ↔ vcs-core`, both directions.

### Cross-axis composition is orchestration-only

All cross-axis composition lives **only in the `workspace` orchestration layer** — including
automatic commits after a sync, expressed as an explicit `SyncVersioningPolicy` object that
`workspace` owns and applies. Neither engine performs cross-axis work, and **neither engine
has a hidden `sync()` side effect**: `vcs-core.commit()` never triggers a file sync, and
`files-sync.sync()` never triggers a commit. If a workflow wants "sync then commit", the
`workspace` layer sequences the two engine calls under a `SyncVersioningPolicy`; the engines
themselves stay single-axis.

### The shared three-way merge engine over FilesApi

`merge-core` is a **domain-neutral engine with no git and no sync knowledge**. It performs
three-way merge/diff over **three `FilesApi` instances — base / left / right** — and returns a
merged tree plus a conflict set. It knows nothing about commits, refs, packs, sync anchors, or
remotes; it only sees three file trees.

Both axes build their **FilesApi triple independently** and feed the same `merge-core`:

- **Axis B** produces its triple from history: `base` = merge-base version, `left`/`right` =
  the two commit versions, each exposed as a `FilesApi` (see below).
- **Axis A** produces its triple from a sync baseline: `base` = the `SyncAnchor` snapshot,
  `left`/`right` = the two live file trees.

One merge engine, two callers, no shared git/sync types between them.

### Axis B exposes version → FilesApi and a COW working tree

`vcs-working-tree` (Axis B) exposes **any git version as a read-only `FilesApi`**, and a
**copy-on-write working tree** (a version plus a COW overlay). These are built on **generic
`@statewalker/webrun-files` primitives — read-only view / union-overlay / copy-on-write** —
*not* on a vcs-specific filesystem layer. A checkout is "version-as-FilesApi under a COW
overlay"; edits land in the overlay, the version stays immutable, and `merge-core` can read
any of these trees because they are all just `FilesApi`.

### The 11 architecture packages

There is **no vcs `files-core`**. The FilesApi seam is the **external
`@statewalker/webrun-files*` ecosystem**; generic filesystem features (COW, overlay, read-only)
are added *there*, and vcs packages hold only git/rclone code. The target is 11 packages, each
of which depends on `@statewalker/webrun-files` for its `FilesApi` type:

| # | Package | Responsibility | Status |
| --- | --- | --- | --- |
| 1 | `merge-core` | Domain-neutral three-way merge/diff over three `FilesApi` (base/left/right); no git/sync knowledge. | implemented |
| 2 | `storage` | Shared-infra backend seam exposing the `ObjectStore` / `RefStore` / `IndexStore` interfaces; pluggable adapters (mem/files/sql/kv). | implemented |
| 3 | `content-store` | Domain-neutral content-defined-chunk / object store with an injected content hash (BLAKE3-class); ids opaque; shared by both axes (see ADR-0003). | implemented |
| 4 | `content-transfer` | have/want negotiation and deduplicated chunk/object transfer between two `content-store`s. | implemented |
| 5 | `files-sync` | Axis A rclone-style engine: `copy`/`sync`/`bisync`/`move`/`check`; plan-then-execute over a `SyncAnchor` baseline. | implemented |
| 6 | `vcs-core` | Axis B git object/versioning engine over the `storage` seam; `VcsCore` facade. | implemented |
| 7 | `vcs-working-tree` | Exposes any git version as a read-only `FilesApi` and a COW working tree on `webrun-files` primitives; hosts the optional LFS clean/smudge skin. | implemented |
| 8 | `vcs-transport-git` | Git wire protocol (v1 + v2) as a webrun `Duplex` and over `webrun-http-streams` (see ADR-0002). | implemented |
| 9 | `vcs-transport-lfs` | Git-LFS pointer/batch transfer skin over `content-store` (see ADR-0003). | implemented |
| 10 | `vcs-transport-xet` | Xet-style chunk-dedup transfer skin over `content-store`. | implemented |
| 11 | `workspace` | Orchestration layer binding both axes; owns `SyncVersioningPolicy`; the **only** package allowed to do cross-axis composition. | implemented (`@statewalker/vcs-workspace`) |

`storage` is **shared infrastructure**: it is the backend boundary both axes reach for
persistence, and it exposes the `ObjectStore` / `RefStore` / `IndexStore` interface that all
storage backends implement.

### Allowed dependency edges

- **Every** architecture package depends on `@statewalker/webrun-files` for `FilesApi`.
- `content-store → storage`
- `content-transfer → content-store`
- `files-sync → merge-core, content-store, content-transfer`
- `vcs-core → storage`
- `vcs-working-tree → vcs-core, merge-core` (version → FilesApi + COW; feeds the merge triple)
- `vcs-transport-git → vcs-core` · `vcs-transport-lfs → content-store` ·
  `vcs-transport-xet → content-store`
- `workspace → files-sync, vcs-core, vcs-working-tree, vcs-transport-*`
- **Forbidden:** `files-sync ↔ vcs-core` (neither direction — see the ban above).

### Migration table — the 16-name universe

The current tree is exactly these 16 packages. Each maps to **exactly one row** below (no
name appears in two rows). Dispositions are drawn from
`{reuse-as-is, rewrite, split, merge, retire, becomes-adapter}`; the target is `—` only when
`retire`, otherwise one of the 11 architecture packages, an auxiliary target (`vcs-testing`,
`integration-tests`), or an external reuse target (`@statewalker/webrun-files*` /
`webrun-streams*`).

| # | Current package | Disposition | Target | Note |
| --- | --- | --- | --- | --- |
| 1 | `vcs-core` | `rewrite` | `vcs-core` | Re-based onto the `storage` seam via adapters + a normalized `VcsCore` facade. Kept the existing 176-file git engine. SHA-1 only for now — **sha256 deferred** (`VcsCore.hash` returns `"sha1"`). |
| 2 | `vcs-commands` | `merge` | `vcs-core` | High-level git ops fold into the versioning engine (and, where they touch the working tree, are sequenced by `workspace`). |
| 3 | `vcs-utils` | `split` | `vcs-core`, `merge-core` | Hash/delta/pack/varint → `vcs-core`; Myers text diff → `merge-core`. |
| 4 | `vcs-utils-node` | `merge` | `vcs-core` | Node-native compression folds into the `vcs-core` platform layer. |
| 5 | `vcs-transport` | `split` | `vcs-transport-git`, `vcs-transport-lfs`, `vcs-transport-xet` | Git wire protocol → `vcs-transport-git` (**git protocol v2 wired**, client + server, validated against real git); large-object transfer → the LFS/xet siblings. |
| 6 | `vcs-transport-adapters` | `retire` | `—` | Old Duplex-adapter role **superseded by `webrun-streams`**. (As implemented, the package survives as the storage-seam facade host — see the "as implemented" note below.) |
| 7 | `vcs-store-files` | `rewrite` | `storage` | Rewritten as an `ObjectStore`/`RefStore`/`IndexStore` file adapter. |
| 8 | `vcs-store-sql` | `rewrite` | `storage` | Rewritten as a SQLite backend adapter. |
| 9 | `vcs-store-kv` | `rewrite` | `storage` | Rewritten as a key-value backend adapter. |
| 10 | `vcs-store-mem` | `reuse-as-is` | `storage` | In-memory backend adapter, reused unchanged. |
| 11 | `vcs-port-webrtc` | `retire` | `—` | **Superseded by `webrun-streams`** (`webrun-streams-webrtc`); P2P signaling helpers relocated to the webrun ecosystem. |
| 12 | `vcs-port-websocket` | `retire` | `—` | **Superseded by `webrun-streams`** (`webrun-streams-ws`). |
| 13 | `vcs-port-livekit` | `retire` | `—` | **Superseded by `webrun-streams`** (`webrun-streams-livekit`). |
| 14 | `vcs-port-peerjs` | `retire` | `—` | **Superseded by `webrun-streams`** (`webrun-streams-peerjs`); P2P signaling helpers relocated to the webrun ecosystem. |
| 15 | `vcs-testing` | `reuse-as-is` | `vcs-testing` | Shared test helpers/fixtures (auxiliary target). |
| 16 | `vcs-integration-tests` | `reuse-as-is` | `integration-tests` | Cross-package e2e suite (auxiliary target). |

The four `vcs-store-*` all land in `storage` as adapters (`vcs-store-mem` reused as-is, the
other three rewritten). The four `vcs-port-*` **and** `vcs-transport-adapters` are `retire`d,
superseded by `webrun-streams`; none is `reuse-as-is`, and the P2P **signaling** helpers are
relocated to the **webrun ecosystem**, not into any vcs package (as implemented:
`@statewalker/webrun-streams-signaling`).

### bisync safety and the operational model

- **`bisync` is a three-way merge over a sync-owned `SyncAnchor` baseline**, *not* two chained
  one-way syncs. `files-sync` records a `SyncAnchor` snapshot of the last agreed state; the
  next `bisync` diffs both sides against that anchor (base = anchor, left/right = the two live
  trees) through `merge-core`. Chaining two one-way syncs would silently lose or resurrect
  files; the three-way form does not.
- **Conflicts are first-class data**, not exceptions. A `bisync` returns an enumerated conflict
  set with an explicit policy applied per conflict (e.g. `newer`, `larger`, `left`, `right`,
  `manual`) — a closed policy set, not free-form callbacks.
- **Both engines are on-demand, plan-then-execute.** Every operation first computes a plan
  (the set of actions) which can be inspected/dry-run, then executes it. There is no ambient
  running process.
- **Live / watch / daemon sync is out of scope.** No filesystem watchers, no long-running
  reconciler.
- **Backends are capability-negotiated.** An operation queries what a backend can do (ranged
  reads, server-side copy, hashing) and plans within those capabilities rather than assuming a
  full POSIX filesystem.

### The 6-phase migration plan

Six ordered phases, each naming its target-package subset. **Phase 1 is explicitly
git-independent** — it builds and ships the entire file-sync axis with no dependency on
`vcs-core`.

1. **Phase 1 — File-sync core (git-independent):** `merge-core`, `storage`, `content-store`,
   `content-transfer`, `files-sync`. No `vcs-core` on the path — Axis A stands alone.
2. **Phase 2 — Versioning engine on the storage seam:** `vcs-core` re-based onto `storage`
   (adapters + `VcsCore` facade); absorb `vcs-commands`, `vcs-utils`, `vcs-utils-node`.
3. **Phase 3 — Version → FilesApi working tree:** `vcs-working-tree` (read-only FilesApi + COW
   overlay on `webrun-files` primitives).
4. **Phase 4 — Transport substrate adoption:** `vcs-transport-git` (webrun `Duplex` +
   `webrun-http-streams`, git v2); retire the `vcs-transport-adapters` Duplex role and the four
   `vcs-port-*`.
5. **Phase 5 — Large-object skins:** `vcs-transport-lfs`, `vcs-transport-xet` over
   `content-store`.
6. **Phase 6 — Orchestration:** `workspace` (`SyncVersioningPolicy`) binding `files-sync`,
   `vcs-core`, `vcs-working-tree`, and the `vcs-transport-*` skins.

### Pinned defaults, deferred questions, and rationale

**Pinned defaults:**

- **Remote model:** plain **file-mirror (model A) is the default**; the **manifest-tree
  (model B) is opt-in**. A remote is a mirrored file tree unless a workflow explicitly opts
  into a manifest-tree remote.
- **Live / watch / daemon sync is out of scope** (pinned, not deferred).

**Explicitly deferred (none resolved by this ADR):**

- **Blob threshold** — the size at which a file routes to the large-object plane.
- **Encryption / identity model** — how content is encrypted and identities established.
- **Conflict-resolution mechanism** — the concrete UI/merge-driver mechanism beyond the
  policy set above.

These three are open; this ADR pins the *seams* around them, not the answers.

**Rationale.** This change **adds target surface now** (11 packages, three new shared-infra
engines) **specifically to reduce coupling across the phased migration**. The extra packages
are not complexity for its own sake — **the axis split is the simplification**: it severs the
git↔sync weld, lets most of "sync" ship without git, and gives each later phase a small,
independently-contractable slice to build against a stable boundary.

## Consequences

- Axis A ships without git; Axis B ships without sync; the only place they meet is `workspace`.
- A single domain-neutral `merge-core` serves both axes, so three-way reconciliation is written
  and tested once.
- Storage backends and remote transports become adapters behind stable seams (`storage`,
  `webrun-streams`), collapsing the four `vcs-store-*` and four `vcs-port-*` packages.
- The migration is inspectable phase by phase; each phase is graded against this ADR.

### As implemented — divergences from the plan

- **`vcs-transport-git` is the restructured `@statewalker/vcs-transport`** (`packages/vcs-transport`),
  not a brand-new package: the existing v1 git protocol engine, now also running over a
  webrun-streams `Duplex` (`adapters/webrun/`) and over `webrun-http-streams`
  (`adapters/webrun-http/`), with **git protocol v2 wired** (client + server, validated against
  real git). Its object exchange is bindable to the storage-seam core via
  `vcs-transport-adapters`' `createStorageRepositoryFacade`.
- **`vcs-transport-adapters` survives** as an implementation package — it now hosts the
  storage-seam facade (`createStorageRepositoryFacade`) — **even though its migration-table
  disposition is `retire`.** Honestly: its old Duplex-adapter role is retired (superseded by
  `webrun-streams`); the package name lives on as the storage-seam facade host.
- **`vcs-core` kept its existing 176-file git engine**, re-based onto the `@statewalker/webrun-storage`
  seam via adapters plus a normalized `VcsCore` facade. **sha256 is deferred** — SHA-1 only for
  now; `VcsCore.hash` returns `"sha1"`.
- **`content-store` uses an injected `hashContent`** (opaque ids), not intrinsic BLAKE3 (see
  ADR-0003).
- **The four `vcs-port-*` packages are actually deleted**; P2P signaling was relocated to
  `@statewalker/webrun-streams-signaling` (in webrun-wire). `vcs-working-tree`, `workspace`,
  `merge-core`, `storage`, `files-sync`, `content-transfer`, and `vcs-transport-lfs`/`-xet` are
  all built and tested.
