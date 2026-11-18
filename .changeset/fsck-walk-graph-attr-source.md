---
"@statewalker/vcs-core": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils-node": minor
---

**Faster fsck and commit-graph writing; the attribute source (`GIT_ATTR_SOURCE`, `git --attr-source`, `attr.tree`).**

- **vcs-core:** `scanPackObjects` reads a pack once in pack order and unpacks only the objects of the types asked for (a delta takes its base's type, so blobs and their deltas are skipped unread; what it does not handle as it stands is left to the store), with `packEntryOrder` (offsets sorted as numbers, no comparator), `parsePackEntryHead` and `packIdxLookups`. `writeCommitGraphFile` computing many changed-path filters (1024 or more) unpacks the packs' trees that way first and keys them by their id bytes; the tree diff is synchronous while its trees are in memory (no generators), and commits are read without a promise when the store holds them. The files written are unchanged; `reads.treesScanned` counts the trees unpacked beforehand. `VerifyCommitSource` may answer without a promise.
- **vcs-commands:** `fsck` keeps git's object hash with each id in its slot (one place in memory per probe) and every object's slot, so the lookups git makes again move an object without probing; a full run checks each pack with typed arrays in pack order and a FIFO cache of bases carved from slabs; a `--connectivity-only` run unpacks each pack's commits and trees in one read in pack order (`statistics.objectsScanned`) and replays git's lookups on them in git's walk order, a commit-graph's parents and trees are looked up from its bytes, and the commit-graph verification takes the commits from those reads. Output and exit codes are unchanged. Every attribute consumer (checkout and check-in conversion, diff and merge drivers, `log -- :(attr)`) reads the in-tree attributes of the attribute source when one is set, also in a bare repository: `$GIT_ATTR_SOURCE` over `attr.tree`, resolved with git's revision syntax; a bad `$GIT_ATTR_SOURCE` fails with git's `bad --attr-source or GIT_ATTR_SOURCE`, a bad `attr.tree` is ignored, an object that is no tree gives no in-tree attributes.
- **vcs-working-tree:** `GitHostEnvironment.attrSource` (`$GIT_ATTR_SOURCE`); `GitContentFilter` reads in-tree attributes from the source's tree (options `trees`, `resolveAttributesSource`, method `setAttributesSourceResolver`); `attributesSourceSetting`, `resolveAttributesSource`, `readTreeAttributesFile` and `AttributesSourceError`.
- **vcs-utils-node:** `createNodeGitHostEnvironment` reads `GIT_ATTR_SOURCE`.
