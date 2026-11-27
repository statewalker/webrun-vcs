---
"@statewalker/vcs-core": patch
"@statewalker/vcs-transport": patch
---

The published tarballs no longer ship test code: vcs-core left out `src/__tests__/` (fixtures, setup and test utilities) and vcs-transport `src/tests/unit/*.test.ts`. Every published package's `files` now excludes test directories and `*.test.*`/`*.spec.*` files, and `scripts/check-pack-contents.mjs` (run by `lint:check`) fails a package whose `pnpm pack` would ship them or miss a file its manifest names (#342).
