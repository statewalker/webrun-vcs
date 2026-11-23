---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": minor
---

receive-pack now checks pushed objects as git does under `receive.fsckObjects` (else `transfer.fsckObjects`). Served repositories (`servedRepositoryOf`) and local pushes read `receive.fsck.<msg-id>` and `receive.fsck.skipList` in config order (`receiveFsckOf`). A pack the store unpacks is checked as unpack-objects `--strict` does; a kept pack is checked as index-pack `--strict` does. A refused pack is discarded with its quarantine. The client sees git's `remote: error: object <id>: <msg-id>: ...` lines, the unpack status `unpack-objects abnormal exit` or `index-pack abnormal exit`, and `unpacker error` for each ref. Unknown message ids warn, and a message type receive-pack cannot read kills it as git's does. `ReceivePackConfig.fsckObjects` carries the check in vcs-transport.

receive-pack also reports the death of its connectivity check (`fatal: missing blob object ...`) on the progress channel. The push client records `error: remote unpack failed: <status>` in `PushResult.errors`, and keeps porcelain `Done` after a refused unpack over smart HTTP, as git's remote-curl helper does.

A served repository's `receive.fsck.skipList` is read only inside its own git directories, as confined config includes are (`readConfinedFile` in vcs-store-files: symbolic links followed and checked, size cap). Any other path reads as unreadable (`could not open object name list`), so a repository's config cannot make the server read or echo another tenant's or the host's files. A local push into one's own repository reads the skip list as git does.
