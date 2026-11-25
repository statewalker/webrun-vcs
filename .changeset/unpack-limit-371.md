---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-core": minor
---

Keep or explode a received pack as git does (statewalker/statewalker-root#371): receive-pack reads `receive.unpackLimit` (else `transfer.unpackLimit`, else 100; 0 keeps every pack), fetch reads `fetch.unpackLimit` (else `transfer.unpackLimit`; 0 unpacks every pack) and keeps every pack under `fetch.fsckObjects`/`transfer.fsckObjects`; served repositories pass the limit through. New `git.unpackObjects()` (`git unpack-objects` with `-n` and `--strict[=<list>]`). vcs-transport: `unpackLimitOf`, `parseConfigInt`, `PackImportOptions.unpackLimit`, `ReceivePackConfig.unpackLimit`, `checkUnpackedObjects`' `onWritten`; vcs-core: `PackImportOptions.unpackLimit`.
