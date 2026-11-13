---
"@statewalker/vcs-core": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": patch
---

**Changed (vcs-core):** `isValidRefName(name, { allowOneLevel? })` now gives exactly the verdict of `git check-ref-format`. A test checks it against git on 1,555 names. It now refuses names the old check accepted:
- a component that starts with `.`;
- a component that ends with `.lock` (not only the whole name);
- a name ending in `.`;
- `@`;
- single-component names, unless `allowOneLevel` is set.

**New (vcs-core):** `compareRefNames`, which sorts in git's order (the byte order of the UTF-8 names).

**Changed (vcs-commands):** branch and tag names follow git's own rules:
- `git branch` refuses a leading `-` and the name `HEAD`;
- `git tag` refuses a leading `-`;
- both then check the full `refs/heads/…` or `refs/tags/…` name.

So `a/.hidden`, `x.lock/y` and `trailing.` are now refused, and `@` is now accepted, as git accepts it. Branch and tag lists are now in git's order (uppercase first).

**Fixed (vcs-store-files):** `packed-refs` is written in git's byte order instead of `localeCompare` order.
