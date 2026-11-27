---
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

`GitResolutionStore` no longer writes `rr-cache/` entries of its own format, which native git read as rerere records (statewalker/webrun-vcs#359). It records and replays through a `RerereEngine` (new in `@statewalker/vcs-working-tree/transformation`), which vcs-commands gives as `rerereEngineOf` or `git.rerere().engine()`. Its records are git's own, byte for byte. Without an engine the store records and replays nothing. Pass the engine as the store's seventh constructor argument, the sixth of `createResolutionStore`, or `TransformationStoreConfig.rerere`.
