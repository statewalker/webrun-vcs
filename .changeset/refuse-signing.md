---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-transport": minor
---

Requests to sign are refused as native git refuses them when gpg cannot sign, since nothing signs objects yet. Before this, `TagCommand.setSigned(true)` wrote an unsigned annotated tag without a word, and `commit.gpgSign`, `tag.gpgSign` and `push.gpgSign` were ignored.

A commit, merge, cherry-pick, revert, rebase or am that would sign a commit (`setSign(true)`, `setSigningKey(key)` or `commit.gpgSign=true`) now fails with git's lines (`error: gpg failed to sign the data:`, `(no gpg output)`, `fatal: failed to write commit object`, or the sequencer's variant) and git's exit status, at the point where git signs: no commit is made and no ref moves. A fast-forward signs nothing. The new error class is `SigningFailedError`, and `setSign(false)` is `--no-gpg-sign`.

`git.tag()` with `setSigned(true)`, `setSigningKey(key)`, `tag.gpgSign` or `tag.forceSignAnnotated` fails with `error: unable to sign the tag` (exit 128), and writes no tag object or ref. `setSigned(false)` is `--no-sign`.

`git.push()` takes `setSigned(true | false | "if-asked")` and reads `push.gpgSign`. A server without `push-cert` refuses a signed push with `fatal: the receiving end does not support --signed push`. An `if-asked` push to such a server goes ahead unsigned, with git's warning in `PushResult.warnings`. A server that takes certificates fails with `fatal: failed to sign the push certificate`, and nothing is sent. In vcs-transport, `PushClientOptions.signed`, `PushClientResult.warnings` and `PushCertificateError` carry these.
