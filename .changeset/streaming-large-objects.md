---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-transport": patch
"@statewalker/vcs-transport-lfs": minor
"@statewalker/vcs-transport-xet": minor
---

**Large objects stream: incremental SHA-256, streaming LFS and Xet.** No LFS or Xet path holds a whole object in memory any more.

- **vcs-utils:** new `createSha256()`, an incremental `Hasher` like `createSha1()` (on `@noble/hashes`). The streaming request body helpers (`requestBody`, `fetchWithRequestBody`, `shouldStreamRequestBody`, `supportsRequestStreams`, `isBrowserContext`, `toReadableStream`) moved here from vcs-transport and are exported from `@statewalker/vcs-utils/streams`.
- **vcs-transport:** re-exports those helpers from vcs-utils; its public API is unchanged.
- **vcs-transport-lfs (breaking):** `lfsUpload` sends a streaming body (`duplex: "half"`, with `content-length` from the pointer; browsers collect unless the new sixth argument `{ streamRequestBody: true }` is passed). `lfsDownload` and the server's `PUT` store the body as it arrives, hashing it on the way, and remove the object again when its SHA-256 does not match; `lfsDownload` also checks the pointer size and reports the new reason `size mismatch`, cutting off a body that runs past it. The server's `GET` streams with `content-length`. `sha256Hex` now takes a buffer or a stream (`ByteSource`) and no longer uses Web Crypto. New: `createLfsPointer` (streamed oid and size, the hashing half of a clean filter), `formatLfsPointer`, `parseLfsPointer`, `LFS_POINTER_VERSION`, `storeVerified`, and the types `LfsTransferOptions`, `LfsStoreResult`, `ByteSource`.
- **vcs-transport-xet (breaking):** a xet download verifies the assembled object by streaming it through SHA-256 and also checks its size (`size mismatch`). The server now verifies an uploaded object's whole-file SHA-256 against the oid while assembling it, and refuses it on a mismatch (`xet upload refused: sha256 mismatch`). New `XetOptions.streamRequestBody` for the basic fallback.
