# 08-transport-basics

A runnable example of the Git smart-HTTP client in `@statewalker/vcs-transport`. It lists the refs of a public GitHub repository, checks whether a repository is reachable, and calls `clone()` and `fetch()` against it. It needs network access: every operation talks to `https://github.com/octocat/Hello-World.git`, and one deliberately asks for a repository that does not exist. Results are printed only; nothing is written to disk.

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
     │                   GET  /info/refs?service=git-upload-pack   (lsRemote, clone, fetch)
     │                   POST /git-upload-pack                      (clone, fetch)
     ▼
  stdout (ref lists, pack size, byte counts)
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
Found 3732 refs:

Branches:
  master                         7fd1a60b
  octocat-patch-1                b1b3f972
  test                           b3cbd5bb

Other:
  HEAD                           015b7fd1
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

### `clone()` asks for every advertised ref with no local objects

`clone()` is a fetch with nothing to negotiate: no `localHas`, no `localCommits`, and all refs unless `branch` is set. It returns the raw pack and the refs; it does not store anything. Importing the pack into an object store is up to the caller.

```typescript
import { clone } from "@statewalker/vcs-transport";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";

const result = await clone({
  url: REPO_URL,
  onProgress: (info) => {
    const percent = info.total ? Math.round((info.current / info.total) * 100) : undefined;
    console.log(`  ${info.stage}: ${info.current}${info.total ? `/${info.total}` : ""}`
      + (percent !== undefined ? ` (${percent}%)` : ""));
  },
  onProgressMessage: (message) => {
    if (message.trim()) console.log(`  Server: ${message.trim()}`);
  },
});

console.log(`Default branch: ${result.defaultBranch}`);
console.log(`Refs fetched: ${result.refs.size}`);
console.log(`Pack size: ${result.packData.length} bytes`);
console.log(`Bytes received: ${result.bytesReceived}`);
for (const [name, id] of result.refs) {
  console.log(`  ${name} ${bytesToHex(id).slice(0, 8)}`);
}
```

Output of the run:

```
Clone complete:
  Default branch: refs/heads/master
  Refs fetched: 3732
  Pack size: 0 B
  Bytes received: 8 B
  Empty: false
```

**Key APIs:**
- `clone(options)` - `Promise<CloneResult>`
- `CloneOptions` - `url`, `auth`, `headers`, `timeout`, `fetchImpl`, `branch`, `depth`, `onProgress`, `onProgressMessage` (`bare` and `remoteName` are declared but `clone()` does not use them)
- `CloneResult` - `refs` (`Map<string, Uint8Array>`), `packData`, `defaultBranch`, `bytesReceived`, `isEmpty`

### `fetch()` takes refspecs and negotiation callbacks

`fetch()` adds refspecs and two callbacks for negotiation: `localHas(id)` and `localCommits()`, which let the client tell the server what it already has. The example passes no callbacks, so the request is the same as a clone.

```typescript
import { fetch } from "@statewalker/vcs-transport";

const result = await fetch({
  url: REPO_URL,
  refspecs: ["+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"],
  onProgress: (info) => console.log(`  ${info.stage}: ${info.current}`),
});

console.log(`Refs updated: ${result.refs.size}`);
console.log(`Pack size: ${result.packData.length} bytes`);
```

Note that `fetch` here is the transport function, not the global `fetch`; importing it shadows the global in this module.

**Key APIs:**
- `fetch(options)` - `Promise<HttpFetchResult>`, same fields as `CloneResult`
- `FetchOptions` - `url`, `auth`, `headers`, `timeout`, `fetchImpl`, `refspecs`, `depth`, `localHas`, `localCommits`, `onProgress`, `onProgressMessage`
- Refspec format: `[+]<src>:<dst>`, `+` allows non-fast-forward updates

## How the smart-HTTP exchange works

The client speaks the Git smart-HTTP protocol to the server's upload-pack service:

