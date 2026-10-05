# StateWalker VCS

A Git-compatible version control system written in TypeScript. It reads and writes Git objects,
pack files and refs, speaks the Git fetch/push protocol (v1 and v2), and handles Git LFS, all
without a native `git` binary. It runs in browsers, Node.js and workers. Storage is pluggable:
memory, a Git directory over any `FilesApi`, SQL, or a key-value store. A separate orchestration
package combines it with rclone-style file synchronisation.

This repository is a pnpm workspace: the library packages under `packages/`, runnable examples,
demos and benchmarks under `apps/`, and a documentation site under `docs/`.

## The shape

```
                       vcs-workspace  (file sync + versioning, via @statewalker/webrun-files-sync)
                             |
 vcs-commands  ──────────────┤          vcs-transport-xet ──> vcs-transport-lfs
   (Git API)                 |                 (large objects over @statewalker/webrun-content-store)
     |            vcs-transport (+ vcs-transport-adapters)
     |                       |
 vcs-store-files / -mem / -sql / -kv
     |                       |
 vcs-working-tree  (index, checkout, worktree, status)
     |
 vcs-core  (objects, refs, packs, history; storage over @statewalker/webrun-storage)
     |
 vcs-utils  (hash, compression, diff, streams)  <──  vcs-utils-node (native zlib, Node files)
```

### Packages

