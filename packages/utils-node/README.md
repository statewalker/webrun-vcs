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
| `@statewalker/vcs-utils-node/compression` | `createNodeCompression()`, `deflateNode`, `inflateNode`, `compressBlockNode`, `decompressBlockNode`, `decompressBlockPartialNode` |
| `@statewalker/vcs-utils-node/files` | `createNodeFilesApi()`, `NodeFilesApi` |

The happy path is two lines at application startup:

```typescript
import { setCompressionUtils } from "@statewalker/vcs-utils/compression";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";

setCompressionUtils(createNodeCompression());
```

## Examples

### Switch all compression to zlib

After `setCompressionUtils()`, every compression call in `@statewalker/vcs-utils`, and in the packages built on it, goes through `node:zlib`.

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

### Why registration is explicit

Importing `@statewalker/vcs-utils-node/compression` has no side effect. A library that registered itself on import would change the behaviour of every other module in the process, and the result would depend on import order. Register once, in the application entry point, never inside library code.

```typescript
// Does nothing: the module does not register itself
import "@statewalker/vcs-utils-node/compression";
```

### How partial decompression finds the end of a zlib stream

Pack files store objects back to back. Each entry header gives the uncompressed size but not the compressed size, so a reader must learn how many input bytes one zlib stream used. `decompressBlockPartialNode()` returns `{ data, bytesRead }` for that.

Node's one-shot zlib functions do not report bytes consumed, so the function binary-searches the input length: a too-short prefix fails, the exact length succeeds. It first inflates the full buffer; if that fails with any error other than `ERR_TRAILING_JUNK_AFTER_STREAM_END` (which Node 24 raises when bytes follow the stream), the input is invalid and the zlib error is thrown as is. The search runs one synchronous inflate per step, so its cost grows with log2 of the buffer size times the object size. The portable default in `@statewalker/vcs-utils` reads the consumed byte count directly from pako's low-level inflate state and needs a single pass. `createNodeCompression()` still overrides it, so pack parsing with many small objects can be slower after registration; to keep the default for this one function, register the other four only:

```typescript
const { decompressBlockPartial, ...rest } = createNodeCompression();
setCompressionUtils(rest);
```

### What breaks, and the error you see

- Streaming `deflateNode` / `inflateNode` throw `CompressionError` with the message `Compression failed: <zlib message>` or `Decompression failed: <zlib message>`.
- The block functions throw the raw zlib error. When they are called through `@statewalker/vcs-utils` (`compressBlock`, `decompressBlock`, `decompressBlockPartial`), that layer wraps it into `CompressionError` with `Compression failed: ...`, `Decompression failed: ...` or `Partial decompression failed: ...`.

### Dependencies

- `@statewalker/vcs-utils` for the `CompressionUtils`, `FilesApi` and `CompressionError` types.
- `@statewalker/webrun-files-node`, which provides `NodeFilesApi`. `createNodeFilesApi()` is a thin factory over it.
- `node:zlib` and `node:util` from the Node.js runtime.

## License

MIT
