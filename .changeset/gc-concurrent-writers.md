---
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-utils-node": patch
---

gc takes its lock as `git gc` does (`lock_repo_for_gc`): `gc.pid` holds `<pid> <host>` and is written through `gc.pid.lock`. A young lock of another host or of a running process is held, while a dead process's lock, an unreadable one or one older than 12 hours is taken over. `git.gc()` now refuses with git's messages ("gc is already running on machine '<host>' pid <pid> (use --force if not)", or "Unable to create '.../gc.pid.lock': File exists"), and `setForce(true)` is `git gc --force`. Native git and ours now see each other's gc. `GitHostEnvironment.gcProcess` gives the pid, the host name and a process check; `createNodeGitHostEnvironment` fills it.

gc keeps what concurrent writers need:

- the prune checks each expired loose object's mtime again right before unlinking it, so a write that freshened it meanwhile keeps it (also `FileGcStrategy.prune`);
- the repack checks each old pack's mtime again right before removing it, so a pack freshened since the listing stays;
- the prune walks the refs again when they moved during the gc, as git's separate prune process does.
