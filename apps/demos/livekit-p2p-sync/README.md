# LiveKit P2P Git Sync Demo

## What it is

A Vite single-page app that syncs in-memory Git repositories between browsers that join the same LiveKit room. Each participant pair gets a multiplexed byte channel over LiveKit data messages (`@statewalker/webrun-streams-livekit` + `emulateMux`), every participant serves Git upload-pack and receive-pack to the others, and **Sync** runs a fetch, a fast-forward or merge, and a push with the Git wire protocol from `@statewalker/vcs-transport`. It needs a LiveKit server; for local use, `livekit-server --dev`.

## Layout

```
index.html                     connection form (URL, room, identity, token), participants, repository, files, log
src/
  main.ts                      repository setup, LiveKit room handling, init / add file / sync, UI rendering
  services/
    dev-token.ts               generateDevToken(identity, room): HS256 JWT signed with the dev key
    git-peer-server.ts         setupGitPeerServer(): registers serveGitDispatch() on mux.serve
    git-peer-session.ts        createGitPeerSession(): fetch / push through mux.call
  adapters/
    webrun-git.ts              gitClientDuplex(), serveGitDispatch(): 1-byte service marker per call
    ref-store-adapter.ts       core Refs -> transport RefStore
```

```
Room (livekit-client)
  └─ per remote participant:
       byteChannelFromLiveKit(room, identity) ─ emulateMux({ side })
            ├─ mux.serve(serveGitDispatch)            answers peer's fetch and push
            └─ mux.call ─ gitClientDuplex(service)    our fetch and push
                              └─ fetchOverDuplex / pushOverDuplex
```

## How to run it

1. `pnpm install && pnpm build` at the repository root (Node 24); the `@statewalker/vcs-*` packages resolve to their built `dist/`.
2. Start a LiveKit server in development mode (API key `devkey`, secret `secret`, listening on `ws://localhost:7880`):

   ```bash
   livekit-server --dev
   ```

3. Start the app and open its URL (`http://localhost:5173` by default) in two windows:

   ```bash
   pnpm --filter @statewalker/vcs-demo-livekit-p2p-sync dev
   ```

4. In each window keep the defaults (`ws://localhost:7880`, room `git-sync`, a random `user-xxxx` identity, empty token) and click **Connect**. Each window lists the other under Participants.
5. In one window click **Init Repo**, then **Add File** a few times.
6. Click **Sync** next to the other participant. Then add files in the other window and sync back.

## How a sync works

`handleSync(identity)` in `main.ts`:

1. Fetch `+refs/heads/*:refs/remotes/peer/*` from the participant.
2. Compare local `main` with `refs/remotes/peer/main`:
   - no local `main`: take the peer's;
   - peer's is an ancestor of ours: nothing to do;
   - ours is an ancestor of the peer's: fast-forward;
   - otherwise: write a merge commit `Merge from <identity>` with both as parents.
3. Push `refs/heads/main:refs/heads/main` to the participant. The participant's server logs `Received push from <identity>` and redraws.

```typescript
const mux = emulateMux(byteChannelFromLiveKit(room, identity), {
  side: localIdentity < identity ? "initiator" : "responder",
});

setupGitPeerServer({ serve: mux.serve, history, serialization, onPushReceived });

const session = createGitPeerSession({ call: mux.call, history, serialization });
const fetched = await session.fetch(); // default refspec +refs/heads/*:refs/remotes/peer/*
const pushed = await session.push();   // default refspec refs/heads/main:refs/heads/main
```

Commits are written directly with the object API (`history.blobs.store`, `history.trees.store`, `history.commits.store`, `history.refs.set`); the repository is a `createMemoryHistory()`.

## Why it is the way it is

- **One channel, two Git services.** A participant must answer both fetch (upload-pack) and push (receive-pack) on the same multiplexed channel, but `serveRepoOverWebrun()` serves one fixed service. So each call starts with a one-byte marker (`0x01` upload-pack, `0x02` receive-pack) that `gitClientDuplex()` prepends and `serveGitDispatch()` reads to pick the service.
- **Mux sides from identities.** Both ends must choose opposite `side`s so stream ids do not collide; comparing the two identities gives the same answer on both ends without any extra message.
- **Client-side dev tokens.** With an empty token field the page signs a JWT with LiveKit's development key and secret, so a local `livekit-server --dev` works with no token service. The key and secret are public, so this only works against dev servers.
- **Fetch into remote-tracking refs first.** Local `main` is only moved after comparing histories, so a fetch never discards local commits.

## What will surprise you

- **The merge keeps the peer's files, not yours.** For diverged histories the merge commit reuses the peer's tree, so files added only on the local side disappear from `main` after the sync (they remain in the history).
- **No LiveKit server, no connection.** The log shows `Connection failed: <reason>` and the status returns to Disconnected. Against a non-dev server the auto-generated token is rejected; paste a token issued by that server.
- **Duplicate identities.** Two windows must use different identities; LiveKit lets only one participant per identity stay in a room.
- **Everything is in memory.** Reloading loses the repository. **Init Repo** always writes a new root commit to `main`, replacing whatever `main` pointed to.
- **Add File before Init Repo** logs `No commits yet — init first`.
- **Sync logs failures but continues.** A failed fetch logs `Fetch failed: <reason>` and the push is still attempted (`Push failed: <reason>` if it fails too).
- **The Files panel lists only top-level tree entries,** and the commit list follows first parents only (up to 20).

## Reference

### Commands

| Command | What it does |
|---|---|
| `pnpm --filter @statewalker/vcs-demo-livekit-p2p-sync dev` | Vite dev server |
| `pnpm --filter @statewalker/vcs-demo-livekit-p2p-sync build` | Production build to `dist/` |
| `pnpm --filter @statewalker/vcs-demo-livekit-p2p-sync preview` | Serve the production build |
| `pnpm --filter @statewalker/vcs-demo-livekit-p2p-sync typecheck` | `tsc --noEmit` |

### Connection form

| Field | Default |
|---|---|
| LiveKit URL | `ws://localhost:7880` |
| Room | `git-sync` |
| Identity | random `user-xxxx` |
| Token | empty: generated with `devkey` / `secret`, valid for one hour |

### Dependencies

| Package | Used for |
|---|---|
| `@statewalker/vcs-core` | `createMemoryHistory`, `DefaultSerializationApi`, `FileMode` |
| `@statewalker/vcs-commands`, `@statewalker/vcs-working-tree` | a `Git` facade over a memory working copy (built at startup; the demo's own actions use the object API) |
| `@statewalker/vcs-transport` | `fetchOverDuplex`, `pushOverDuplex`, `serveRepoOverWebrun`, `webrunClientDuplex` |
| `@statewalker/vcs-transport-adapters` | `createVcsRepositoryFacade` |
| `@statewalker/webrun-streams` | `emulateMux` |
| `@statewalker/webrun-streams-livekit` | `byteChannelFromLiveKit` |
| `livekit-client` | `Room`, participant events |
