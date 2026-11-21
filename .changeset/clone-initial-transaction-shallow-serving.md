---
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-transport": patch
"@statewalker/vcs-commands": patch
---

**`git clone` writes its refs in git's initial transaction, and shallow repositories can be served.**

- `CloneCommand` writes the cloned remote-tracking refs, tags and a bare or mirror clone's heads in one initial ref transaction (new `BatchOptions.initial`, `FetchClientOptions.initialTransaction`): the files store puts them straight into packed-refs, under git's header and peel lines, with no loose file and no reflog, and tells the reference-transaction hook as each git version does (2.43: `prepared`, `committed`; 2.5x: `preparing`, `prepared`, then the packed store's `preparing`, `prepared`). The followed tags of a single-branch clone are written loose one by one, then the remote HEAD, HEAD and the branch through HEAD, in git's order. Other stores apply an initial batch as a plain one.
- The files store lists loose and packed refs merged in name order, as git iterates them (`git fetch --prune` reports the refs it deletes in git's order after a clone).
- upload-pack serves a shallow repository as git does: the repository's shallow commits are advertised after its refs (v0), a v2 fetch that deepens nothing gets the shallow commits it reaches, depths and `--unshallow` stop at the repository's own boundary (git's depth-first walk, lines repeated as git repeats them), and every pack is cut there (`withServedShallow`, `prepareServedShallow`).
- The fetch client reads a shallow server's commits (v0 advertisement, v2 `shallow-info`): a clone records them (`FetchClientOptions.cloning`), a fetch rejects each ref whose new history needs one, with git's "rejected … because shallow roots are not allowed to be updated" warning, unless `FetchCommand.setUpdateShallow(true)` (`git fetch --update-shallow`) records them. A local clone of a shallow source fetches through upload-pack, with git's warnings.
