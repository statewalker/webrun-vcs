---
"@statewalker/vcs-utils": patch
"@statewalker/vcs-utils-node": patch
"@statewalker/vcs-store-files": patch
---

The Node FilesApi's `write` keeps an existing file's setuid, setgid and sticky bits (`mode & 0o7777`), and `PosixFilesApi.chmod` takes `{ highBitsFrom }`: a regular file keeps only the high bits that file already carries, so `git config` edits keep a 02640 `.git/config` at 02640 as git's lock does, while a plain `chmod` still never raises them (statewalker/webrun-vcs#273).
