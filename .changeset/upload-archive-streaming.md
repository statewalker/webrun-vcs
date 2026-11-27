---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-commands": minor
---

upload-archive streams the archive instead of holding it (#413). `UploadArchiveWriter` is now `(args, sink) => Promise<number>`: it writes stdout and stderr to an `UploadArchiveSink` as it goes, and `serveUploadArchive` sends each chunk on as side-band packets of at most 16 KiB, stderr interleaved in call order, waiting for the stream before the writer goes on (`UploadArchiveOutput` is gone). `runArchiveWriter(workingCopy, args, sink, options)` writes `ArchiveCommand.callStream()`'s chunks and returns the exit status. On the client side, `requestRemoteArchive`'s `output` option and `RemoteArchiveCommand.setOutput` hand the archive on chunk by chunk instead of collecting it. `ArchiveCommand.getMessages(from)` returns the messages from an index on, and `createDuplexPair({ highWaterMark })` gives a bounded in-memory pair.
