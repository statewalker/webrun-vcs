---
"@statewalker/vcs-commands": patch
---

check-attr, check-ignore: a `--stdin` line C-quoted with `\000` ends the path at the NUL, as git reads the unquoted strbuf as a C string (`"\000"` is the empty path, `"a\000b"` is `a`).
