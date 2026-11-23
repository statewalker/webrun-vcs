---
"@statewalker/vcs-commands": minor
---

Trailers engine (git's trailer.c) and `git.interpretTrailers()`: `interpretTrailers`/`processTrailers` add and edit trailers with `--where`, `--if-exists`, `--if-missing`, `--trim-empty`, `--only-trailers`, `--only-input`, `--unfold`, `--parse`, `--no-divider` and the `trailer.*` configuration (`key`, `where`, `ifexists`, `ifmissing`, `cmd`, `command`, `trailer.separators`); trailer commands run through the host's hook runner. `amendWithTrailers` and `validateTrailerArgs` are the `--trailer` of commit, tag, merge, rebase and cherry-pick; `appendSignoff` takes the footer to keep (`ignoredLogMessageBytes`), `signoffLine` builds the line, `trailerLinesOf` is git's trailer iterator.
