# Releasing Packages

Public packages in this repository are versioned with [Changesets](https://github.com/changesets/changesets)
and published to npm from CI. Nobody needs to version or publish by hand.

## How a release happens

1. A pull request is merged to `main` and CI passes.
2. A CI job compares each public package's packed contents with the version on npm. For every
   package that differs and has no changeset yet, it writes one: a patch bump, or a minor bump on
   a `0.x` package when one of its dependencies moved past a breaking version.
3. The job opens (or updates) a pull request titled `chore: version packages` with the version
   bumps and `CHANGELOG.md` entries.
4. Merging that pull request publishes the changed packages to npm, with provenance.

Private packages (`@statewalker/vcs-testing`, `@statewalker/vcs-integration-tests`, the docs site
and everything in `apps/`) are never published.

## Choosing the bump or the changelog text yourself

The automatic changeset is a patch with a generic summary. To choose the bump type or write the
changelog entry, add a changeset to your pull request:

```bash
pnpm changeset
```

The prompt asks which packages changed, the bump type for each, and a summary. It writes a
markdown file in `.changeset/`; commit it with your change:

```markdown
---
"@statewalker/vcs-core": minor
"@statewalker/vcs-utils": patch
---

Add streaming support for large blob operations.
```

| Type | When to use |
|------|-------------|
| **patch** | Bug fixes, docs, internal refactoring |
| **minor** | New features; on `0.x` packages, also breaking changes |
| **major** | Breaking changes to the public API of a `1.x`+ package |

One changeset per logical change. The summary becomes the `CHANGELOG.md` entry, so write it for
users of the package.

## Dependency updates

Dependency updates arrive as pull requests from Renovate. They go through the same CI and release
flow as any other change.

## Published packages

| Package | Description |
|---------|-------------|
| `@statewalker/vcs-core` | Git object model, refs, packs, history |
| `@statewalker/vcs-utils` | Hashing, compression, diff, streams |
| `@statewalker/vcs-utils-node` | Node.js compression and file adapters |
| `@statewalker/vcs-working-tree` | Index, checkout, worktree, status |
| `@statewalker/vcs-commands` | High-level Git operations |
| `@statewalker/vcs-transport` | Git protocols (fetch, push, clone) |
| `@statewalker/vcs-transport-adapters` | Core to transport adapters |
| `@statewalker/vcs-transport-lfs` | Git LFS batch protocol, basic transfer |
| `@statewalker/vcs-transport-xet` | Git LFS xet chunk transfer |
| `@statewalker/vcs-store-files` | File-backed storage backend |
| `@statewalker/vcs-store-mem` | In-memory storage backend |
| `@statewalker/vcs-store-kv` | Key-value storage backend |
| `@statewalker/vcs-store-sql` | SQL storage backend |
| `@statewalker/vcs-workspace` | File sync and versioning orchestration |
