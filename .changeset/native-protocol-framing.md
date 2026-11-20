---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-commands": minor
---

**git's native protocol over any byte stream: `git://` and ssh connectors on host hooks, and a git-daemon server.**

- `Duplex.end?()` half-closes a stream's write side. The native clients end it where git closes its end (after a push's request, after the final flush of a fetch); a transport without it is left as it is. Node sockets that carry it need `allowHalfOpen: true` on both ends.
- `serveGitConnection({ duplex, resolveRepository, enableReceivePack, ... })` serves a connection as git-daemon does: it reads the request line (`readGitDaemonRequest`, without losing the bytes after it), refuses as daemon.c does (`ERR access denied or repository not exported: <path>`, or the informative reasons; aliases such as `/../`, receive-pack unless enabled, a repository's `daemon.uploadpack` / `daemon.receivepack` override, upload-archive), and runs upload-pack (v0, v1, v2) or receive-pack with the repository's settings. `serveGitService` serves a session whose service, path and `GIT_PROTOCOL` arrived out of band (an ssh channel; `parseGitServiceCommand` reads `git-upload-pack '<path>'`).
- `createGitDaemonConnector({ openSocket })` (`git://`, port 9418) and `createSshConnector({ exec })` (`ssh://`, `git+ssh://`, `ssh+git://`, `host:path`: git's `git-upload-pack '<path>'` with `sq_quote`, `GIT_PROTOCOL=version=<n>`), registered by `createDefaultTransports({ openSocket, exec })` only when the host gives the hook. `GitConnectRequest.program` carries `--upload-pack` / `--receive-pack` and `remote.<name>.uploadpack` / `receivepack`.
- Smart-HTTP `info/refs` failures use git's words: "fatal: repository '<url>/' not found", "fatal: Authentication failed for '<url>/'", "fatal: unable to access '<url>/': The requested URL returned error: <code>", a `text/plain` body first as `remote:` lines.
- `ls-remote` keeps the v2 symref and peeled data (`RemoteRef.symbolic`, `target`, `peeledObjectId`), takes the default branch from HEAD's symref, sends `ref-prefix` for `--heads` / `--tags` over v2, shows both kinds with both flags, and passes `setUploadPack` to the connector.
- vcs-commands: `servedRepositoryOf(openedRepository, { hooks })` gives `serveGitConnection` a repository with the settings git's receive-pack reads from it.
- `IdleTimer` and `abortErrorOf` are no longer exported from the package root.
