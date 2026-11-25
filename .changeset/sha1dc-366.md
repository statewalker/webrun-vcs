---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-transport": minor
---

SHA-1 collision detection as git's sha1dc (statewalker/statewalker-root#366): object ids are hashed with sha1dc's unavoidable bit conditions and recompressions for its 32 disturbance vectors (`createSha1`, `sha1Of`, `ObjectFormat.createHasher`, the new one-shot `ObjectFormat.hashObject`), and a hash that meets a known collision attack (SHAttered, Shambles) throws `Sha1CollisionError` with git's message (`SHA-1 appears to be part of a collision attack: <id>`). Checksums of packs, idx, rev, mtimes, bitmaps, midx, commit-graphs and the index use git's "unsafe" hash without detection (`createSha1Unsafe`, `ObjectFormat.createUnsafeHasher`; `ObjectFormat.digest` stays Web Crypto), and `computeObjectId` no longer takes Web Crypto for SHA-1 object ids. `ObjectFormat` gains `createUnsafeHasher` and `hashObject` (implementers must add them).
