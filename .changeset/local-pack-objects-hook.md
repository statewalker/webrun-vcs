---
"@statewalker/vcs-commands": patch
---

A fetch, `clone --no-local`, `ls-remote` or lazy fetch from a local path now runs `uploadpack.packObjectsHook` as the upload-pack git's local transport spawns does: taken from the system and global config files only (connect.c's `local_repo_env` clears the command line's config, and the repository's own config never counts), run through the host's hook runner in the remote's git directory with the argv and stdin a served repository's hook gets. `packObjectsHookOf(hooks, { commandLine: false })` leaves out command-line entries, and `RemoteSessionOptions.localHooks` gives the in-process upload-pack the remote's hook session (statewalker/webrun-vcs#387).