1. `GET <url>/info/refs?service=git-upload-pack` returns the ref advertisement: a `# service=` line, then one pkt-line per ref (`<oid> <name>`), with the server capabilities after a NUL byte on the first ref line. Every pkt-line starts with a 4-character hex length; `0000` is a flush packet.
2. `POST <url>/git-upload-pack` sends `want` lines for the refs to fetch and `have` lines for objects the client has, and receives a pack, multiplexed with progress messages on side-band channels.

`lsRemote()` performs only step 1. `clone()` and `fetch()` perform both.

## Why it is the way it is

- **A real public repository.** `octocat/Hello-World` is small, public and stable, so the example needs no credentials and no local server.
- **Failures do not stop the run.** Each operation is wrapped in `runStep()`, and the process exits 0 even when operations fail, so an offline run still shows how far each operation gets.
- **No local storage.** The example stops at the transport boundary: refs and raw pack bytes. Storing them is a separate concern, handled by the object stores in other packages.

## What will surprise you

- **No network, no results.** Offline, every operation prints `[!] <name> failed: <message>` followed by `(This may be a network or transport layer issue)`, the run ends with `Example finished with 0/5 operations successful.`, and the exit code is still 0. Behind a proxy, `globalThis.fetch` must be able to reach github.com.
- **A missing repository looks like an auth failure.** GitHub answers 401 for repositories that do not exist, so `lsRemote()` throws `HTTP error 401: Unauthorized`, not 404. Other HTTP failures throw `HTTP error <status>: <statusText>`; a `timeout` throws `Request timeout`.
- **The output is about 15,000 lines.** The 3732 refs (mostly `refs/pull/*`) are printed four times: grouped, in full, after clone and after fetch.
- **`lsRemote()` reports a wrong id for `HEAD`.** The run prints `HEAD 015b7fd1` while `refs/heads/master` is `7fd1a60b`, and `clone()` reports `HEAD 7fd1a60b`. The advertisement parser misreads the first ref line when the flush packet after the service line is not followed by a newline: it strips the `0000` and keeps the next pkt-line's length prefix (`015b`) as the start of the id.
- **Clone and fetch report success with an empty pack.** Against GitHub both return `Pack size: 0 B` and `Bytes received: 8 B`, while the run ends with `Example complete! All transport operations succeeded.` Check `packData.length`, not only the absence of an exception.
- **The progress callbacks never fire.** The client sends the `no-progress` capability in its first `want` line, so the server sends no progress messages and `onProgress` / `onProgressMessage` print nothing.
- **Refspecs do not filter the returned refs.** With refspecs for `refs/heads/*` and `refs/tags/*`, `fetch()` still returns all 3732 refs under their remote names (`refs/heads/master`, `refs/pull/...`), not mapped to `refs/remotes/origin/*`.
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
| `lsRemote`, `LsRemoteOptions` | [packages/transport/src/operations/ls-remote.ts](../../../packages/transport/src/operations/ls-remote.ts) |
| `clone`, `CloneOptions`, `CloneResult` | [packages/transport/src/operations/clone.ts](../../../packages/transport/src/operations/clone.ts) |
| `fetch`, `FetchOptions` | [packages/transport/src/operations/fetch.ts](../../../packages/transport/src/operations/fetch.ts) |
| `BaseHttpOptions`, `BaseFetchOptions` | [packages/transport/src/api/options.ts](../../../packages/transport/src/api/options.ts) |
| `RawFetchResult` | [packages/transport/src/api/fetch-result.ts](../../../packages/transport/src/api/fetch-result.ts) |
| `ProgressInfo`, `RefSpec` | [packages/transport/src/protocol/types.ts](../../../packages/transport/src/protocol/types.ts) |
| Refspec parsing | [packages/transport/src/utils/refspec.ts](../../../packages/transport/src/utils/refspec.ts) |
| `bytesToHex` | [packages/utils/src/hash/utils/index.ts](../../../packages/utils/src/hash/utils/index.ts) |

### Related examples

- [09-repository-access](../09-repository-access/) - server-side repository access for transport handlers
- [webrtc-p2p-sync](../../demos/webrtc-p2p-sync/) - peer-to-peer sync without a central server
