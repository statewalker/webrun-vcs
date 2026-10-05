# HTTP Git Server from Scratch

## What it is

A Node demo of a Git smart-HTTP server built on `@statewalker/vcs-transport`, served with Hono, with no `git http-backend` behind it. The main script creates a bare repository with the VCS object API, serves it, clones it with the VCS transport, commits a new file on a new branch, pushes the branch back, and checks the result with native `git`. Two more scripts run the server alone and a VCS-transport client alone.

## Layout

```
src/
  main.ts                  full round trip (8 steps)
  server-only.ts           standalone server for a directory of repositories
  client-only.ts           clone (and optionally push) against any smart-HTTP URL
  shared/
    config.ts              repos/ paths, HTTP_PORT = 8080, branch names
    hono-http-server.ts    createVcsHttpServer(): Hono + createFetchHandler()
    file-history.ts        createFileHistory(): History over loose objects in .git/objects
    helpers.ts             runGit*, directory helpers, console output
    vcs-http-server.ts     hand-written protocol server; not exported or used
```

```
            HTTP client (VCS transport clone/push, or native git)
                                  |
     GET  /<repo>/info/refs?service=git-upload-pack | git-receive-pack
     POST /<repo>/git-upload-pack
     POST /<repo>/git-receive-pack
                                  |
                       Hono app.all("/*")
                                  |
            createFetchHandler({ resolveRepository })      @statewalker/vcs-transport
                                  |
        getStorage(repoPath) -> FileHistory                (per script)
          createVcsRepositoryFacade({ history, serialization })   @statewalker/vcs-transport-adapters
          ref store adapter over history.refs
```

`main.ts` keeps its repositories in `repos/` under the current working directory: `repos/remote.git` (bare, served) and `repos/local` (the clone).

## How to run it

The `@statewalker/vcs-*` workspace packages resolve to their built `dist/`, so build once first. Native `git` must be on `PATH` for the round trip (it verifies steps 4 and 8).

1. `pnpm install && pnpm build` at the repository root (Node 24).
2. Run the round trip:

   ```bash
   pnpm --filter @statewalker/vcs-demo-http-server-scratch start
   pnpm --filter @statewalker/vcs-demo-http-server-scratch start --port 9000   # if 8080 is taken
   ```

   It ends with `SUCCESS!` and exit code 0 after these steps:

   1. Create `repos/remote.git` and store a blob, tree and commit with `history.blobs/trees/commits.store()`.
   2. Start the server on the port.
   3. `clone()` from `http://localhost:<port>/remote.git`, import the pack as loose objects with `DefaultSerializationApi.importPack()`, set refs, write the files.
   4. `git fsck --full`, `git status`, `git log` in the clone.
   5. Write `DEMO.md` as a new blob and tree.
   6. Commit it on `feature-branch`.
   7. `push()` `refs/heads/feature-branch` back to the server.
   8. Check the branch, commit id and `DEMO.md` in `repos/remote.git` with native git, then `git fsck`.

### Standalone server

```bash
pnpm --filter @statewalker/vcs-demo-http-server-scratch server --port 9000 --dir /path/to/repos
```

Defaults are port 8080 and `./repos`. A directory named `*.git` is served as a bare repository; any other directory is opened with a `.git` subdirectory. Then use any Git client:

```bash
git clone http://localhost:9000/remote.git
```

### Standalone client

```bash
pnpm --filter @statewalker/vcs-demo-http-server-scratch client http://localhost:9000/remote.git --dir ./my-clone
```

`--push` additionally commits a file and pushes the current branch, but see the client failure below.

## The code that matters

### Serving a repository

```typescript
import { createVcsHttpServer } from "./shared/index.js";

const server = await createVcsHttpServer({
  port: 8080,
  getStorage: async (repoPath) => (repoPath === "remote.git" ? remoteHistory : null),
});
// ...
await server.stop();
```

Inside, each request resolves the repository and wraps it for the transport handler:

```typescript
const gitHandler = createFetchHandler({
  resolveRepository: async (repoPath) => {
    const history = await getStorage(repoPath.replace(/^\//, ""));
    if (!history) return null;
    const serialization = new DefaultSerializationApi({ history });
    const repository = createVcsRepositoryFacade({ history, serialization });
    return { repository, refStore: createRefStoreAdapter(history) };
  },
});
app.all("/*", (c) => gitHandler(c.req.raw));
```

### Cloning via HTTP

```typescript
import { clone } from "@statewalker/vcs-transport";

const result = await clone({
  url: "http://localhost:8080/remote.git",
  onProgressMessage: (msg) => console.log(msg),
});
console.log(result.bytesReceived, result.defaultBranch, result.refs.size);
// result.packData holds the pack; result.defaultBranch is a full ref name ("refs/heads/main")
```

