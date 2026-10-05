# WebRTC P2P Git Sync Demo

## What it is

A Vite single-page app that syncs Git repositories between browsers over WebRTC data channels, using PeerJS for signaling. One browser hosts a session and shares its id (as text, a URL or a QR code); others join it. Each **Sync** fetches the peer's branches with the Git wire protocol from `@statewalker/vcs-transport`, merges if the histories diverged, and pushes `main` back. A repository lives in memory or in a folder opened through the File System Access API, stored in Git's on-disk format.

## Layout

```
index.html
src/
  main.ts                    context, controllers, views; reads #session=<id> from the URL;
                             handles the "open repository" intent (folder picker or in-memory)
  controllers/
    git-infrastructure.ts    initializeGitInMemory(), initializeGitFromFiles(files)
    repository-controller.ts init, open, add file, stage/unstage, commit, checkout, refresh
    session-controller.ts    host / join / disconnect via PeerJS
    sync-controller.ts       per-peer Git server; Sync = fetch -> merge if diverged -> push
    main-controller.ts       wires the controllers
  services/
    git-peer-server.ts       setupGitPeerServer(): serveOverDuplex loop on a MessagePort
    git-peer-session.ts      createGitPeerSession(): fetchOverDuplex / pushOverDuplex
  adapters/                  PeerJS DataConnection / MessagePort duplex, ref store adapter
  apis/                      PeerJS, connection providers (PeerJS, in-memory), timer
  actions/ intents/          typed user actions and intents (views -> controllers)
  models/ views/ utils/      observable state, DOM rendering, registry/adapter helpers
  lib/                       session ids, share URLs, QR codes
tests/                       Vitest tests, including a two-peer sync over in-memory connections
tests/fixtures/test-repo/    a native repository (".git" stored as "dot-git") used by the tests
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the MVC structure, context adapters and user actions.

```
Views ──enqueue actions──▶ UserActionsModel ──dispatch──▶ Controllers
  ▲                                                           │
  └────────────── subscribe ◀────────── update ───────── Models

PeerJS DataConnection ─ MessagePort ─ Duplex ─ fetchOverDuplex / pushOverDuplex   (client side)
                                            └─ serveOverDuplex                     (server side, every peer)
```

## How to run it

1. `pnpm install && pnpm build` at the repository root (Node 24); the `@statewalker/vcs-*` packages resolve to their built `dist/`.
2. Start the dev server and open its URL (`http://localhost:5173` by default) in two windows or on two devices:

   ```bash
   pnpm --filter @statewalker/vcs-demo-webrtc-p2p-sync dev
   ```

3. In the first window, **Initialize Repository** (writes `README.md` and commits it in memory) or **Open Repository** (pick a folder; without the File System Access API this falls back to in-memory). **Add File** writes and commits a file; the Files panel stages and commits changes.
4. **Share** to host a session. Copy the session id, the share URL (`...#session=<id>`), or scan the QR code.
5. In the second window, paste the id and **Join**, or open the share URL (the id is pre-filled; click **Join**).
6. Click **Sync** next to a connected peer.

## How a sync works

Every peer runs a Git server for each connected peer (`setupGitPeerServer`, serving both `git-upload-pack` and `git-receive-pack`). The peer that clicks **Sync** acts as the client:

1. Fetch with `+refs/heads/*:refs/remotes/peer/*`, so local `main` and `HEAD` are never overwritten by the fetch.
2. If there was no local `main`, set it to the peer's `main`.
3. If both have `main` and the peer's is not an ancestor of ours, merge it:

   ```typescript
   await git.merge()
     .include("refs/remotes/peer/main")
     .setContentMergeStrategy(ContentMergeStrategy.UNION)
     .call();
   ```

4. Push `refs/heads/main:refs/heads/main`. After the merge this is a fast-forward for the peer, whose server then updates its working directory and UI.
5. Check out `main` locally to update the working directory.

The Git objects are created and read through a `Git` facade over a working copy:

```typescript
import { Git } from "@statewalker/vcs-commands";
import { createMemoryHistory } from "@statewalker/vcs-core";
import {
  createMemoryGitStaging,
  MemoryCheckout,
  MemoryWorkingCopy,
  MemoryWorktree,
} from "@statewalker/vcs-working-tree";

const history = createMemoryHistory();
await history.initialize();
await history.refs.setSymbolic("HEAD", "refs/heads/main");
const checkout = new MemoryCheckout({
  staging: createMemoryGitStaging(),
  initialHead: { type: "symbolic", target: "refs/heads/main" },
});
const worktree = new MemoryWorktree({ blobs: history.blobs, trees: history.trees });
const git = Git.fromWorkingCopy(new MemoryWorkingCopy({ history, checkout, worktree }));
```

