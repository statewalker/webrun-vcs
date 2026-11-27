---
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-transport": patch
---

A clone of a shallow repository writes `.git/shallow` as native git does: the server's shallow commits in the order sent, a commit sent twice (a branch and an annotated tag reaching it, over protocol v2) on two lines (`Refs.setShallow`'s new `verbatim` option). Fetch and clone send their wants in the order the remote listed the refs (HEAD first for a clone), as fetch-pack's `filter_refs` does, so a shallow server's answer follows git's order too. Reading a shallow file merges duplicate lines. (#326)
