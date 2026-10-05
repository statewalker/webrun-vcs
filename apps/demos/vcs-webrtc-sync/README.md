# VCS WebRTC Sync Demo

## What it is

A Vite single-page app for syncing a Git repository between two browser windows over a WebRTC data channel, with signaling done by copy-paste. Each window keeps a repository over a folder picked with the File System Access API or over in-memory storage, and can stage, commit, restore, and push to or fetch from the connected peer using the Git wire protocol from `@statewalker/vcs-transport`. No application server is involved; the connection uses public STUN servers for address discovery.

## Layout

```
index.html
src/
  main.ts                    creates the context, models, controllers and views
  models/                    observable state (RepositoryModel, FileListModel, StagingModel,
                             CommitHistoryModel, CommitFormModel, ConnectionModel,
                             SharingFormModel, ActivityLogModel, UserActionsModel)
  controllers/
    storage-controller.ts    folder (BrowserFilesApi) or memory (MemFilesApi)
    repository-controller.ts Git.init(), status, stage/unstage, commit, history, restore, sample files
    webrtc-controller.ts     PeerConnection, offer/answer, compressed signal strings
    sync-controller.ts       push / fetch over the peer connection
    main-controller.ts       dispatches UserActionsModel actions to controllers
  views/                     DOM rendering per panel
  utils/                     adapter/registry helpers, BaseClass, transport-helpers.ts
tests/models.test.ts         Vitest tests for the models
docs/ARCHITECTURE.md         the MVC structure in detail
```

```
View ──action──> UserActionsModel ──> main-controller ──> controllers ──> FilesApi / Git / WebRTC
  ^                                                            |
  └───────────── onUpdate() ◄─────── models ◄──── update ──────┘

RTCDataChannel ─ byteChannelFromDataChannel ─ emulateMux ─ webrunClientDuplex ─ fetchOverDuplex / pushOverDuplex
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the patterns (context adapters, registries, user actions).

## How to run it

1. `pnpm install && pnpm build` at the repository root (Node 24); the `@statewalker/vcs-*` packages resolve to their built `dist/`.
2. Start the dev server and open its URL (`http://localhost:5173` by default) in two windows:

   ```bash
   pnpm --filter @statewalker/vcs-demo-webrtc-sync dev
   ```

3. In each window choose **Open Folder** (Chrome, Edge) or **Memory Storage** (any browser), then **Initialize Repository**. **Create Sample Files** adds a few markdown files.
4. Stage files with **+** (unstage with **-**), type a message and **Commit**.
5. Connect the windows:
   1. Window A: **Share**, then **Copy to Clipboard** and paste the offer into window B.
   2. Window B: **Connect**, paste the offer, **Accept Offer**, copy the answer back to window A.
   3. Window A: paste the answer, **Accept Answer**. The indicator changes from **Not Connected** when the data channel opens.
6. Use **Push** and **Fetch**.

## How syncing works

```typescript
// sync-controller.ts / utils/transport-helpers.ts
const mux = emulateMux(byteChannelFromDataChannel(channel), { side }); // "initiator" | "responder"

// Fetch: peer branches land in refs/remotes/peer/*
await fetchOverDuplex({
  duplex: webrunClientDuplex(mux.call),
  repository: createVcsRepositoryFacade({ history, serialization: new DefaultSerializationApi({ history }) }),
  refStore,                       // adapter over history.refs
  refspecs: ["+refs/heads/*:refs/remotes/peer/*"],
});

// Push: local main overwrites the peer's main
await pushOverDuplex({ duplex: webrunClientDuplex(mux.call), repository, refStore,
  refspecs: ["refs/heads/main:refs/heads/main"] });
```

The two sides take opposite `side` values so multiplexed stream ids do not collide. `servePeer(mux, history)` in `transport-helpers.ts` registers a side as a Git server with `serveRepoOverWebrun()`.

