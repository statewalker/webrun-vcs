---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-sql": minor
"@statewalker/vcs-store-kv": patch
"@statewalker/vcs-store-mem": patch
---

**Paths that are not UTF-8 in pattern files, patches, command text and the SQL store, as in git.**

- **vcs-utils:** `decodeGitPatternFile` reads a pattern file as git does (bytes through `decodeGitPath`, a leading BOM skipped); `unquoteGitPath` is git's `unquote_c_style` on bytes. The patch parser reads C-quoted names (`"a/caf\351.txt"`, in `diff --git`, `---`/`+++`, `rename`/`copy` lines and `diff --cc`) and raw names (`core.quotePath=false`) as the paths trees and the index hold, and splits two unquoted names with spaces where both halves name the same path, as `git apply` does.
- **vcs-working-tree, vcs-store-files:** `.gitignore`, `info/exclude`, `core.excludesFile` and `.gitattributes` keep their bytes: a latin-1 rule (`caf\xe9.txt`, `*\xe9*`) matches the path bytes git matches, so status, clean, add and the `text`/`eol`/`ident` conversions agree with git.
- **vcs-commands:** `DiffCommand.callText()` and `DiffFormatter.toString()` decode the output bytes with `decodeGitPath`: a byte that is not UTF-8 is an escape instead of U+FFFD, and `encodeGitPath(text)` is `callBytes()`. `formatStatusPorcelain` takes `{ quotePath }` (`core.quotePath=false` prints the bytes) and quotes control characters with git's letters (`\r`, `\a`, ...). `diff.orderFile` patterns keep their bytes. State files (`MERGE_MSG`, ...) are written and read as bytes, so a conflicted latin-1 path is listed as git lists it, and conflict lists and the stash and sequencer path orders follow git's byte order (`compareGitPaths`).
- **vcs-store-sql:** paths and tree entry names in TEXT columns (`tree_entry`, `tree_delta_entry`, `staging_entry`) store a lone surrogate as U+0001 and four hex digits (`toSqlPath` / `fromSqlPath`), since drivers turn it into U+FFFD. UTF-8 names are stored unchanged, so no migration is needed. A tree rebuilt from the store keeps its id.
- **vcs-store-sql, vcs-store-kv, vcs-store-mem:** staging entries sort in git's byte order (`compareGitPaths`) instead of UTF-16 code units.
