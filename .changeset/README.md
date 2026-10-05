# Changesets

This folder holds pending [Changesets](https://github.com/changesets/changesets) for the public
`@statewalker/vcs-*` packages.

Changesets are optional for contributors. After CI passes on `main`, a CI job writes a patch
changeset for every public package whose packed contents differ from npm, opens a
`chore: version packages` pull request, and publishes when that pull request is merged.

Add your own changeset when you want to choose the bump type or the changelog text:

```bash
pnpm changeset
```

Commit the generated markdown file with your change. See [docs/releasing.md](../docs/releasing.md)
for bump guidelines and the list of published packages.
