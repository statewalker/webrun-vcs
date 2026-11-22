---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-store-kv": patch
"@statewalker/vcs-store-sql": patch
---

**proc-receive: the review's fixes.**

- `PushCommand` checks the remote-tracking refs a server's report names before writing them, as git's `update_one_tracking_ref` / `refs_update_ref`: an `option new-oid` of an object the client does not have, or an `option refname` no ref may have (`refs/heads/a..b`, `refs/heads/../../x`), is refused with git's error line (`error: update_ref failed for ref '<ref>': trying to write ref '<ref>' with nonexistent object <id>` (2.43: `cannot update ref '<ref>': ...`), `refusing to update ref with bad name '<ref>'`; a deletion `error: refusing to update ref with bad name '<ref>'`) in `PushResult.errors`; the push still succeeds, as git's exits 0.
- **Behaviour change:** every ref store's `set` refuses a name git's ref transaction refuses (`check_refname_format` with one level allowed): the files store wrote such names as loose files (one outside the refs for `..` components), memory, KV and SQL stores kept them.
- send-pack fails a push whose report has an `option` line without its `ok` (`error: 'option' without a matching 'ok/ng' directive`, `PushClientResult.reportFailed`, `PushResult.failed`, no porcelain `Done`) and warns of reports on refs it did not send (`warning: remote reported status on unknown|unexpected ref: <ref>`), as git's `receive_status`.
- receive-pack's `hookTimeoutMs` covers the proc-receive hook: past it the hook is stopped (`ProcReceiveProcess.kill`, `HookProcess.kill`, the Node runner kills the child) and the commands it did not report fail `fail to run proc-receive hook` (every command of an atomic push). A proc-receive `ng <ref> ` keeps its empty reason, so the client shows `[remote rejected] ... ()` as with git.
- proc-receive's stderr reaches the pushing user as the hook writes it (`HookRunner.start(invocation, { onStderr })`, git's `copy_to_sideband`) instead of being kept whole until it exits.
- `receive.procReceiveRefs` without a value makes receive-pack die before its advertisement with git's lines (`error: missing value for 'receive.procreceiverefs'`, `fatal: bad config variable ... in file 'config' at line N`; `ServerConfigSettings.receivePackConfigError`, `ReceivePackConfig.configError`; HTTP answers 500).
