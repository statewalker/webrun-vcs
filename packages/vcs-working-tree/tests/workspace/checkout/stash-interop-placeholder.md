# Stash Git Interop Tests - Deferred

The stash git interop tests from the old `packages/vcs-core/tests/interop/stash-git-interop.test.ts` file tested:
- Reading stash lists created by native git
- Reading stash commits and applying them
- Creating stashes with VCS that native git can read
- Round-trip interoperability

## Deferral Rationale

These tests require a concrete CheckoutStash implementation to be meaningful. The Checkout interface defines CheckoutStash as an optional interface, and GitCheckout/MemoryCheckout implementations currently don't provide stash functionality.

## Implementation Plan

When CheckoutStash is implemented, restore these tests by:
1. Creating a `stash-git-interop.test.ts` file
2. Adapting the old tests to use the new Checkout/CheckoutStash interfaces
3. Verifying stash commits created by VCS can be read by native `git stash` commands
4. Verifying stashes created by native git can be read by CheckoutStash implementations

## Reference

Original test file can be retrieved from commit 9a21fa7^ with:
```bash
git show 9a21fa7^:packages/vcs-core/tests/interop/stash-git-interop.test.ts
```
