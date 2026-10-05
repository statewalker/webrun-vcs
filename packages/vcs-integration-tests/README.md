# @statewalker/vcs-integration-tests

Cross-package tests for the VCS packages. Each suite runs a realistic scenario end to end through `@statewalker/vcs-commands`, `@statewalker/vcs-core`, `@statewalker/vcs-working-tree`, the stores and `@statewalker/vcs-transport`, and checks that the pieces compose and that repositories stay readable by native Git. Private, test-only, not published; it has no `src/`.

## Layout

```
tests/
  quick-start, object-model, branching-merging,       one suite per scenario of the
  history-operations, staging-checkout,               apps/examples tutorials
  internal-storage, porcelain-commands .test.ts
  transport-replication.test.ts                       replication over a MessagePort
  backend-factories.ts                                storage matrix: Memory and SQL (sql.js)
  test-helper.ts, helpers/                            shared fixtures (mock worktree, simple history)
  transport/
    e2e/        clone, bidirectional sync, conflict resolution
    fetch/, push/   fetch and push over MessagePort
    http/       smart-HTTP fetch and push; native-git/ against real git
    protocol/   capability and protocol v2 negotiation
    helpers/    test repositories and adapters
```

## How to run it

From the repository root:

```bash
pnpm install
pnpm --filter @statewalker/vcs-integration-tests test         # vitest run, ~10 s, 19 files
pnpm --filter @statewalker/vcs-integration-tests test:watch   # vitest in watch mode
```

No build step is needed: `vitest.config.ts` aliases the `@statewalker/vcs-*` imports to each package's `src/`.

## Why it is a separate package

Each VCS package tests itself in isolation. The bugs that matter for users sit at the seams: a commit written by one store and read through the transport, a pack produced by the server side and imported by a client, an index that native Git must accept. Those tests need almost every package at once, so they live in a package that depends on all of them as dev dependencies and on nothing at runtime. The scenario suites mirror the `apps/examples` tutorials, so a broken tutorial path fails here first.

Scenario suites run once per backend in `backends` (`tests/backend-factories.ts`: Memory and SQL), which is how backend-specific behavior shows up.

## What will surprise you

- `tests/transport/http/native-git/native-git-server.test.ts` needs `git-http-backend` (found via `git --exec-path`). When it is missing, the whole suite is skipped (`describe.skip`), and the run still passes.
- `native-git-client.test.ts` drives the `git` command line against an in-process VCS HTTP server, so it needs `git` on `PATH`.
- Vitest's test timeout is 30 s (`vitest.config.ts`); the HTTP and native-git suites are the slow ones.

## Reference

| Script | Command |
|--------|---------|
| `test` | `vitest run` |
| `test:watch` | `vitest` |
| `lint` | `biome lint tests` |
| `typecheck` | `tsc --noEmit` |
