# 08-transport-basics

A runnable example of the Git smart-HTTP client in `@statewalker/vcs-transport`. It lists the refs of a public GitHub repository, checks whether a repository is reachable, clones it into an in-memory repository with `fetch()`, and fetches again incrementally. It needs network access: every operation talks to `https://github.com/octocat/Hello-World.git`, and one deliberately asks for a repository that does not exist. The repository lives in memory; nothing is written to disk.

## One file, five operations against one remote

```
apps/examples/08-transport-basics/
├── package.json
├── tsconfig.json
└── src/
    └── main.ts      # checkRemote, ls-remote, ref listing, clone, fetch
```

```
  main.ts ── HTTPS ──▶ github.com/octocat/Hello-World.git
     │                   GET  /info/refs?service=git-upload-pack   (lsRemote, fetch)
     │                   POST /git-upload-pack                      (clone, fetch)
     ▼
  in-memory repository (objects, refs) and stdout (ref updates, object counts)
```

Each operation runs inside `runStep()`, which catches its error, prints it, and moves on to the next.

## How to run it

Requires Node 24, pnpm, and outbound HTTPS to github.com. From the repository root:

```bash
pnpm install
pnpm --filter @statewalker/vcs-example-08-transport-basics start
```

There are no `step:NN` scripts; `start` runs all five operations in order.

## The walk-through

All code is in [src/main.ts](src/main.ts).

### `lsRemote()` returns ref names and ids without downloading objects

`lsRemote()` requests the ref advertisement (`/info/refs?service=git-upload-pack`) and returns a `Map` from ref name to hex object id. The example uses it three times: to check access, to print refs grouped into branches, tags and other refs, and to print the full list.

```typescript
import { lsRemote } from "@statewalker/vcs-transport";

const REPO_URL = "https://github.com/octocat/Hello-World.git";

const refs = await lsRemote(REPO_URL);

console.log(`Found ${refs.size} refs:`);
for (const [name, id] of refs) {
  console.log(`  ${name} ${id.slice(0, 8)}`);
}
```

Output of the run (GitHub advertises every pull request as `refs/pull/<n>/head` and `refs/pull/<n>/merge`, so the list is long):

```
Found 3734 refs:

Branches:
  master                         7fd1a60b
  octocat-patch-1                b1b3f972
  test                           b3cbd5bb

Other:
  HEAD                           7fd1a60b
  refs/pull/1/head               7044a8a0
  ...
```

The `HEAD` id in this output is wrong; see "What will surprise you".

**Key APIs:**
- `lsRemote(url, options?)` - `Promise<Map<string, string>>`
- `LsRemoteOptions` - `auth` (`{ username, password }`, sent as Basic auth), `headers`, `timeout` (ms), `fetchImpl`

### Checking access is `lsRemote()` in a `try`

There is no separate check call: a successful `lsRemote()` means the remote exists and is readable, and an empty map means it has no refs. The example also asks for a repository that does not exist, to show the failure.

```typescript
try {
  const refs = await lsRemote(REPO_URL);
  console.log(`Accessible: true, empty: ${refs.size === 0}`);
} catch (error) {
  console.log(`Accessible: false`);
  console.log(`Error: ${error instanceof Error ? error.message : error}`);
}
```

Output of the run:

```
Checking: https://github.com/nonexistent-user-12345/nonexistent-repo.git
  Accessible: false
  Error: HTTP error 401: Unauthorized
```

### A clone is a fetch into an empty repository

`fetch()` stores what it receives: the pack goes into `repository.importPack` as it arrives, and the refs the refspecs select are written to `refStore`, each with git's status. Into an empty repository that is a clone.

```typescript
import { createMemoryHistoryWithOperations } from "@statewalker/vcs-core";
import { createRepositoryFacade, createTransportRefStore, fetch } from "@statewalker/vcs-transport";

const history = createMemoryHistoryWithOperations();
await history.initialize();
const local = {
  repository: createRepositoryFacade({ history }),
  refStore: createTransportRefStore(history.refs),
};

const result = await fetch({
  url: REPO_URL,
  ...local,
  refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
  tags: "all",
  onProgress: (message) => console.log(`  Server: ${message}`),
});

console.log(`Protocol: v${result.protocolVersion}`);
console.log(`Default branch: ${result.defaultBranch}`);
console.log(`Objects received: ${result.packObjects}`);
for (const update of result.refUpdates) console.log(`  ${update.summary} ${update.localRef}`);
```

### A second fetch sends haves and receives only what is new

The same call against the same repository offers the local refs' history as `have` lines (git's negotiator: newest commits first, in growing batches), so the server sends only the objects the repository lacks. Right after the clone that is none, and every ref is `[up to date]`.

```typescript
const again = await fetch({ url: REPO_URL, ...local, refspecs: ["+refs/heads/*:refs/remotes/origin/*"] });
console.log(`Haves sent: ${again.stats.haves}, objects received: ${again.packObjects}`);
```

