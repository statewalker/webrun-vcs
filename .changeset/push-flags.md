---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-transport": minor
---

`git push -u`/`--set-upstream` (`PushCommand.setSetUpstream`, through `branch-tracking.ts`'s
`installTracking`, git's `branch 'x' set up to track 'origin/x'.` in
`PushResult.upstreamMessages`), `--follow-tags` and `push.followTags` (`setFollowTags`;
`PushClientOptions.followTags`, remote.c's `add_missing_tags`), and `--force-if-includes` and
`push.useForceIfIncludes` (`setForceIfIncludes`; `PushClientOptions.includesRemote`, the
`rejected-remote-updated` status, "remote ref updated since checkout"). Native twins for
`--force`, `+refspec` and every `--force-with-lease` form (t5523, t5516, t5533).
