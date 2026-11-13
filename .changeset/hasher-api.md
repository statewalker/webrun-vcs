---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-sql": patch
---

**Breaking (vcs-utils):** incremental SHA-1 goes through one `Hasher` interface (`update` / `digest` / `clone`) from `createSha1()`, on `@noble/hashes`. The vendored `Sha1` class, `newSha1` and `sha1Sync` are removed.

Migration: `new Sha1().update(data).finalize()` becomes `createSha1().update(data).digest()`, and `sha1Sync(data)` becomes `createSha1().update(data).digest()`. Unlike `finalize()`, `digest()` can be read only once: the hasher is spent after it, so `clone()` first to keep the state.

New: `computeObjectIdFromStream(type, size, chunks)` hashes a git object in one pass from a declared size, and rejects with `SizeMismatchError` on a short or long stream. `computeObjectId` hashes objects of 64 KiB and more with Web Crypto, and smaller ones with the portable hasher. vcs-core and vcs-store-sql now hash through `createSha1`.
