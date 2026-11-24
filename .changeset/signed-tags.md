---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils-node": minor
---

`git tag -s`, `-u <keyid>`, `tag.gpgSign` and `tag.forceSignAnnotated` now sign the tag through
the host's signer (`GitHostEnvironment.signer`), as builtin/tag.c's `do_sign`: the signature is
appended to the tag message, with `gpg.format` (openpgp, x509, ssh), `user.signingKey` and
`gpg.ssh.defaultKeyCommand` resolved as for `commit -S`. A failed signing dies as git (`error:
unable to sign the tag`, `The tag message has been left in .git/TAG_EDITMSG`, exit 128); under 2.43
compatibility a failing ssh-keygen leaves the tag unsigned with its error in `warnings`, as git 2.43
does (`SigningOutcome.exitCode`, set by `createNodeSigner`). Re-editing a signed tag with `-f`
starts from its message without the signature (`write_tag_body`); `signatureStart` is exported
from the ref filter.
