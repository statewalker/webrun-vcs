---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-transport": patch
---

**SHA-256 transport follow-ups (#241).**

- **clone:** a clone switching the destination's object format checks first that the destination holds no refs and no objects of its own (`reopenWithObjectFormat` no longer counts what its alternates hold), and only then removes `objects/info/alternates`: a refused destination keeps its alternates file.
- **proc-receive:** the hook's `option old-oid`/`option new-oid` are read as git's `parse_oid_hex`, at the repository's hex length (`ProcReceiveRun.objectFormat`): in a SHA-1 repository a 64-digit id is its first 40 digits, in a SHA-256 repository a 40-digit id is no id and the option is ignored.