For a folder, `initializeGitFromFiles()` builds the same pieces from `FileRawStorage` (loose objects in `.git/objects`), `createFileRefStore`, `FileWorktree` and `createGitStaging(files, ".git/index")`, creating the `.git` skeleton if it is missing.

## Why it is the way it is

- **Fetch into remote-tracking refs, merge, then push.** Fetching never touches local `main`, so a sync cannot lose local commits. Merging before the push makes the push a fast-forward on the other side, so receive-pack never has to reject it.
- **`UNION` content merge.** When both peers edited the same file, the union strategy keeps both sides' lines instead of stopping; that suits the note-like files this demo syncs.
- **Every peer is also a server.** Either side can start a sync, and a push from the guest lands on the host the same way as the other direction.
- **Views talk only to models.** Views enqueue typed actions; controllers do the work and update models. This keeps views free of side effects and lets the controllers and models be tested in Node with mock PeerJS and in-memory connections.
- **Native on-disk format for folders.** Objects, refs and the index are written as Git writes them, so a folder can be inspected with `git` and a repository created by `git` can be opened.

## What will surprise you

- **Signaling goes through the public PeerJS server.** `new Peer(id)` is called with no options, so it uses PeerJS's hosted broker. Without access to it, hosting and joining fail (`Failed to join session: <reason>` in the activity log). Peers behind restrictive NATs may also need a TURN server, which is not configured.
- **Only `main` is synced back.** Fetch brings all of the peer's branches into `refs/remotes/peer/*`, but only `main` is merged and pushed.
- **Unresolvable merges stop the sync** with `Sync failed: Merge conflicts: <paths>` or `Sync failed: Merge failed: <status>`; nothing is pushed.
- **In-memory repositories are lost on reload.** That includes the fallback used when the File System Access API is missing (`File System Access API not available, using in-memory storage.`).
- **Repositories with packed objects cannot be read.** `FileRawStorage` reads loose objects only, so opening a folder whose objects were packed by `git gc` or a clone shows missing commits. A fresh `git init` repository works.
- **The folder picker asks for read-write access up front** (`showDirectoryPicker({ mode: "readwrite" })`); denying it fails with `Failed to open repository: <reason>`.
- **Some tests need native `git`.** `open-native-repo.test.ts` and `sync-merge-history.test.ts` create or prepare repositories by running `git` through `execSync`.

## Reference

### Commands

| Command | What it does |
|---|---|
| `pnpm --filter @statewalker/vcs-demo-webrtc-p2p-sync dev` | Vite dev server |
| `pnpm --filter @statewalker/vcs-demo-webrtc-p2p-sync build` | Production build to `dist/` |
| `pnpm --filter @statewalker/vcs-demo-webrtc-p2p-sync preview` | Serve the production build |
| `pnpm --filter @statewalker/vcs-demo-webrtc-p2p-sync test` | Vitest |
| `pnpm --filter @statewalker/vcs-demo-webrtc-p2p-sync typecheck` | `tsc --noEmit` |

### Session URL

`<origin><path>#session=<id>` (or `#s=<id>`). Session ids are 16-character base64url strings.

### Dependencies

| Package | Used for |
|---|---|
| `@statewalker/vcs-commands` | `Git`, merge strategies |
| `@statewalker/vcs-core` | History, object store, `DefaultSerializationApi` |
| `@statewalker/vcs-store-files` | `FileRawStorage`, `createFileRefStore`, `FileWorktree` |
| `@statewalker/vcs-working-tree` | staging, checkout, worktree, working copy |
| `@statewalker/vcs-transport` | `fetchOverDuplex`, `pushOverDuplex`, `serveOverDuplex` |
| `@statewalker/vcs-transport-adapters` | `createVcsRepositoryFacade` |
| `@statewalker/webrun-files`, `-files-browser`, `-files-mem` | `FilesApi`, `BrowserFilesApi`, `MemFilesApi` |
| `peerjs` | signaling and data channels |
| `qrcode` | QR code for the share URL |

`@statewalker/vcs-store-mem` and `@statewalker/vcs-utils` are declared but not imported by `src/`.
