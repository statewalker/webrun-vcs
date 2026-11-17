---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-store-sql": patch
"@statewalker/vcs-commands": patch
"@statewalker/vcs-core": patch
---

**Path matching, case folding and git directory pointers as git does them, bytes included.**

- **vcs-working-tree:** ignore and attribute patterns compare their literal prefix and `*suffix` as bytes when the pattern holds bytes that are no UTF-8, so `caf\xc3*` or `*\xa9` takes the UTF-8 `café` as in git (`wildmatchBytes` and `sameBytes` are exported next to `wildmatch`). Ignore rules now honour `core.ignoreCase` (`IgnoreRule.matchesPath(path, isDirectory, ignoreCase)`, `IgnoreNode.checkIgnored(..., ignoreCase)`, `IgnoreManager.setIgnoreCase`, `createIgnoreManager({ ignoreCase })`, `Worktree.setIgnoreCaseReader`, set by working copies from their configuration). Attributes with `core.ignoreCase` fold ASCII letters only, as git's `fspathncmp` does, so `É` no longer matches `é`.
- **vcs-utils:** `foldAsciiCase` lowers ASCII letters only (git's `tolower` / `strncasecmp`).
- **vcs-commands:** `:(icase)` pathspecs in `clean`, the case-insensitive name lookups of the overwrite checks and of merge-ort's unique paths fold ASCII only, as git's `strncasecmp` and `memihash`.
- **vcs-core:** `.git` / `.gitmodules` spellings (HFS+, NTFS) fold ASCII only, as git's `verify_path`; no accepted or refused path changes.
- **vcs-store-files:** a `.git` file's `gitdir:`, a `.git` link's target, `commondir`, a submodule's HEAD and refs, and the config file are read as bytes (`decodeGitPath`), and `addWorktree` writes the `gitdir:` file and the back-pointer as bytes: a git directory whose path is no UTF-8 is found, and rewriting the config keeps a latin-1 value's bytes.
- **vcs-store-sql:** `SQLStaging.listEntriesUnder` is a range query: no longer ASCII case-insensitive and no `_` / `%` wildcards (`src` no longer lists `SRC/…`, `a_b` no longer lists `aXb/…`). `searchMessage` takes `%`, `_` and `\` literally. `findByNamePattern` returns entries by tree id and then by name in git's byte order.