### Pushing

```typescript
import { push } from "@statewalker/vcs-transport";

const result = await push({
  url: "http://localhost:8080/remote.git",
  refspecs: ["refs/heads/feature-branch:refs/heads/feature-branch"],
  force: true,
  getLocalRef: async (refName) => (await history.refs.resolve(refName))?.objectId,
  getObjectsToPush: async function* () {
    yield* objectsToPush; // { id, type, content } for the commit, its trees and blobs
  },
});
if (!result.ok) console.error(result.unpackStatus, result.updates);
```

## Why it is the way it is

- **Loose objects only.** `createFileHistory()` stores every object through `FileRawStorage` in `.git/objects/xx/...`, which native git reads directly. That store does not read packfiles, so the round trip explodes the received pack into loose objects with `importPack()` instead of writing a `.pack`/`.idx` pair.
- **The transport package owns the protocol.** The server is a thin Hono route around `createFetchHandler()`; ref advertisement, upload-pack and receive-pack all come from `@statewalker/vcs-transport`. The app's only adapters are the repository facade and a ref store over `history.refs`.
- **`FileHistory` is the History instance itself with `objects` attached,** not a spread copy. `History` methods live on the prototype, and a spread would drop them; upload-pack would then fail with `history.collectReachableObjects is not a function`.
- **Native git only verifies.** It is never used to create, serve, clone or push; it checks that what VCS wrote is valid Git.

## What will surprise you

- **Port 8080 already in use** crashes `start` and `server` with an unhandled error, not a friendly message:

  ```
  Error: listen EADDRINUSE: address already in use :::8080
  ```

  Pass `--port <n>`. The default comes from `HTTP_PORT = 8080` in `src/shared/config.ts` (and a literal `8080` in `server-only.ts`).
- **`start` deletes `repos/` first.** Step 1 removes the whole `repos/` directory under the working directory, including anything you put there for `server` mode.
- **Run through `pnpm --filter`, the working directory is the app folder,** so `repos/` and `cloned-repo/` are created in `apps/demos/http-server-scratch/` (`repos/` is in `.gitignore`).
- **`git status` in the clone shows `D  README.md` and `?? README.md`.** The demo writes the files and objects but no index, so native git sees the file as deleted from the index and untracked on disk. This is expected output of step 4, not a failure.
- **Repositories served by `server` must hold loose objects.** A repository whose objects are packed (for example after `git gc`) cannot be read by `FileRawStorage`.
- **`client` does not produce a usable clone.** It treats `defaultBranch` as a short name, so it writes `HEAD` as `ref: refs/heads/refs/heads/main`, finds no HEAD commit, prints `Empty repository - no checkout needed` and still reports `SUCCESS!`. It writes the received pack as `.pack`/`.idx`, which the loose-object store cannot read. With `--push` it fails with `Error: Cannot push to empty repository`. Native `git clone` against `server` works.

## Reference

### Commands

| Command | What it does |
|---|---|
| `pnpm --filter @statewalker/vcs-demo-http-server-scratch start [--port <n>]` | Full round trip (`tsx src/main.ts`) |
| `pnpm --filter @statewalker/vcs-demo-http-server-scratch server [--port <n>] [--dir <path>]` | Standalone server until Ctrl+C |
| `pnpm --filter @statewalker/vcs-demo-http-server-scratch client <url> [--push] [--dir <path>]` | VCS-transport client; default directory `./cloned-repo` |
| `pnpm --filter @statewalker/vcs-demo-http-server-scratch typecheck` | `tsc --noEmit` |

### Configuration (`src/shared/config.ts`)

| Constant | Value |
|---|---|
| `HTTP_PORT` | `8080` |
| `BASE_DIR` | `<cwd>/repos` |
| `REMOTE_REPO_DIR` | `<cwd>/repos/remote.git` |
| `LOCAL_REPO_DIR` | `<cwd>/repos/local` |
| `TEST_BRANCH` | `feature-branch` |
| `DEFAULT_BRANCH` | `main` |

### Dependencies

`@statewalker/vcs-transport` (`createFetchHandler`, `clone`, `push`), `@statewalker/vcs-transport-adapters` (`createVcsRepositoryFacade`), `@statewalker/vcs-core` (object API, `DefaultSerializationApi`), `@statewalker/vcs-store-files` (`FileRawStorage`, `createFileRefStore`), `@statewalker/vcs-utils` and `@statewalker/vcs-utils-node` (compression, Node `FilesApi`), `hono` and `@hono/node-server` (HTTP).
