---
"@statewalker/vcs-core": patch
"@statewalker/vcs-utils": patch
"@statewalker/vcs-store-files": patch
---

Ref names holding bytes that are not UTF-8 (statewalker/webrun-vcs#376): `isValidRefName` accepts `decodeGitPath`'s escapes U+DC80..U+DCFF as git's `check_refname_format` accepts every byte from 0x80 up, and `compareRefNames` orders names by their bytes. `refs migrate` no longer drops such a loose ref and its reflog (and then removes the old storage), `pack-refs` packs it, `refs verify` takes it as valid, and packed-refs, loose symrefs and reftables read and write its bytes unchanged (`decodeGitPath`/`encodeGitPath` instead of `TextDecoder`/`TextEncoder`). vcs-utils: `decodeGitPath` decodes input that is not UTF-8 in linear time.
