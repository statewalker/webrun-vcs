---
"@statewalker/vcs-store-files": minor
---

SHA-256 reftable repositories (`extensions.objectFormat = sha256` with `extensions.refStorage = reftable`, what git 3.0's `init --object-format=sha256` creates) now open and init. The reftable reader and writer handle version 2 tables with hash id `s256` (28-byte header, 72-byte footer, 32-byte ids in ref and log records and obj keys), byte for byte as git writes them; the ref store, stack reader and writer take the repository's `objectFormat` and refuse a table of another hash as git does ("corrupt reftable file"). `openReftable` takes `{ objectFormat }`, `createReftableStackReader` an options object, `ReftableWriteOptions` an `objectFormat`, and tables expose their `objectFormat`.
