---
"@statewalker/vcs-utils": major
"@statewalker/vcs-testing": minor
---

**Git pack deltas: checked apply and an encoder.** `applyGitDelta(base, delta, maxSize?)` now makes git's patch-delta.c checks, all before it allocates, and throws the new `DeltaError`: a copy past the end of the base used to produce zero bytes silently, and the declared result size was allocated before any instruction was checked. Pass `maxSize` for untrusted deltas. Removed: `applyGitDeltaStreaming`, which checked none of this and had no callers. New: `createGitDeltaIndex`, `encodeGitDelta` (git's diff-delta format, which native `git index-pack` accepts), `gitDeltaIndexBytes`, `gitDeltaIndexEstimate`. vcs-testing gains `buildPack`, `craftDelta`, `copyAll`, `deltaVarint` and `oidOf` to hand-build pack files for edge cases.
