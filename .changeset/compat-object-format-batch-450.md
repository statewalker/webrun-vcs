---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

`extensions.compatObjectFormat`: `cat-file --batch`, `--batch-check` and `--batch-command`, single-object `cat-file`, `ls-tree` and `rev-parse --output-object-format` take abbreviated and full ids of the compatibility format (git's `GET_OID_HASH_ANY`, `ResolveOptions.hashAny`: the loose object map's ids disambiguated with the stored objects). `commit -S` and `tag -s` (and every command signing a commit) sign the compatibility view too and write both signatures, as git master's `commit_tree_extended` and `do_sign`: new optional `Commit.compatSignature` / `AnnotatedTag.compatSignature`, and `CompatObjects.compatIdsWithPrefix` / `convertToCompat`.
