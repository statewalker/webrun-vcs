---
"@statewalker/vcs-store-files": patch
---

`repack --geometric` removes the stale `.mtimes`, `.bitmap` and `.promisor` (and `.rev` when none is written) of a pack it writes under the name of one already there, as git's `generated_pack_install` does: a follow walk that rescues a whole cruft pack writes it again byte for byte, and the result is a plain pack, not a cruft one.
