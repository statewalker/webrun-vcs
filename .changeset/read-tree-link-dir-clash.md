---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-store-mem": patch
"@statewalker/vcs-store-kv": patch
"@statewalker/vcs-store-sql": patch
---

`read-tree -m` (one-way and two-way) and `reset --mixed` of a crafted tree holding a link and a directory of one name keep only the directory's files in the index, as git's `add_index_entry` with `OK_TO_REPLACE` does: `Staging.readTree` of every store drops a file a directory of its name replaces, and read-tree's two-way merge reads its trees the same way (`flatTree(..., { asIndex: true })`). The index never holds a file/directory clash (webrun-vcs#247).
