---
"@statewalker/vcs-core": patch
"@statewalker/vcs-commands": patch
---

`.git` spellings: read names as git's `is_hfs_dot_generic` does, where a byte outside valid UTF-8 ends the name, so `.git` followed by a truncated UTF-8 sequence is `.git` (checkout refuses it under `core.protectHFS`, fsck reports `hasDotgit`). fsck now decodes tree entry names with git's byte escapes instead of U+FFFD.
