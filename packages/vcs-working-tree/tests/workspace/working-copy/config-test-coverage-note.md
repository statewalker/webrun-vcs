# GitWorkingCopyConfig Test Coverage - Deferred

The repository setup tests from `packages/vcs-core/tests/working-copy/repository-setup.test.ts` (deleted in commit 9a21fa7) tested:
- Bare repository detection from core.bare config
- Gitdir file parsing (.git file with gitdir: directive)
- core.worktree configuration support

## Current Status

GitWorkingCopyConfig class exists at `packages/vcs-core/src/workspace/working-copy/working-copy-config.files.ts` but has no test coverage.

## Scope Note

These tests are about WorkingCopy configuration parsing, not Checkout functionality. They are beyond the scope of F1.10 "Restore Checkout Test Coverage" epic, which focuses on:
- Checkout interface conformance
- HEAD management
- Operation state (merge, rebase, etc.)
- Git interoperability for checkout state

## Recommendation

Create dedicated tests for GitWorkingCopyConfig in a separate task/epic focused on WorkingCopy test coverage. Tests should cover:
1. Bare repository detection (core.bare = true/false/yes/no/on/off)
2. Gitdir file parsing
3. core.worktree configuration
4. JGit parity scenarios

## Reference

Original test file can be retrieved from commit 9a21fa7^ with:
```bash
git show 9a21fa7^:packages/vcs-core/tests/working-copy/repository-setup.test.ts
```
