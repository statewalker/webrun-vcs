---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-working-tree": minor
---

**Local push respects every worktree and the target's config; clone refuses a non-empty destination.**

- A push to a local repository refuses to update or delete a branch checked out in any worktree of the target, linked ones included, as git's `find_shared_symref` does (a worktree that is rebasing or bisecting a branch counts too). receive-pack takes these branches as `checkedOutBranches` (`serveOverDuplex` and the smart-HTTP server's `receivePack` options), so a server for a repository on disk can apply the same rule.
- Local receive-pack and upload-pack read the target's configuration, as git's do: `receive.denyNonFastForwards` (unset, forced updates are accepted, as in git), `receive.denyDeletes`, `receive.denyCurrentBranch` (`refuse`/`true`, `false`/`ignore`, `warn`, `updateInstead`; unset, refused with git's advice), `receive.denyDeleteCurrent`, `receive.shallowUpdate`, and `transfer.hideRefs` with `uploadpack.hideRefs` or `receive.hideRefs` for fetch, ls-remote and push. `serverSettingsFromConfig` (vcs-transport) is that mapping, and `httpServerSettings` shapes it for the HTTP server. `ReceiveDenyAction` widens `denyCurrentBranch` and `denyDeleteCurrent`.
- `receive.denyCurrentBranch=updateInstead` updates a clean worktree to the pushed commit (git's `push_to_deploy`, through `ReceivePackConfig.updateWorktree`) and refuses one with unstaged or staged changes in git's words. The push-to-checkout hook is not run.
- A repository facade made by `createRepositoryFacade` records accepted shallow pushes (`updateShallow`) when its refs keep a shallow list.
- `clone` refuses a destination that has refs, index entries or worktree files, or that the local source resolves to, with git's "destination path '<dir>' already exists and is not an empty directory." (exit 128), before anything is written, over smart HTTP too. `setDirectory` names the directory in that message.
- A clone of an empty repository with `--single-branch` writes no fetch refspec, and `--branch` on it fails with git's "fatal: Remote branch <b> not found in upstream <remote>". A clone of a corrupt local source fails with git's "aborting due to possible repository corruption on the remote side" lines (exit 128). A fetch of a ref the remote does not have (a hidden one included) fails with "fatal: couldn't find remote ref <ref>".
- `Worktree.openRepository` opens a linked worktree (a gitfile into a `commondir`) as a remote, with that worktree's own HEAD; a linked worktree's git directory is not bare. `OpenedRepository` carries `commonDir`, `config` and `worktrees`.
- `rebase().setUpstream("")` fails with "fatal: invalid upstream ''".
- An uppercase full object id names its object: `tag().setObjectId()` (which also takes any revision), `commit().setParentIds()` and the other setters taking ids store it lowercase, and `setHead` takes it as a commit. Loose refs, packed refs and nested HEADs holding an uppercase id read as git reads them (lowercased), so `branch -m`, `commit` and `pack-refs --all` work on such repositories.
