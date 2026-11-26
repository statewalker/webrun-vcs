---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils-node": minor
---

fsmonitor: `core.fsmonitor=true` asks git's builtin daemon over a `MessagePort` the host opens (`GitHostEnvironment.openIpcPort`, `IpcPortRequest`; `queryFsmonitorDaemon` speaks simple-ipc's query), and `update-index --fsmonitor-valid` sets a gitlink's bit as git does. vcs-utils-node adds the Node socket adapter: `socketMessagePort`, `connectSocketPort` and `listenSocketPorts` turn a TCP or Unix-domain socket into one end of a `MessageChannel` (webrun-rpc's stream tier, with backpressure and an explicit half-close); the Node host environment opens IPC endpoints with it.