| Package | What it does | npm |
| --- | --- | --- |
| [`@statewalker/vcs-core`](packages/core) | Git object model (blobs, trees, commits, tags), refs, pack files, `History`. | [npm](https://www.npmjs.com/package/@statewalker/vcs-core) |
| [`@statewalker/vcs-working-tree`](packages/working-tree) | Index/staging, checkout, worktree, status, ignore rules, merge/rebase state, `WorkingCopy`. | [npm](https://www.npmjs.com/package/@statewalker/vcs-working-tree) |
| [`@statewalker/vcs-commands`](packages/commands) | Porcelain `Git` API: add, commit, branch, merge, rebase, stash, fetch, push, clone, ... | [npm](https://www.npmjs.com/package/@statewalker/vcs-commands) |
| [`@statewalker/vcs-transport`](packages/transport) | Git protocol client and server over a duplex stream or HTTP. | [npm](https://www.npmjs.com/package/@statewalker/vcs-transport) |
| [`@statewalker/vcs-transport-adapters`](packages/transport-adapters) | Connects `History` and storage to the transport's repository interfaces. | [npm](https://www.npmjs.com/package/@statewalker/vcs-transport-adapters) |
| [`@statewalker/vcs-transport-lfs`](packages/transport-lfs) | Git LFS batch protocol with `basic` whole-object transfer. | [npm](https://www.npmjs.com/package/@statewalker/vcs-transport-lfs) |
| [`@statewalker/vcs-transport-xet`](packages/transport-xet) | Git LFS `xet` transfer: sends only missing chunks, falls back to `basic`. | [npm](https://www.npmjs.com/package/@statewalker/vcs-transport-xet) |
| [`@statewalker/vcs-store-files`](packages/store-files) | Git `.git` layout over a `FilesApi`. | [npm](https://www.npmjs.com/package/@statewalker/vcs-store-files) |
| [`@statewalker/vcs-store-mem`](packages/store-mem) | In-memory storage. | [npm](https://www.npmjs.com/package/@statewalker/vcs-store-mem) |
| [`@statewalker/vcs-store-sql`](packages/store-sql) | SQL storage; sql.js adapter included (peer: `sql.js`). | [npm](https://www.npmjs.com/package/@statewalker/vcs-store-sql) |
| [`@statewalker/vcs-store-kv`](packages/store-kv) | Storage over a key-value store (IndexedDB, LocalStorage and similar). | [npm](https://www.npmjs.com/package/@statewalker/vcs-store-kv) |
| [`@statewalker/vcs-workspace`](packages/workspace) | Publish, update, checkpoint and restore: file sync combined with Git history. | [npm](https://www.npmjs.com/package/@statewalker/vcs-workspace) |
| [`@statewalker/vcs-utils`](packages/utils) | SHA-1, CRC32, compression, text/binary diff, delta encoding, streams. | [npm](https://www.npmjs.com/package/@statewalker/vcs-utils) |
| [`@statewalker/vcs-utils-node`](packages/utils-node) | Node.js native compression and file adapters. | [npm](https://www.npmjs.com/package/@statewalker/vcs-utils-node) |
| [`@statewalker/vcs-testing`](packages/testing) | Shared test suites for storage backends. Private. | |
| [`@statewalker/vcs-integration-tests`](packages/integration-tests) | Cross-package tests built from the example apps. Private. | |

Public packages ship built ESM and `.d.ts` files in `dist/` (what `exports` points at) and their
TypeScript sources in `src/`. Other `@statewalker/*` dependencies (`webrun-files*`,
`webrun-storage`, `webrun-content-store`, `webrun-content-transfer`, `webrun-files-sync`,
`webrun-streams*`, `webrun-http-streams`) come from npm.

### Apps (all private)

| Folder | Contents | Run |
| --- | --- | --- |
| [`apps/examples/`](apps/examples) | Eleven numbered Node.js tutorials, from the object model to delta strategies. | `pnpm --filter @statewalker/vcs-example-01-quick-start start` |
| [`apps/demos/`](apps/demos) | Node.js and browser demos: HTTP server, P2P sync over WebRTC/LiveKit, offline PWA, versioned documents, LFS/xet against HuggingFace. | Node: `start`; browser: `dev` (Vite) |
| [`apps/benchmarks/`](apps/benchmarks) | Delta compression, pack operations, realistic repository workloads. | `pnpm --filter @statewalker/vcs-benchmark-<name> start` |
| [`docs/`](docs) | Observable Framework site: overview, example guide, dependency diagram, release notes. | `pnpm docs:dev` |

See [docs/example-applications.md](docs/example-applications.md) for each app.

## How to run it

1. Use Node.js 24 and enable corepack: `corepack enable`. pnpm 10.16.1 is pinned in
   `packageManager`.
2. `pnpm install`
3. `pnpm build`. This builds every workspace member that has a `build` script: the packages
   (rolldown, then `tsc` for declarations), the browser demos (Vite) and the docs site.
4. `pnpm test`: vitest in every package and app that has a `test` script.
5. Run something:
   ```sh
   pnpm --filter @statewalker/vcs-example-01-quick-start start
   ```
   It creates an in-memory repository, makes two commits and prints the log.

A minimal program with the porcelain API:

```typescript
import { Git } from "@statewalker/vcs-commands";
import { createMemoryHistory } from "@statewalker/vcs-core";
import {
  createMemoryCheckout,
  createMemoryGitStaging,
  createMemoryWorkingCopy,
  createMemoryWorktree,
} from "@statewalker/vcs-working-tree";

const history = createMemoryHistory();
await history.initialize();
await history.refs.setSymbolic("HEAD", "refs/heads/main");

const staging = createMemoryGitStaging();
const checkout = createMemoryCheckout({ staging });
const worktree = createMemoryWorktree({ blobs: history.blobs, trees: history.trees });
const git = Git.fromWorkingCopy(createMemoryWorkingCopy({ history, checkout, worktree }));

await worktree.writeContent("README.md", new TextEncoder().encode("# Hello\n"));
await git.add().addFilepattern(".").call();
const commit = await git.commit().setMessage("Initial commit").call();
console.log(commit.id);
```

## Why it is the way it is

- **Git compatibility without Git.** Objects, packs and protocol messages are byte-compatible with
  Git, so repositories written here work with standard Git tools and the other way round. Being
  pure TypeScript is what lets the same code run in a browser tab, a worker and Node.js.
- **History, working tree and commands are separate packages.** `vcs-core` only knows immutable
  objects and refs. Mutable local state (index, checkout, worktree) lives in `vcs-working-tree`.
  Multi-step workflows live in `vcs-commands`. A server that only stores and serves repositories
  does not need the working-tree or command packages.
- **File sync and versioning do not depend on each other.** File synchronisation
  (`@statewalker/webrun-files-sync`) knows nothing of Git, and the Git packages know nothing of
  sync. Only `vcs-workspace` combines them, so either can be used alone.
- **Storage is a set of small interfaces.** Backends implement object, ref and staging stores;
  pack formats, deltas and object serialization are shared. That is why the same repository logic runs over memory, files,
  SQL and key-value stores.
- **Large files go around the object store.** LFS and xet move large objects through a chunked
  content store with its own ids, keeping them out of packs; the LFS pointer still carries the
  standard whole-file SHA-256.
- **Tests run against sources, consumers against builds.** Each package's `vitest.config.ts`
  aliases sibling packages to their `src/`, so tests never see a stale build. Package `exports`
  point at `dist/`, the same thing npm consumers get.
- Internal dependencies use `workspace:^`. External ones come from the pnpm catalog in
  `pnpm-workspace.yaml` (`catalog:`; peer ranges from the `peers` catalog), so each dependency has
  one version across the workspace.

## What will surprise you

- **Apps and `pnpm typecheck` need a build first.** Package `exports` point at `dist/`. Starting an
  app before `pnpm build` fails with `ERR_MODULE_NOT_FOUND` for a package's `dist/index.js` (Node
  apps) or an unresolved import at dev-server start (browser demos). `tsc` reports
  `TS2307: Cannot find module '@statewalker/vcs-core' or its corresponding type declarations`.
  After changing a package, rebuild it before running apps against it.
- **`pnpm test` does not run the browser end-to-end tests.** `pnpm test:app` runs them (Playwright,
  through turbo, which builds first). Install the browsers once with
  `pnpm --filter @statewalker/vcs-demo-browser-app exec playwright install`.
- **Not every store produces Git ids.** The standalone tree, commit and tag stores in
  `vcs-store-mem`, `vcs-store-kv` and `vcs-store-sql`, and the `"sql"` history backend, compute
  their own (FNV-1a) ids instead of SHA-1 object ids. Use the `create*ObjectStores` factories of
  those packages, `vcs-store-files` or `createMemoryHistory` when ids must match Git. See each
  store's README.
- **The HuggingFace demos need network access** to `huggingface.co`.
- **`pnpm lint` and `pnpm format` rewrite files.** Use `lint:check` and `format:check` to only
  report.
- **`notes/` is not part of the workspace.** It is a separate Observable Framework app with its own
  `package-lock.json`.

## Reference

### Commands

| Command | What it runs |
| --- | --- |
| `pnpm build` | `pnpm -r run build` |
| `pnpm test` | `pnpm -r run test` |
| `pnpm test:app` | `turbo run test:app` (Playwright app tests) |
| `pnpm typecheck` | `pnpm -r run typecheck` |
| `pnpm lint` / `pnpm lint:check` / `pnpm lint:fix` | `biome check --write .` / `biome check .` / with `--unsafe` fixes |
| `pnpm format` / `pnpm format:check` / `pnpm format:fix` | `biome format --write .` / `biome format .` / `biome check --write --unsafe .` |
| `pnpm docs:dev` / `pnpm docs:build` | Preview / build the docs site |
| `pnpm deps:check` | List outdated dependencies (`scripts/update-deps.sh --check-only`) |
| `pnpm deps:update` (`:safe`, `:interactive`) | Update the catalog and dependencies; `:safe` also runs tests and build |
| `pnpm changeset` | Add a changeset to choose a package's bump type or changelog text |

One package: `pnpm --filter @statewalker/vcs-core test`.

### CI and releases

CI runs on every pull request and on `main`: frozen install, dependency-reference checks, lint,
format, build, typecheck, tests, and checks that every export target exists, that `dist/` imports
only declared dependencies and that packed manifests contain no `workspace:` or `catalog:`
specifiers. Public packages are published to npm from CI with changesets and npm provenance; see
[docs/releasing.md](docs/releasing.md).

### Files

| Path | Contents |
| --- | --- |
| `packages/*` | Library packages. |
| `apps/{examples,demos,benchmarks}/*` | Runnable apps. |
| `docs/` | Documentation site sources and [`docs/package-dependencies.md`](docs/package-dependencies.md). |
| `ARCHITECTURE.md` | Background on the Git object model, storage and protocol layers. |
| `scripts/` | Dependency update script and debugging scripts for packs and GC. |
| `pnpm-workspace.yaml` | Workspace globs and dependency catalogs. |
| `turbo.json` | Task graph for `test:app`. |
| `biome.json` | Lint and format configuration. |
| `LICENSE` | MIT. |
