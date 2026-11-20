---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-utils-node": patch
---

**Pluggable transports: remote URLs resolved as git resolves them, and reached through a registry of connectors.**

- New `connect/` module in vcs-transport: `parseGitUrl` reads a remote URL as git's `transport_get` and connect.c's `parse_connect_url` do (scp-like `host:path`, `[ipv6]:path`, `ssh://host:22/~user/x`, `file://`, `<helper>::<address>`), returning a `GitUrl`. A `GitTransportConnector` turns a `GitConnectRequest` into a `GitSession` (a native duplex, with or without git-daemon's request line, or a smart-HTTP endpoint behind a `fetch` function); `GitTransportRegistry` picks one per URL, `createDefaultTransports()` registers smart HTTP, and `openUploadPack` / `openReceivePack` open the pack protocol over a session.
- Breaking: the JGit-style URL parser of `utils/` is now exported as `parseGitUri` (type `GitUri`); `parseGitUrl` and `GitUrl` name the new parser.
- `encodeGitProtocolRequest` writes extra parameters after a second NUL, as git does.
- vcs-commands: fetch, pull, push, clone, ls-remote and `remote set-head -a` reach non-local remotes through the registry: `TransportCommand.setTransports(registry)` or `Git.fromWorkingCopy(workingCopy, { transports })` (default: smart HTTP, as before). Paths and `file://` URLs stay git's local transport.
- `url.<base>.insteadOf` and `url.<base>.pushInsteadOf` rewrite remote URLs as git's remote.c does (longest match, push rewrites only for remotes without `pushurl`, URLs given directly included); an empty `remote.<name>.url` clears the earlier ones (git 2.5x).
- `protocol.allow`, `protocol.<name>.allow`, `GIT_PROTOCOL_FROM_USER` and `GIT_ALLOW_PROTOCOL` are honoured with git's defaults and errors ("fatal: transport 'ext' not allowed"); `protocol.version` is read (default 2), the local transport included.
- A remote name is told from a URL as git's `remote_get` does (a configured remote wins), so a remote whose name holds `@` works.
- New `git.remoteGetUrl()` (`git remote get-url [--push] [--all]`) and `LsRemoteCommand.callGetUrl()` (`git ls-remote --get-url`).
- `GitHostEnvironment` gains `protocolFromUser` and `allowProtocol`, read by `createNodeGitHostEnvironment` from the environment.
- Remote URLs that look like options are refused as git refuses them before running a command: "fatal: strange pathname '-r' blocked" (ssh and local paths), then, after `protocol.ssh.allow`, "fatal: strange hostname '-oProxyCommand=x' blocked" (ssh). `parseGitUrl` follows `get_host_and_port` (the first colon past the host starts the port, read as `strtol` reads it; `[user@host:22]:repo`; `host:/~user/x` asks for `~user/x`; `host:` names the empty path), keeps `%00` as written and stops at a NUL; `gitDaemonRequest` refuses a NUL in the host, path or extra parameters.
- A connector is never asked for protocol v2 for receive-pack (`protocolVersionFor`, as git_connect); `protocol.version=1` is spoken: the client sends `version=1` (git-daemon parameter, `Git-Protocol` header on every smart-HTTP request) and reads the server's `version 1` line, and our servers answer it (`serveOverDuplex({ announceVersion1 })`, the smart-HTTP handler, the local transport).
- `openDuplexConnection` takes `timeout` and `signal` (as `openDuplexReceivePackConnection`), passed from the request by `openUploadPack`; a native session's stream is closed once.
- `createHttpConnector` serves `https::<url>` with the helper's address as its URL; `ls-remote` lists over the session as fetch does (ls-refs over v2).
- `ls-remote` without a remote picks git's default remote (`branch.<current>.remote`, the only remote, else `origin`), else "fatal: No remote configured to list refs from.".
- `clone` tells a path from a URL first, as clone.c: an existing repository path is recorded absolute (`remote.origin.url`, the reflog) and `insteadOf` applies to that absolute path; a name without a colon that is no repository path is "repository '<name>' does not exist", not rewritten.
- `RemoteConfigStore.read()` (and `remoteList()`) report URLs as `git remote -v` does: `insteadOf`/`pushInsteadOf` applied, an empty `url` clearing the earlier ones.
