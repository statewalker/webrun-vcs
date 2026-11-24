---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils-node": minor
---

Signature verification (statewalker/statewalker-root#318): `GitHostEnvironment.verifier`
beside the signer, `createNodeVerifier` (runs gpg, gpgsm or ssh-keygen as git's
gpg-interface.c does) and `createSshVerifier` (Ed25519 in-process, honouring
`gpg.ssh.allowedSignersFile` validity dates and `gpg.ssh.revocationFile`). New commands
`git.verifyCommit()` and `git.verifyTag()` (`-v`, `--raw`); every `%G` placeholder checks the
signature; `log --show-signature` / `log.showSignature` (mergetags too); `merge` and `pull`
take `setVerifySignatures` (`merge.verifySignatures`) and refuse with git's messages.
