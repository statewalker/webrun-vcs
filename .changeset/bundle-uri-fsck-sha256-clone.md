---
"@statewalker/vcs-commands": patch
---

Bundle URIs: under `fetch.fsckObjects`/`transfer.fsckObjects` an unbundled pack is checked in a quarantine as git 2.46+'s `VERIFY_BUNDLE_FSCK` does (fsck's lines, no `refs/bundles/` ref, the clone goes on), and a clone reopened in the remote's object format (`GIT_DEFAULT_HASH=sha256` against a SHA-1 remote) applies `--bundle-uri` again, read in that format (git 2.43 read it in the destination's first hash).
