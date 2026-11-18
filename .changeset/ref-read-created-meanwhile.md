---
"@statewalker/vcs-store-files": patch
---

A ref update no longer fails with "<ref> is broken: \"\"" when another process creates the ref
while this one reads it. The git-files ref batch asked whether a ref file existed only after a
read found no bytes, so a ref renamed into place in between read as an empty, broken file; it now
checks first, as git's `files_read_raw_ref` does (lstat, then read), and looks once more when the
file vanishes between the check and the read.