## Why it is the way it is

- **Views talk only to models.** Views enqueue actions on `UserActionsModel` and re-render on model updates; only controllers touch the file system, Git and WebRTC. This keeps the views free of side effects and lets the models be unit-tested without a browser (`tests/models.test.ts`).
- **Real Git protocol over the data channel.** The data channel is wrapped as a byte channel and multiplexed, and each push or fetch is a normal upload-pack/receive-pack exchange, so the same transport code would work over HTTP.
- **Manual signaling.** Offers and answers are compressed, encoded strings that the user copies between windows, so no signaling server is needed.
- **Polling the folder.** With a real folder the app re-reads the working directory every 3 seconds, so edits made in an editor show up without a file-watcher API.

## What will surprise you

- **Nothing serves the Git requests.** `servePeer()` is defined but never called, so neither window answers the other's push or fetch over the data channel. The receiving multiplexer answers every call with `emulateMux: no handler registered`, and the activity log shows `Push failed: <reason>` or `Fetch failed: <reason>`. `serveRepoOverWebrun()` also serves only `git-upload-pack` by default, so even once registered it answers fetches, not pushes.
- **Commits are not written to the folder.** `Git.init()` always creates an in-memory history; with **Open Folder** your files and `.git/index` are on disk, but objects and refs are not. After a reload the folder's `.git` is detected (`Opened existing repository`) but the history starts empty.
- **Restore moves `main`.** **Restore** writes the commit's tree into the working directory and sets `refs/heads/main` to that commit, so later commits drop out of the history list. It is refused with `Cannot restore: uncommitted changes exist` while there are changes.
- **Push overwrites the peer's `main`**, not a remote-tracking ref. Fetch writes `refs/remotes/peer/*` and leaves your branch alone.
- **No conflict handling in the UI.** `detectConflicts()` and `resolveConflict()` exist in the sync controller but nothing calls them; `resolveConflict()` only logs.
- **Open Folder needs the File System Access API** (Chrome, Edge). Elsewhere use **Memory Storage**.
- **NAT traversal uses STUN only** (`stun.l.google.com`). Without a TURN server, peers behind restrictive NATs may not connect; two windows on one machine work.

## Reference

### Commands

| Command | What it does |
|---|---|
| `pnpm --filter @statewalker/vcs-demo-webrtc-sync dev` | Vite dev server |
| `pnpm --filter @statewalker/vcs-demo-webrtc-sync build` | Production build to `dist/` |
| `pnpm --filter @statewalker/vcs-demo-webrtc-sync preview` | Serve the production build |
| `pnpm --filter @statewalker/vcs-demo-webrtc-sync test` | Vitest model tests |
| `pnpm --filter @statewalker/vcs-demo-webrtc-sync test:watch` | Vitest in watch mode |
| `pnpm --filter @statewalker/vcs-demo-webrtc-sync typecheck` | `tsc --noEmit` |

### Dependencies

| Package | Used for |
|---|---|
| `@statewalker/vcs-commands` | `Git.init()`, add, commit |
| `@statewalker/vcs-core` | History types, `DefaultSerializationApi` |
| `@statewalker/vcs-store-files` | `FileStagingStore` for `.git/index` in a real folder |
| `@statewalker/vcs-working-tree` | `WorkingCopy` type |
| `@statewalker/vcs-transport` | `fetchOverDuplex`, `pushOverDuplex`, `webrunClientDuplex`, `serveRepoOverWebrun` |
| `@statewalker/vcs-transport-adapters` | `createVcsRepositoryFacade` |
| `@statewalker/webrun-streams` | `emulateMux` |
| `@statewalker/webrun-streams-signaling` | `PeerConnection`, signal encoding, `byteChannelFromDataChannel` |
| `@statewalker/webrun-files`, `-files-browser`, `-files-mem` | `FilesApi`, `BrowserFilesApi`, `MemFilesApi` |
