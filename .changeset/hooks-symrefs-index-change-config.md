---
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-utils-node": patch
"@statewalker/vcs-transport": patch
"@statewalker/vcs-commands": patch
---

Hooks closer to git 2.5x: the reference-transaction hook hears symbolic-ref writes
(`<zero> ref:<target> <ref>`: checkout, switch, `rebase --abort`, `remote set-head`), the old
values git passes for HEAD and ORIG_HEAD in merge, am and rebase (with rebase's
CHERRY_PICK_HEAD, REBASE_HEAD and AUTO_MERGE transactions), and pushes served through
`serveGitConnection` (`servedRepositoryOf(..., { hooks })`); post-index-change runs after index
writes (`<updated-workdir> <updated-skipworktree>`); configured hooks (`hook.<name>.event` /
`.command` / `.enabled`) run before the hooks directory's script; `gc().setAuto(true)` decides
as `git gc --auto` and asks pre-auto-gc first. packed-refs is written as git writes it: the
`peeled fully-peeled sorted` header and a peel line for each annotated tag.
