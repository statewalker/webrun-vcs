---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-transport": minor
---

**Breaking: the index is written through `index.lock` and keeps git's extensions; strict hex and object ids; `0002` is a `response-end` packet; linear pkt-line readers; text blobs read once.**

- **vcs-working-tree:**
  - `GitStaging.write()` follows git's lock-file protocol: it creates `<index>.lock` (check-then-write: exclusive among writers sharing one FilesApi and against an existing lock file, not against a process racing the same instant), streams the index into it and renames it over the index. An existing lock fails the write with the new `IndexLockedError` (`Unable to create '.git/index.lock': File exists.`) and leaves both files alone; a failed write removes its lock. `createGitStaging(files, path, { lockTimeoutMs })` retries for a while instead of failing at once. New `writeIndexFile(files, path, entries, options)` does the same for direct writes. Once it holds the lock, `write()` checks that the index is still the one it last read (trailing checksum) and otherwise fails with the new `IndexChangedError` (`index changed on disk since it was read; re-read and retry`), removing the lock and leaving the index alone; `writeIndexFile` takes this check as `expectedChecksum` and returns the checksum it wrote. New `breakIndexLock(files, gitDir)` removes a lock left by a crashed writer (for OPFS and in-memory repositories). Known limitation: where `FilesApi.move` falls back to copy then delete (webrun-files-browser), a failed delete after the copy makes `write()` throw although the index was replaced.
  - Index extensions survive a rewrite (`carryIndexExtensions`): `TREE`, `UNTR` and `FSMN` are kept while the entries are unchanged and dropped otherwise; `REUC` (resolve-undo) is kept with every record, as git does (a corrupt one is dropped), and a full `readTree` clears it, as git's read-tree and reset do; `EOIE`, `IEOT` and unknown optional (uppercase) extensions are dropped, as git drops extensions it does not know. An index with a required (lowercase) extension we do not support, such as `link` (split index), is refused by `read()` and `write()` with `UnsupportedIndexExtensionError`. Before, every extension was dropped.
  - `ParsedIndex` gains `extensionData` (each extension's signature and payload); `encodeIndexFile` and `serializeIndexFile` take the extensions to write as a third argument. Entry paths of an index with a required extension are no longer validated by `parseIndexFile` (a split index has entries with empty paths).
  - `encodeIndexFile` throws `InvalidObjectIdError` for an entry whose object id is not exactly 40 lowercase hex characters, before writing anything.
- **vcs-store-files:** `FileStagingStore` writes the index the same way (lock, changed-index check, extensions, resolve-undo cleared by `readTree`), and takes the same `{ lockTimeoutMs }` option.
- **vcs-utils:** `hexToBytes` throws on odd length and on non-hex characters. Before, they became zero bytes.
- **vcs-core:**
  - New `objectIdToBytes(id)`: the 20 bytes of an id, or `InvalidObjectIdError` unless it is exactly 40 lowercase hex characters. Tree encoding (`encodeTreeEntries`, `collectTreeBytes`, `serializeTree`) uses it, so a malformed entry id throws `InvalidObjectIdError` instead of a plain `Error` (or, for 40 non-hex characters, being written as zeros).
  - `probeBlob(blobs, id, { loadText: true })` reads a text blob once and returns it as `content`; a binary blob is still read only to its first 8000 bytes, and only those 8000 bytes are allocated.
- **vcs-commands:** `DiffFormatter` and `MergeCommand` use the single read: a text blob is read once (one delta resolution for a packed blob), not once to probe and again to load.
- **vcs-transport:**
  - `pktLineReader` and `parsePacket` return `0002` as `{ type: "response-end" }` (they threw). The packet type `"end"` is renamed `"response-end"` (`PacketType`, `endPacket()`, `pktLineWriter`). `demuxSideband` and `parseReportStatus` stop at it as at a flush; `TransportApi.readPktLine` rejects it with a clear `PacketLineError`.
  - An `ACK` with an object id that is not hex fails with `PackProtocolError`, as before.
  - `TransportApi.readPktLine` and `readGitProtocolRequest` keep received bytes in a chunk queue and copy each byte once; they copied the whole buffer for every chunk.
