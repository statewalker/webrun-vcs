---
"@statewalker/vcs-utils": patch
"@statewalker/vcs-utils-node": patch
"@statewalker/vcs-store-files": patch
---

The Node FilesApi's `write` gives the replacement an existing file's `mode & 0o7777` before writing it, as git chmods its lock before the write (so an unprivileged process loses setuid as the kernel clears it, exactly as native git does), and `PosixFilesApi.chmod` takes `{ highBitsFrom }`: a regular file keeps only the high bits that file already carries, so `git config` edits keep a 02640 `.git/config` at 02640 as git's lock does, while a plain `chmod` still never raises them (statewalker/webrun-vcs#273).
