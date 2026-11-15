---
"@statewalker/vcs-working-tree": patch
---

**Status trusts whole-second index times.** An index written by a git built without nanosecond support keeps no sub-second part in its times. Status now compares such an entry with the file in whole seconds, and judges its raciness in whole seconds, as that git does; before, every file of such an index was re-hashed.
