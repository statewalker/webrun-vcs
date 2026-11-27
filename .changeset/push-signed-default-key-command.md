---
"@statewalker/vcs-commands": patch
---

`push --signed` with `gpg.format=ssh` and no `user.signingKey` now takes the pusher from `gpg.ssh.defaultKeyCommand` as git's `get_signing_key_id` does: the command is run through the hook runner in the worktree top and the pusher is the fingerprint of the first key it prints (a command that gives no key prints git's warning and fails with git's crash status, 139). A relative `user.signingKey` is read from the worktree top, `~/` is not expanded (git passes the key to `ssh-keygen -lf` as configured, and dies `failed to get the ssh fingerprint for key '~/...': Success`), and under 2.43 compatibility the pusher keeps the space git 2.43 to 2.51 leave after the fingerprint. `signingKeyIdOf` takes `SigningKeyIdOptions` (`host`, `compatibility`). (#415)
