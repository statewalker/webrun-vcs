# @statewalker/vcs-utils-node

## What it is

Node.js implementations for `@statewalker/vcs-utils`: compression on `node:zlib` and a `FilesApi` backed by the local filesystem. It does nothing until you register it.

## Why it exists

`@statewalker/vcs-utils` uses only Web Platform APIs, so it runs in browsers, workers and Node.js alike. Its default compression goes through the Web `CompressionStream` API, and it has no way to touch a disk. In Node.js you usually want both: zlib directly, and a repository on the local filesystem. Keeping these here means the portable package never imports `node:*` modules, and browser bundles never pull them in.

## How to use it

```bash
pnpm add @statewalker/vcs-utils-node
```

`@statewalker/vcs-utils` and `@statewalker/webrun-files-node` come with it as regular dependencies. Node.js only.

| Import path | Contents |
|-------------|----------|
| `@statewalker/vcs-utils-node` | Everything below |
| `@statewalker/vcs-utils-node/compression` | `createNodeCompression()`, `deflateNode`, `inflateNode`, `compressBlockNode`, `decompressBlockNode` |
| `@statewalker/vcs-utils-node/files` | `createNodeFilesApi()`, `NodeFilesApi`, `createNodeAtomicFiles(root)` |

The happy path is two lines at application startup:

```typescript
import { setCompressionUtils } from "@statewalker/vcs-utils/compression";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";

setCompressionUtils(createNodeCompression());
```

## Examples

### Switch all compression to zlib

After `setCompressionUtils()`, `deflate`, `inflate`, `compressBlock` and `decompressBlock` in `@statewalker/vcs-utils`, and in the packages built on it, go through `node:zlib`. Finding where a compressed stream ends (`decompressBlockPartial`, `createInflater`, `BufferedByteReader`) stays on the portable push inflater, because `node:zlib` cannot report it.

```typescript
import { compressBlock, decompressBlock, setCompressionUtils } from "@statewalker/vcs-utils/compression";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";

setCompressionUtils(createNodeCompression());

const packed = await compressBlock(new TextEncoder().encode("hello"));
const unpacked = await decompressBlock(packed);
```

`options` for every function is `{ raw?: boolean; level?: number }`. `raw: true` selects raw DEFLATE without the zlib header; `level` defaults to 6.

### Read files from disk

```typescript
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { readText } from "@statewalker/vcs-utils/files";

const files = createNodeFilesApi({ rootDir: "/path/to/project" });
const head = await readText(files, ".git/HEAD"); // "ref: refs/heads/main\n"
```

Paths are resolved against `rootDir`. To open a Git repository on disk, pass this `FilesApi` to a storage backend such as `createGitFilesBackend()` from `@statewalker/vcs-store-files`.

## Internals

### Lock files that native git respects

```typescript
import { createNodeAtomicFiles } from "@statewalker/vcs-utils-node/files";

const files = createNodeAtomicFiles("/path/to/repo/.git");
if (await files.createExclusive("refs/heads/main.lock", bytes)) {
  await files.replace("refs/heads/main.lock", "refs/heads/main"); // rename(2)
}
```

`createExclusive` opens with `"wx"` (O_CREAT|O_EXCL), the call git and JGit use for lock files, so
exactly one process wins; a half-written lock is removed. `replace` is `rename`, `append` is
O_APPEND (git's reflog writes) and `removeEmptyDir` is `rmdir`. `@statewalker/vcs-store-files`
takes it as `atomicFiles` for ref batches next to a running `git`.

### Why registration is explicit

Importing `@statewalker/vcs-utils-node/compression` has no side effect. A library that registered itself on import would change the behaviour of every other module in the process, and the result would depend on import order. Register once, in the application entry point, never inside library code.

```typescript
// Does nothing: the module does not register itself
import "@statewalker/vcs-utils-node/compression";
```

### Partial decompression stays portable

Pack files store objects back to back, so a reader must learn how many input bytes one zlib stream used. Node's one-shot zlib functions do not report that, and the binary search this package used to do cost log2(n) full inflates per object. `createNodeCompression()` therefore leaves `decompressBlockPartial` alone: the portable implementation in `@statewalker/vcs-utils` reads the exact end from pako's inflate state in one pass, with pooled state.

### What breaks, and the error you see

- Streaming `deflateNode` / `inflateNode` throw `CompressionError` with the message `Compression failed: <zlib message>` or `Decompression failed: <zlib message>`.
- The block functions throw the raw zlib error. When they are called through `@statewalker/vcs-utils` (`compressBlock`, `decompressBlock`), that layer wraps it into `CompressionError` with `Compression failed: ...` or `Decompression failed: ...`.

### Dependencies

- `@statewalker/vcs-utils` for the `CompressionUtils`, `FilesApi` and `CompressionError` types.
- `@statewalker/webrun-files-node`, which provides `NodeFilesApi`. `createNodeFilesApi()` is a thin factory over it.
- `node:zlib` and `node:util` from the Node.js runtime.

## License

MIT
