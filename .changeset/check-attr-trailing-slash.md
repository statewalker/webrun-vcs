---
"@statewalker/vcs-working-tree": patch
---

attributes: a path ending in `/` is a directory, as attr.c's `collect_some_attrs` reads it: `git check-attr dir/` matches directory-only patterns (`src/`, `/src/ne?`) and reads the attribute files of the parent directory, not of `dir` itself.
