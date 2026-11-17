---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": minor
---

**Identities and dates closer to native git.**

- **vcs-commands:** a fallback identity (a command's other, explicitly given identity) now gives only a name and an email, never a date. An amend or a concluded cherry-pick with nobody configured, `setAuthorIdent` with an old date, `GIT_AUTHOR_DATE` without a committer identity, and a merge with `setAuthor` all date the committer now (or by `GIT_COMMITTER_DATE`), as git does. The fallback fills only the field git would guess: with only `$EMAIL` set, the name is the fallback's and the email is `$EMAIL`.
  - Any `user.email`, `author.email` or `committer.email` key, even empty or for the other role, stops git's `$EMAIL` lookup and gives an empty email (`<>`). Likewise for `*.name`. An empty `GIT_*_NAME` / `GIT_*_EMAIL` counts as given.
  - Commits and tags refuse an empty name (`fatal: empty ident name (for <email>) not allowed`, after git's hint when the name came from `user.name`) and a name of crud only (`fatal: name consists only of disallowed characters: <name>`), with the new `InvalidIdentError`, in git's order. Reflog lines are not strict.
  - `parseGitDate` is a port of git's `parse_date`. It refuses small bare epochs, dates outside 1970..2099 and 2-digit years from 10 to 69. It ignores invalid offsets (`+0160` without `@`) and normalises them after `@`. It skips unknown words. It reads `14/11/2023`, `1 1 2023 10:00`, `20231114T231320`, `+01:00:00` and out-of-range fields as git does. Local times resolve as glibc's `mktime`.
  - Each rebase pick, and each commit of a cherry-pick or revert range, reads the clock again (git's `reset_ident_date`), so picks and their reflog lines carry their own times.
  - `setAuthor`, `setCommitter`, `setTagger` and the `--author` of an amend strip crud from the name and email, as git does.
- **vcs-store-files:** `GitStashStore` takes its author and committer from the new `identity` option, asked at each push. The default is now `webrun-vcs <vcs@localhost>` in the local offset (was `Git Stash <stash@localhost> +0000`), and the reflog line carries the committer.
