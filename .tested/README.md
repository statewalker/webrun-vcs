# Test records

Each file here is named after a workspace package (`.tested/packages/service-http`) and holds the
hashes of that package's inputs from its last passing CI runs, newest first. `scripts/tested.mjs`
tests a package only when its current hash is not among them:

```sh
pnpm test:status    # which packages need testing, and why (changed / new / tested)
pnpm test:changed   # test them; local passes are cached in node_modules/.cache/tested
pnpm test           # everything, as before
```

The hash covers:

- the package's files (git blob ids; `ignore` names left out), uncommitted changes included
  locally (CI hashes the commit);
- the external packages it resolves to in `pnpm-lock.yaml` with their whole dependency closure,
  and the files of `link:` / `file:` targets that are no workspace package;
- the same for every workspace package it reaches: its dependencies (dev ones included), the
  packages its `vitest.config.*` / `vite.config.*` names by relative path (aliases to their
  sources), the `links` of `config.json`; and their runtime dependencies in turn;
- global inputs: the pnpm settings of `pnpm-workspace.yaml` (not its packages or catalogs: the
  lockfile carries what the catalogs resolve to), the root `package.json`'s `packageManager`,
  `engines` and `pnpm`, and what `config.json` lists.

The `runtime` versions are part of the hash, so local runs match CI's records only on the same
Node major version (and git version, where listed). A change to how the script hashes changes
the hashes by itself; a change to how it runs the tests retests nothing.

Only CI writes these files: the `tested-record` job of `.github/workflows/ci.yml` commits them
to the pull request's branch, and CI fails a pull request from a fork that changes them. Do not
edit them by hand. Two branches recording the same package merge line by line
(`.gitattributes`: `merge=union`), so both passes stay valid; the next write keeps the newest
four. CI's weekly scheduled run tests everything (`run --all`), as can a manual run.

`config.json`:

- `globalFiles`: root files every package depends on
- `globalDeps`: root devDependencies every package depends on (their locked closure)
- `runtime`: `node` (major version) and `git` (major.minor) to include in every hash
- `globalEnv`: environment variables whose values every hash includes
- `ignore`: file names left out of package hashes
- `commands`: a test command per package directory or name, instead of `pnpm run test`
- `links`: workspace package directories a package's tests use without declaring them, beyond
  what its vitest/vite config shows, per package directory or name
- `skip`: packages never tested here
