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
