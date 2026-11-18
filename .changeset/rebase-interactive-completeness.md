---
"@statewalker/vcs-commands": minor
---

**Interactive rebase as git 2.5x runs it.**

```typescript
const result = await git
  .rebase()
  .runInteractively({
    editTodo: (todo) => todo.replace(/^pick (\w+) # two$/m, "edit $1 # two"),
    modifyCommitMessage: (message) => message,
  })
  .setExecHandler((command) => runInShell(command))
  .setUpstream(mainId)
  .call();
// result.status === RebaseStatus.EDIT: "Stopped at <abbrev>...  # two"
```

The interactive handler now plays git's editors: `editTodo` gets the todo list as git's
sequence editor shows it (abbreviated ids, rebase.abbreviateCommands, the help text), and
`modifyCommitMessage` gets what git's message editor would (a reword's message, a squash
chain's `# This is a combination of N commits.` text). The edited list is parsed and checked
as git does (invalid lines, merges where a pick cannot take one, rebase.missingCommitsCheck,
HEAD left at upstream for `--edit-todo`, the new `RebaseOperation.EDIT_TODO`).

All todo commands run as git's sequencer runs them: `edit` stops with git's state
(`stopped-sha`, `amend`, `message`, `author-script`, REBASE_HEAD) and `--continue` amends
staged changes or takes a `commit --amend` made meanwhile; `reword` amends after the pick;
`squash`, `fixup`, `fixup -C`, `fixup -c` assemble the message in `message-squash`,
`message-fixup` and `current-fixups` exactly as git (a failed fixup stops for amending,
`--skip` takes it off the chain); `exec` runs through the injectable `setExecHandler`
(`Executing: <command>`, failures and changes left in the worktree stop the rebase,
`--reschedule-failed-exec` puts the command back); `break`, `drop`, `noop` and
`update-ref` work, with `setUpdateRefs` (rebase.updateRefs) adding the `update-ref` lines,
the `update-refs` state file and the refs moved at the end (branches checked out in other
worktrees left alone).

New options: `setExec` (`--exec`, also with `--rebase-merges`), `setEmpty` (`--empty=
drop|keep|stop`, git 2.5x defaults: stop when interactive, keep with `--exec`, else drop;
picks that become empty stop with git commit's advice), `setKeepEmpty` (`--[no-]keep-empty`),
`setAutosquash` (rebase.autoSquash for interactive rebases; `fixup!`, `amend!`, `squash!`
reordered), `setRescheduleFailedExec` and `setRoot` (`--root`, with or without an upstream
as `--onto`; `reset [new root]` of `--rebase-merges`). Commits are recorded as rewritten
through `rewritten-pending` as git does (fixup chains, the base of skipped picks).

A handler that throws fails as git's editor does: a failing `editTodo` (or `prepareSteps`)
ends the rebase before it starts (state removed, autostash applied), a failing
`modifyCommitMessage` stops at the reword or squash as git commit's failure leaves it. A fixup
or squash whose amend would leave the commit empty stops for amending, as git commit refuses
it. The edited list's abbreviations are read back against the list's own commits, the rest
looked up in the object store together (a prefix several objects share is refused as git
refuses it), so `--edit-todo` and `prepareSteps` no longer read every object per name.
