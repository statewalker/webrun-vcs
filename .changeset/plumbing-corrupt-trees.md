---
"@statewalker/vcs-commands": patch
---

Plumbing reads walk trees as git's `tree_desc` does (statewalker/webrun-vcs#351): `ls-files --with-tree` lists an entry named `..` and dies on a missing subtree (`error: Could not read <id>`, `fatal: unable to read tree entries <tree>`, exit 128); a corrupt tree (`too-short tree object`, `malformed mode in tree entry`, `empty filename in tree entry`) is git's death, exit 128, in `ls-tree`, `cat-file -p`, `ls-files --with-tree`, `replace --edit` and any `<rev>:<path>` through it, after the entries git shows first. New export: `CorruptTreeError`.
