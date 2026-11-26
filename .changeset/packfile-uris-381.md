---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-core": minor
---

Protocol v2 packfile URIs (statewalker/statewalker-root#381): served repositories read `uploadpack.blobPackfileUri` (`blobPackfileUris` in the server settings), advertise `fetch=... packfile-uris` and, for a client that asks with `sideband-all`, leave the configured objects out of the pack and name their packs in a `packfile-uris` section (`ExportPackOptions.leaveOut`, vcs-core `ExportOptions.leaveOut`). The fetch client sends `fetch.uriProtocols` (`FetchClientOptions.uriProtocols`, http and https only), keeps the server's pack, downloads each named pack (`packfileUriFetch`, without the remote's credentials), and publishes it only when its checksum is the one sent (`PackfileUriHashMismatchError`). upload-pack v2 answers nothing to a fetch without wants.