Note that `fetch` here is the transport function, not the global `fetch`; importing it shadows the global in this module.

**Key APIs:**
- `fetch(options)` - `Promise<FetchClientResult>`: `protocolVersion`, `remoteRefs`, `defaultBranch`, `refUpdates` (each with `status` and git's `summary`), `packObjects`, `packBytes`, `stats`, `shallow`
- `FetchOptions` - `url`, `auth`, `headers`, `timeout`, `fetchImpl`, `protocolVersion`, `repository`, `refStore`, `refspecs`, `tags`, `depth`, `deepenSince`, `deepenNot`, `unshallow`, `force`, `dryRun`, `onProgress`
- Refspec format: `[+]<src>:<dst>`, `+` allows non-fast-forward updates; without it a non-fast-forward is `rejected`

## How the smart-HTTP exchange works

The client speaks the Git smart-HTTP protocol to the server's upload-pack service:

1. `GET <url>/info/refs?service=git-upload-pack` returns the ref advertisement: a `# service=` line, then one pkt-line per ref (`<oid> <name>`), with the server capabilities after a NUL byte on the first ref line. Every pkt-line starts with a 4-character hex length; `0000` is a flush packet.
2. `POST <url>/git-upload-pack` sends `want` lines for the refs to fetch and `have` lines for objects the client has, and receives a pack, multiplexed with progress messages on side-band channels.

`lsRemote()` performs only step 1. `fetch()` asks for protocol v2 (`Git-Protocol: version=2`): GitHub then answers step 1 with its capabilities, lists refs with an `ls-refs` POST, and negotiates with `fetch` POSTs, one per round.

## Why it is the way it is

- **A real public repository.** `octocat/Hello-World` is small, public and stable, so the example needs no credentials and no local server.
- **Failures do not stop the run.** Each operation is wrapped in `runStep()`, and the process exits 0 even when operations fail, so an offline run still shows how far each operation gets.
- **Storage in memory.** The clone goes into a vcs-core in-memory history, so the incremental fetch has something to negotiate against, and nothing touches the disk.

## What will surprise you

- **No network, no results.** Offline, every operation prints `[!] <name> failed: <message>` followed by `(This may be a network or transport layer issue)`, the run ends with `Example finished with 0/5 operations successful.`, and the exit code is still 0. Behind a proxy, `globalThis.fetch` must be able to reach github.com.
- **A missing repository looks like an auth failure.** GitHub answers 401 for repositories that do not exist, so `lsRemote()` throws `HTTP error 401: Unauthorized`, not 404. Other HTTP failures throw `HTTP error <status>: <statusText>`; a `timeout` throws `Request timeout`.
- **The ref listing is long, the clone is not.** `lsRemote()` lists all 3734 refs (mostly `refs/pull/*`); `fetch()` asks only for the refspecs' refs (branches, and tags), so pull-request objects are not downloaded.
- **The banner mentions push.** The banner reads "Clone, fetch, and push operations", but the example does not push.

## Reference

### Commands

| Command | What it runs |
|---------|--------------|
| `pnpm --filter @statewalker/vcs-example-08-transport-basics start` | `tsx src/main.ts` |
| `pnpm --filter @statewalker/vcs-example-08-transport-basics typecheck` | `tsc --noEmit` |

### Network

| Request | Purpose |
|---------|---------|
| `https://github.com/octocat/Hello-World.git` | target of every operation |
| `https://github.com/nonexistent-user-12345/nonexistent-repo.git` | the failing access check |

### Source of the APIs used

| API | Location |
|-----|----------|
| `lsRemote`, `LsRemoteOptions` | [packages/vcs-transport/src/operations/ls-remote.ts](../../../packages/vcs-transport/src/operations/ls-remote.ts) |
| `fetch`, `FetchOptions` | [packages/vcs-transport/src/operations/fetch.ts](../../../packages/vcs-transport/src/operations/fetch.ts) |
| `FetchClientOptions`, `FetchClientResult` | [packages/vcs-transport/src/fetch-client/fetch-remote.ts](../../../packages/vcs-transport/src/fetch-client/fetch-remote.ts) |
| `BaseHttpOptions` | [packages/vcs-transport/src/api/options.ts](../../../packages/vcs-transport/src/api/options.ts) |
| `ProgressInfo`, `RefSpec` | [packages/vcs-transport/src/protocol/types.ts](../../../packages/vcs-transport/src/protocol/types.ts) |
| Refspec parsing | [packages/vcs-transport/src/utils/refspec.ts](../../../packages/vcs-transport/src/utils/refspec.ts) |
| `bytesToHex` | [packages/vcs-utils/src/hash/utils/index.ts](../../../packages/vcs-utils/src/hash/utils/index.ts) |

### Related examples

- [09-repository-facade](../09-repository-facade/) - exposing a repository to transport through RepositoryFacade
- [webrtc-p2p-sync](../../demos/webrtc-p2p-sync/) - peer-to-peer sync without a central server
