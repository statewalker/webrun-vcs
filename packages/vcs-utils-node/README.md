# @statewalker/vcs-utils-node

## What it is

The Node.js `FilesApi`: a factory for `NodeFilesApi` from `@statewalker/webrun-files-node`, so apps and tests that run on Node can open a repository on the local filesystem.

## Why it exists

The VCS packages use only portable APIs: files go through `FilesApi`, compression through the Web `CompressionStream` API, hashing through portable code. The same code runs in browsers, Node.js and workers, and no library imports a `node:*` module (a lint rule enforces it). Choosing the platform's `FilesApi` is the one thing left to the application, and this package is that choice for Node.js.

## How to use it

```bash
pnpm add @statewalker/vcs-utils-node
```

| Import path | Contents |
|-------------|----------|
| `@statewalker/vcs-utils-node` | Everything below |
| `@statewalker/vcs-utils-node/files` | `createNodeFilesApi()`, `NodeFilesApi` |

```typescript
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { readText } from "@statewalker/vcs-utils/files";

const files = createNodeFilesApi({ rootDir: "/path/to/project" });
const head = await readText(files, ".git/HEAD"); // "ref: refs/heads/main\n"
```

Paths are resolved against `rootDir`; a path whose `..` would leave it is refused. To open a Git repository on disk, pass this `FilesApi` to a storage backend such as `createGitFilesBackend()` from `@statewalker/vcs-store-files`.

## Internals

### What NodeFilesApi does not do yet

- `write` collects every chunk before writing the file (webrun-files-node 0.10), so storing a large object holds it in memory once. A streaming `write` belongs upstream in `@statewalker/webrun-files-node`; the object kernel already streams up to the `FilesApi`.
- Exclusive create (O_EXCL) arrives with the next release of `@statewalker/webrun-files-node`, as `FilesApi.createExclusive` (`open "wx"`). Lock files (`<ref>.lock`, `packed-refs.lock`, `index.lock`, `gc.pid`) go through `atomicFilesOver(files, gitDir)` from `@statewalker/vcs-utils/files`, which uses `createExclusive` when the FilesApi has it: the lock then excludes other processes too, such as a running `git`. With the current release, which lacks it, a lock excludes only concurrent writers sharing one `FilesApi` instance.

### Dependencies

- `@statewalker/vcs-utils` for the `FilesApi` type.
- `@statewalker/webrun-files-node`, which provides `NodeFilesApi`.

## License

MIT
