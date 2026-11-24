---
"@statewalker/vcs-commands": minor
---

`git format-patch` gets more of its options, with native twins (statewalker/statewalker-root#331).
New on `FormatPatchCommand`: `setAttach` / `setInline` (`--attach[=<boundary>]`,
`--inline[=<boundary>]`, `--no-attach`, and `format.attach`: multipart mails as log-tree.c
writes them, the patch in a `text/x-patch` part after the diffstat, the closing boundary in
place of the signature, the cover letter left plain), `setNotes` (`--notes[=<ref>]`,
`--no-notes`, applied in order after `format.notes`; the notes after the `---` line),
`setCoverFromDescription` (`--cover-from-description=message|subject|auto|none|default` and
`format.coverFromDescription`, from `branch.<name>.description` of the branch git's
`find_branch_name` picks, a bad mode dying as git) and `setIgnoreIfInUpstream`
(`--ignore-if-in-upstream`: patch ids of the upstream side, `need exactly one range` / `not a
range` as git). `--signoff` now reads the `trailer.*` settings (`trailerConfigOf`), and a
committer ident that is not ASCII adds the 8bit MIME headers, as git's `need_8bit_cte`. The
cover letter's subject and `From:` are RFC 2047-encoded from git 2.44 on (`setVersionString`
picks older behaviour). `DiffTextOptions.statSep` is diff.c's `stat_sep`, and `mailSubjectLine`
(log-output) is pretty.c's subject header.
