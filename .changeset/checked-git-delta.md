---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-testing": minor
---

**Git pack deltas: checked apply and an encoder.** `applyGitDelta(base, delta, maxSize?)` now checks every instruction before it allocates (git patch-delta.c, JGit BinaryDelta) and throws the new `DeltaError`: a copy past the end of the base used to produce zero bytes silently, and a huge declared size was allocated before anything was checked. New: `createGitDeltaIndex`, `encodeGitDelta` (git's diff-delta format, which native `git index-pack` accepts), `gitDeltaIndexBytes`, `gitDeltaIndexEstimate`. vcs-testing gains `buildPack`, `craftDelta`, `copyAll`, `deltaVarint` and `oidOf` to hand-build pack files for edge cases.
