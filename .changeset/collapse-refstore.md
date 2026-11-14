---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-transport-adapters": minor
"@statewalker/vcs-commands": patch
---

**Breaking: one ref interface, `Refs`.**

- **vcs-core removals:** the legacy `RefStore` interface, its `RefStoreLocation` alias (use `RefStorage`), `RefsAdapter` and `createRefsAdapter`.
- **`createHistoryFromComponents`:** `refs` is now `{ type: "memory" }` or any `Refs` implementation, used as is. It replaces `{ type: "adapter", refStore }`. Anything else, including a stale `{ type: "adapter", … }` from untyped JavaScript, throws at runtime.
- **vcs-store-files:** `FileRefStore` implements `Refs` directly. `delete(name)` is now `remove(name)`.
- **vcs-commands:** `CheckoutCommandOptions.refs` is a `Refs`.
- **Ref updates through `Refs`, on every backend:**
  - **Creates and updates** behave as before: one atomic command, `oldId` null meaning "must not exist".
  - **Deletes** are now one atomic command too. They remove the named ref itself (for a symbolic ref, not its target), check `oldId` when it is given, and return `false` for a missing ref.
  - **Names** outside `refs/` and `HEAD` are refused.
