---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils-node": minor
---

**git's proc-receive hook and report-status-v2.**

- receive-pack hands the commands `receive.procReceiveRefs` matches (`[a][d][m][!]:<prefix>`, as git's `proc_receive_ref_matches`) to the proc-receive hook instead of updating them: after pre-receive and the publication of the pushed objects, over git's proc-receive protocol (`version=1` with the `atomic` and `push-options` features, the commands, the push options the hook asks for), reading its `ok`/`ng` report and its `option refname|old-oid|new-oid|forced-update|fall-through` lines with git's errors for a broken hook (`cannot find hook 'proc-receive'`, `proc-receive version 'N' is not supported`, `fail to negotiate version with proc-receive hook`, `proc-receive reported status on unknown ref`, `proc-receive failed to report status`, ...). Its commands skip the update hook and the ref transaction; an atomic push fails as git's does (`fail to run proc-receive hook`, the transaction's error given to the hook's commands too); post-receive is told each report. Wired on the local push, the served (HTTP, git://, duplex) receive path and `remoteHookSession` (found as `find_hook` finds it: no configured hook). `ReceivePackHooks.procReceive`, `ReceivePackConfig.procReceiveRefs`, `runProcReceive`, `parseProcReceiveRef`, `procReceiveRefMatches` are exported; `serverSettingsFromConfig` reads `receive.procReceiveRefs`.
- **Behaviour change:** receive-pack advertises `report-status-v2`, as git does, and answers in it when the client asks (the hook's rewrites as `option` lines); report-status otherwise.
- send-pack asks for `report-status-v2` when offered and keeps the server's rewrites (`PushRefUpdate.reports`, `RemoteRefUpdate.reports`): the push report prints one line per rewrite as git's `print_ref_status` (` * [new reference]   HEAD -> refs/pull/123/head`), the remote-tracking refs follow each, and `PushResult.porcelain` (`formatPushStatus(..., { porcelain: true })`) gives `git push --porcelain`'s stdout.
- `HookRunner.start` (vcs-working-tree) starts a hook with its stdin and stdout piped while it runs; `createNodeHookRunner` implements it, and `HookSession.start` (vcs-commands) uses it.
