---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils-node": minor
---

Signed commits (statewalker/statewalker-root#288). A host now supplies a signer, `GitHostEnvironment.signer`, and `commit -S` (`setSign`, `setSigningKey`, `commit.gpgSign`) signs through it. The signature goes in the commit's `gpgsig` header, or `gpgsig-sha256` in a SHA-256 repository, byte for byte as git writes it.

- The commands resolve what git's `sign_buffer` would run and pass it to the signer as a `SigningRequest`: the format, the program, the key and the payload. They read `gpg.format`, `gpg.program`, `gpg.<format>.program`, `user.signingKey` (default: the committer's `Name <email>` for openpgp and x509) and `gpg.ssh.defaultKeyCommand`. A bad variable dies as git dies.
- `createNodeSigner` (vcs-utils-node) runs gpg, gpgsm or ssh-keygen as git does, with the same arguments, stdin, `--status-fd=2` and `SIG_CREATED` check, and reports failures with git's messages.
- `createSshSigner` (vcs-commands) signs in-process with an Ed25519 OpenSSH key through Web Crypto. Its signatures are ssh-keygen's byte for byte.

Without a signer, a request to sign is still refused as before. Tags, the merge/pick/rebase/am family and push certificates still refuse; their own tickets will add signing.
