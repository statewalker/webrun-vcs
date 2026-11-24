---
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-commands": patch
---

`git apply --index` builds its conversion's attributes when git's convert.c does: `verify_index_match` reads (and converts) a file only when it is racily clean (`ie_match_stat` against the index's time), the whitespace rules read at parse time are an attribute stack of their own (`ContentAttributesContext.check`), and a stack first built while the patch is written reads the index as apply has edited it so far (`OperationOptions.index`). A patch changing `.gitattributes` beside the files it converts no longer gives CRLF where git gives LF, a result that used to depend on the timing of the files' last change.
