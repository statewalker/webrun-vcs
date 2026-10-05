# Multi-Platform Publishing Guide

## npm

All public `@statewalker/vcs-*` packages are published to npm from CI with
[Changesets](https://github.com/changesets/changesets) and npm provenance. See
[releasing.md](releasing.md) for the flow.

Each package ships built ESM and `.d.ts` files in `dist/` (what `exports` points at) and its
TypeScript sources in `src/`.

### Installing from npm

```bash
pnpm add @statewalker/vcs-core
```

```typescript
import { createMemoryHistory } from "@statewalker/vcs-core";

const history = createMemoryHistory();
await history.initialize();
```

## Deno

Deno can use the npm packages directly:

```typescript
import { createMemoryHistory } from "npm:@statewalker/vcs-core@^0.3";
```

`@statewalker/vcs-utils-node` uses Node.js APIs (`node:zlib`, and the Node file adapter from `@statewalker/webrun-files-node`) and is meant for Node.js
only.

### JSR

Eight packages (`commands`, `core`, `store-kv`, `store-mem`, `store-sql`, `transport`,
`transport-adapters`, `utils`) contain a `jsr.json`. These files are not kept in sync with
`package.json`: they declare version `0.1.0` and some subpaths that do not exist. Nothing
publishes to JSR from this repository.

## CDNs (JSPM, esm.sh)

Packages published to npm are available from npm-backed CDNs without extra steps.

### Import map (JSPM)

```html
<script type="importmap">
{
  "imports": {
    "@statewalker/vcs-core": "https://ga.jspm.io/npm:@statewalker/vcs-core@0.3.2/dist/index.js"
  }
}
</script>
<script type="module">
  import { createMemoryHistory } from "@statewalker/vcs-core";
</script>
```

JSPM resolves the package's own dependencies when you generate the map with its generator:

```bash
npx jspm install @statewalker/vcs-core
```

### esm.sh

```html
<script type="module">
  import { createMemoryHistory } from "https://esm.sh/@statewalker/vcs-core@0.3";
</script>
```

## Package Overview

| Package | Description | Platforms |
|---------|-------------|-----------|
| `@statewalker/vcs-core` | Git object model, refs, packs, history | npm, CDN |
| `@statewalker/vcs-utils` | Hashing, compression, diff, streams | npm, CDN |
| `@statewalker/vcs-utils-node` | Node.js compression and file adapters | npm (Node.js only) |
| `@statewalker/vcs-working-tree` | Index, checkout, worktree, status | npm, CDN |
| `@statewalker/vcs-commands` | High-level Git operations | npm, CDN |
| `@statewalker/vcs-transport` | Git protocols (fetch, push, clone) | npm, CDN |
| `@statewalker/vcs-transport-adapters` | Core to transport adapters | npm, CDN |
| `@statewalker/vcs-transport-lfs` | Git LFS batch protocol, basic transfer | npm, CDN |
| `@statewalker/vcs-transport-xet` | Git LFS xet chunk transfer | npm, CDN |
| `@statewalker/vcs-store-files` | File-backed storage backend | npm, CDN |
| `@statewalker/vcs-store-mem` | In-memory storage backend | npm, CDN |
| `@statewalker/vcs-store-kv` | Key-value storage backend | npm, CDN |
| `@statewalker/vcs-store-sql` | SQL storage backend (peer: `sql.js`) | npm, CDN |
| `@statewalker/vcs-workspace` | File sync and versioning orchestration | npm, CDN |
