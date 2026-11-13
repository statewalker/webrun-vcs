---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-utils-node": minor
---

**New (vcs-utils):** `createInflater({ raw? })` is a push inflater that reports exactly where each zlib or raw-deflate stream ends: each push returns `{ out, done, consumed }`. `abort()` gives a stream up without an error. States are pooled, as in JGit's InflaterCache. `createInflaterPool()` creates a private pool. `TruncatedStreamError` and `InflateError` extend `CompressionError`.

**Changed (vcs-utils):** `decompressBlockPartial` now throws `TruncatedStreamError` on truncated input; before, it returned short data with no error. `BufferedByteReader.readCompressedObject` and `readDecompressed` now pull and inflate each chunk once, where before they retried the whole buffer. They report corruption as `InflateError` rather than as missing data, and `readDecompressed` yields large objects in pieces. Breaking out of `readDecompressed` early is safe: the rest of the block is skipped. This fixes a size mismatch on large objects that arrive in small chunks.

**Breaking (vcs-utils-node):** `decompressBlockPartialNode` is removed, and `createNodeCompression()` no longer overrides `decompressBlockPartial`. Its binary search ran log2(n) inflates per object; the portable path is exact and takes one pass.
