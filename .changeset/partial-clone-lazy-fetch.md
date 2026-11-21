---
"@statewalker/vcs-core": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils-node": minor
---

**Partial clones fetch absent objects lazily, as git does; gc, repack and fsck handle promisor objects.**

- **vcs-core:** `GitObjects.promisor` (`ObjectPromisor`, `createObjectPromisor`, `withLazyFetch`): a read (`get`, `getNow`, `getRaw`) of an absent object asks the installed `PromisorFetcher` once and reads again; `has` never fetches. `prefetch(ids)` fetches the absent ones in one batch, `withoutLazyFetch(body)` is git's `fetch_if_missing = 0`, `isPromisorObject` / `promisedObjects` / `promisorPackObjects` follow packfile.c's `is_promisor_object`. A promisor remote that cannot send an object it promised throws `PromisorFetchError` (`could not fetch <id> from promisor remote`). `Blobs.prefetch` and `Blobs.mayFetch` let checkouts plan absent blobs and fetch them in one batch. `listObjects({ excludeObjects })` is `--exclude-promisor-objects`.
- **vcs-transport:** `fetchPromisedObjects` is the lazy fetch git runs (`fetch --filter=blob:none --stdin` with the noop negotiator, no ref listing, no tags or refs written, a kept promisor pack); `FetchClientOptions.refetch` (`git fetch --refetch`); a deepening fetch under a filter checks connectivity as a partial clone's.
- **vcs-store-files:** the files backend wraps its objects with the promisor (promisor packs known by their `.promisor` files). `gc()` and `repack()` run in a partial clone as git's: the promisor objects stay out of the walk and `repack -a` writes every object of the promisor packs into a promisor pack of its own with an empty `.promisor` file (`repack_promisor_objects`). `RepackOptions.filter` is `git repack --filter=<spec>` (the filtered-out objects in a pack beside the new one). `promisorExclusions`.
- **vcs-commands:** every command installs a `PromisorFetcher` (`createPromisorFetcher`, `installPromisorFetcher`) that fetches from the promisor remotes in git's order (`promisorRemotes`: `remote.<name>.promisor`, `.partialclonefilter`, `extensions.partialClone` last), honouring `GIT_NO_LAZY_FETCH` (git 2.45+: "lazy fetching disabled; some objects may not be available"). Checkout, switch, reset, clone and the other unpack-trees writers prefetch the blobs they write in one batch (`check_updates`), diff prefetches its pairs for patch and stat outputs (`diff_queued_diff_prefetch`) and rename detection its candidates (`basename_prefetch`, `inexact_prefetch`), merge-ort the blobs of its content merges, so `log -p`, status and merges fetch as often as git. `FetchCommand.setFilter` (`--filter`, `--no-filter`, partial_clone_register) and `setRefetch`; a fetch from a promisor remote uses its `partialclonefilter`. Fetch, clone, fsck, gc and repack walk with lazy fetching off. `FsckCommand` treats promisor objects as git's fsck does (reachable without being walked, never missing).
- **vcs-working-tree / vcs-utils-node:** `GitHostEnvironment.noLazyFetch` (`GIT_NO_LAZY_FETCH`).
