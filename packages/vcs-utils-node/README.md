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

### Writes and lock files

- `write` streams (webrun-files-node 0.11): the chunks go to a temporary file beside the target as they arrive, and the temporary is renamed over the target once complete. Storing a large object does not hold it in memory, and readers see the old file or the new one, never a partial one; a source that fails leaves the old file in place. `list` hides the temporaries.
- `createExclusive` is `open(path, "wx")` (`O_CREAT | O_EXCL`), after creating the parent directories, so the operating system decides who takes a lock. Lock files (`<ref>.lock`, `packed-refs.lock`, `index.lock`, `gc.pid`) go through `atomicFilesOver(files, gitDir)` from `@statewalker/vcs-utils/files`, which uses it: a lock excludes every other process on the machine, a running `git` included, and every other `FilesApi` instance over the same directory. If another process removes the lock's (empty) directory between the `mkdir` and the `open`, `atomicFilesOver` retries, as git's `raceproof_create_file` does.
- `move` is a `rename(2)`, atomic on one filesystem, and a `FilesApi` rooted at `/` accepts absolute paths.

### Dependencies

- `@statewalker/vcs-utils` for the `FilesApi` type.
- `@statewalker/webrun-files-node`, which provides `NodeFilesApi`.

## License

MIT
