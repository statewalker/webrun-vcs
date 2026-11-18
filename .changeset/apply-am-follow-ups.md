---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-store-files": patch
---

**`git am --abort` keeps staged work, and more of `apply`, `am` and `format-patch` as git.**

- `git am --abort` cleans the index as git's `clean_index` does. Only conflicted entries go back to HEAD; staged changes and staged deletions stay as they are. The index then moves to ORIG_HEAD with git's up-to-date and untracked checks, so a staged change with unstaged edits on top fails with "Entry 'a.txt' not uptodate. Cannot merge." and "failed to clean index" instead of losing the edits.
- `git am -3` builds a pure rename's fake ancestor with a regular file's mode (`create_ce_mode`), so only the paths that really differ are listed.
- `git am` converts mails to `i18n.commitEncoding` ("cannot convert from koi8-r to ISO-8859-1" where they do not fit) and writes the `encoding` header into the commit. Reflog subjects keep their bytes.
- Charsets convert as strictly as glibc's iconv: bytes windows-125x leaves undefined, and bytes outside the GB2312, Shift_JIS and Big5 ranges, fail to convert.
- `git am` refuses a single StGit series with git's "could not open '<dir>/<patch>' for reading" message. A vertical tab or form feed does not make a mailbox blank.
- `git apply --whitespace=fix` keeps the bytes of postimage lines cut at the end of a file, as git 2.5x does. Deleting a path below a regular file reports "Not a directory".
- `git format-patch` writes the cover letter's shortlog in the log output encoding, and reads `format.from` as a boolean or an ident (`git_parse_maybe_bool`).
