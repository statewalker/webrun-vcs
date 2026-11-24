---
"@statewalker/vcs-commands": minor
---

`git am`'s options get native twins (statewalker/statewalker-root#330). New: `AmCommand.setQuotedCr`
(`--quoted-cr=nowarn|warn|strip`, kept in `rebase-apply/quoted-cr`) and `mailinfo.quotedCr`,
`mailinfo.scissors` read for a session without `--[no-]scissors` (both as git's
`setup_mailinfo`, a bad value dying as git), `AmCommand.addMaildir` (`git am <Maildir>`),
`AmApplyOptions.ignoreSpaceChange`; the 3-way fallback now passes every apply option to its
apply on the fake ancestor and `--include`/`--exclude` to the fake ancestor itself, as git's
`run_apply`/`build_fake_ancestor`. `git mailsplit` is a library call: `splitMail` over contents
and `mailsplitFiles` over a FilesApi (mbox, mboxrd and Maildir input, `-b`, `--keep-cr`,
`-d<prec>`, `-f<n>`, `-o<dir>`, git's output files, count and errors).
