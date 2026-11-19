# Test records

Each file here is named after a workspace package (`.tested/packages/service-http`) and holds the
hash of that package's inputs the last time its tests passed in CI. `scripts/tested.mjs` tests a
package only when its current hash differs:

```sh
pnpm test:status    # which packages need testing, and why (changed / new / tested)
pnpm test:changed   # test them; local passes are cached in node_modules/.cache/tested
pnpm test           # everything, as before
```

The hash covers the package's files (git blob ids; `ignore` names left out), the external
packages it resolves to in `pnpm-lock.yaml` with their whole dependency closure, the same for
every workspace package it reaches, and the global inputs of `config.json` (root files, root
dependencies, the config itself and the script). Uncommitted changes count locally; CI hashes
the commit.

Only CI writes these files: the `tested-record` job of `.github/workflows/ci.yml` commits them
to the pull request's branch after a green run. Do not edit them by hand. On a merge conflict,
take either side: a record that no longer matches only makes the package test again.

`config.json`:

- `globalFiles`: root files every package depends on
- `globalDeps`: root devDependencies every package depends on (their locked closure)
- `ignore`: file names left out of package hashes
- `commands`: a test command per package directory or name, instead of `pnpm run test`
- `links`: workspace package directories a package's tests use without declaring them
  (through a vitest alias to their sources, for example), per package directory or name
- `skip`: packages never tested here
