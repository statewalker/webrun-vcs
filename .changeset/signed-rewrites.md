---
"@statewalker/vcs-commands": minor
---

Rebase, cherry-pick, revert, merge and am sign the commits they write
(statewalker/statewalker-root#319): `-S[<keyid>]` (`setSign`/`setSigningKey`), `--no-gpg-sign`
(`setSign(false)`, over the configuration) and `commit.gpgSign` now go through the host's signer
(`GitHostEnvironment.signer`) as git's sequencer, `builtin/merge.c` and `builtin/am.c` sign
(`commit_tree` with `gpg_sign`), instead of refusing; without a signer, or when it fails, each
command still fails as git's does when gpg cannot sign, leaving the state git leaves. A rebase's
recreated octopus merge gets `--no-gpg-sign` when the run does not sign, and `merge --continue`
signs only under `commit.gpgSign`, as the plain `git commit` git runs. am signs under a non-UTF-8
`i18n.commitEncoding` too (the signature after the `encoding` header). New:
`RebaseCommand.setForceRebase` (`--force-rebase`/`-f`: every commit picked again, not
remembered by `--continue`). Native twins: `tests/rebase-gpg-sign-native.test.ts`
(t3435-rebase-gpg-sign), `tests/cherry-pick-revert-gpg-native.test.ts`
(t3514-cherry-pick-revert-gpg) and `tests/signed-merge-am-native.test.ts`, in ssh (byte for byte)
and openpgp (verified).
