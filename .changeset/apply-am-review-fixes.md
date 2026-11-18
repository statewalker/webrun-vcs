---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-working-tree": patch
---

**`git apply`, `git am` and `git format-patch` closer to git.**

- `git apply` refuses an index that would hold a path as both a file and a directory ("'a.txt/x' appears as both a file and as a directory"). It reads the old file keeping CRLF when the patch context has CRLF, and renormalises it otherwise. It applies submodule patches as git does: a directory stages as a gitlink, checking a gitlink out makes its empty directory, and removing one removes that directory when empty. Errors and warnings go through git's `vreportf` (control characters shown as `?`, cut at 4096 bytes). Bad binary hunks report zlib's and base85's errors. A repeated `--whitespace` keeps `error-all`'s full count. `--cached --reject` writes `.rej` files. Write errors use the system's wording. Many hunks apply in linear time: 10,000 hunks on a 200,000-line file take about 0.4 s, against 5 s for native git.
- `ContentConversionOptions.keepCrlf` skips the line-ending step of a clean conversion (git's `CONV_EOL_KEEP_CRLF`).
- `git am` detects the patch format of a named mailbox (`addMbox(bytes, name)`), and `setPatchFormat` sets it: StGit and Mercurial patches are converted, and "Patch format detection failed." and empty mailboxes fail as in git. Author names and emails lose their crud. `--ignore-date` and mails without a `Date:` use the clock (`setClock`), not `GIT_AUTHOR_DATE`. 8-bit commit text that is not UTF-8 is read as Latin-1, with git's warning. Charsets convert strictly ("cannot convert from X to UTF-8"; ISO-8859-1 is Latin-1). The `--allow-empty` advice shows on `--continue`. `--abort` cleans the index as git does and fails with "failed to clean index".
- `git format-patch` ignores `diff.noprefix` and honours `format.noprefix`. `format.encodeEmailHeaders=false` covers the `From:` name too. Mails are written in `i18n.logOutputEncoding`/`i18n.commitEncoding`, converting to UTF-8 or ISO-8859-1. The cover letter's shortlog is in UTF-8, and with `--from` it takes that ident dated at the epoch, as git 2.54 and later do.
