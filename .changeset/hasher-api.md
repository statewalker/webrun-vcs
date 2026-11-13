---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-sql": patch
---

**Breaking (vcs-utils):** one incremental `Hasher` interface (`update` / `digest` / `clone`) with `createSha1`, `createSha256` and `createBlake3` (plain, keyed, derive-key), on `@noble/hashes`. The vendored `Sha1` class, `newSha1` and `sha1Sync` are removed: use `createSha1().update(data).digest()`. New `computeObjectIdFromStream(type, size, chunks)` hashes a git object in one pass from a declared size and rejects with `SizeMismatchError` on a short or long stream. vcs-core and vcs-store-sql now hash through `createSha1`.
