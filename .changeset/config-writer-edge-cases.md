---
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
---

`GitWorkingCopyConfig.save()` writes `git config`'s bytes in more edit cases: a section whose header line carries its only variable (`[a] x = 1`) goes when that variable is unset, a line holding several headers (`[a][b]`) keeps the headers whose sections stay, new lines go after the section's last variable (not after a trailing comment), `add` appends a value of an existing key at its section's end, and the new `editValues` edits a key's values in place as git's value-pattern edits do. `git remote set-url` (replace, `--add`, `--delete`) now writes the same configuration bytes as git. Values read the same as before; no stored format changes.
