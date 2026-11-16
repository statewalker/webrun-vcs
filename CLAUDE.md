# Claude Code Project Guidelines

## Project Overview

**webrun-vcs** is a pure-TypeScript Git implementation (read/write) organized as a pnpm monorepo.

Key packages: `vcs-core` (objects, refs, packfiles), `vcs-working-tree` (index, checkout, worktree), `vcs-commands` (porcelain API), `vcs-transport` (fetch/push protocols), `vcs-transport-lfs`/`vcs-transport-xet` (large objects), `vcs-store-*` (storage backends), `vcs-workspace` (file sync plus versioning).

Tech stack: TypeScript, Node.js 24, pnpm 10 workspaces (via corepack), Vitest (testing), Biome 2 (lint + format), Rolldown (bundling). Internal dependencies use `workspace:^`; external ones use the pnpm catalog (`catalog:`) in `pnpm-workspace.yaml`.

## General Behavior

Do not over-analyze or over-explore before acting. When the task is clear, start implementation immediately. Ask for clarification only when genuinely ambiguous.

## File Operations

When creating notes or documents, always confirm the target directory/path with the user before writing. Never assume the output location.

## Conventions

### Naming
All files and folders use **kebab-case**: `my-component.ts`, `utils/date-formatter.ts`

**[Full Guide](.claude/code/naming-conventions.md)**

### Portable APIs only
Library and app code (`packages/*/src`, `apps/*/*/src`) uses only APIs that exist in browsers and on servers: files through `FilesApi`, Web Streams, Web Crypto, `fetch`. No `node:*` imports (Biome `noNodejsModules` is an error there); tests may use Node (to drive native git, for example). On Node, get a `FilesApi` from `createNodeFilesApi` (`@statewalker/vcs-utils-node/files`). Every file operation goes through the `FilesApi`, symlinks included (`lstat`/`readlink`/`symlink` in its `PosixFilesApi` contract), so a composite or simulated FilesApi (`createSymlinkFilesApi`, `createMountedFilesApi`) works everywhere. The one exception to the no-`node:*` rule is the Node FilesApi itself in `packages/vcs-utils-node/src/files` (`posix-node-files-api.ts`, `replace-file.ts`; `git-host-environment.ts` uses `node:os` only and reads files through a FilesApi). The Biome override in `biome.json` lists exactly these files, so any other `node:fs` use fails lint.

### Module Structure
Folder-based exports with wildcard re-exports. Import from `index.js`, use `.js` extensions.

```typescript
// ✅ import { foo } from "../delta/index.js";
// ❌ import { foo } from "../delta/specific-file.js";
```

**[Full Guide](.claude/code/module-structure.md)**

### Documentation Style
Write for humans using narrative prose. Show examples before explanations.

**[Full Guide](.claude/documentation/writing-style.md)**

## Code Quality / Post-Edit Checks

After any refactoring or multi-file edit, run `tsc --noEmit` and fix ALL TypeScript errors (unused imports, type mismatches, missing extends) before reporting completion.

## Testing

When editing existing test files, NEVER overwrite/replace the entire file. Always append or surgically insert new tests alongside existing ones.

## Task Execution

When working from checklist/epic documents, complete ALL items listed — do not skip or forget items. Before reporting done, re-read the checklist and verify every item is addressed.

### Plan Mode
For multi-file features or architectural changes, start in plan mode. Iterate on the plan before switching to execution. Return to plan mode if implementation diverges significantly.

### Subagents
Use subagents for parallel independent subtasks (e.g., researching multiple packages simultaneously, running tests while editing). Keep the main context focused on the primary task.

## Documentation / Notes

When the user asks for structural consistency or formatting conformity in documents, apply it uniformly without arguing — even if some sections seem like they don't need it.

## References

### Source Analysis
Reference implementations (JGit, Fossil) for analyzing patterns and algorithms.

**[Full Guide](.claude/sources.md)**

## Workflows

### Notes
Exploration notes: `notes/src/YYYY-MM-DD/CC-[project]-subject.md`

**[Full Guide](.claude/workflows/note-organization.md)**

### Planning
Approved plans, specs and decision records are not kept in this repo. They live in the
notes archive, in the project folder `$NOTES_DIR/docs/repositories-and-workspace/vcs-refactor/`
(`plans/YYYY-MM-DD-<slug>.md`, `adr/YYYY-MM-DD-<slug>.md`); see `$NOTES_DIR/docs/CLAUDE.md`.

### Pull Requests
Branch from `main`, use descriptive branch names (`feat/X`, `fix/Y`). PR titles under 70 chars. Include a test plan in the description.

### Session Protocol
Before ending any session:

```bash
pnpm test && pnpm lint:fix && pnpm format:fix  # Quality gates
git add . && git commit -m "..."               # Commit
git push                                        # MANDATORY
```

**[Full Guide](.claude/workflows/session-protocol.md)**

## Common Pitfalls

- **Import extensions**: Always use `.js` in imports, never `.ts` or extensionless
- **`git-cli-sandbox`**: `apps/demos/git-cli-sandbox/` is stale — ignore its test failures
- **`split()` limit**: `"a b".split(" ", 2)` gives `["a","b"]` not `["a","b c"]` — use `indexOf` + `slice`
- **Refs vs Checkout**: `CommitCommand` uses `history.refs`, not `checkout.head`
- **Apps are built without type checking**: vite builds `apps/*` even when they use removed APIs. After changing a package API, run `pnpm -r typecheck` (it covers the apps) and grep `apps/` for the old names.
- **Workspace cycles**: `vcs-core` depends on `vcs-utils-node`, and `vcs-testing` on `vcs-core`, so `vcs-utils`/`vcs-utils-node` must not depend on `vcs-testing` (not even as a devDependency): pnpm then builds in the wrong order and CI fails on missing declarations. Put such tests in a store package.
- **`toEqual` on large byte arrays**: Vitest `toEqual` on `Uint8Array`s of hundreds of KB or more takes seconds and has caused CI timeouts; compare the bytes directly (length plus a loop, or `Buffer.equals` in tests)
- **Native git in tests**: CI has no `user.name`/`user.email`; pass `GIT_AUTHOR_*`/`GIT_COMMITTER_*` in the env of every git call, and fix both `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` when two repositories must produce the same commit ids
- **git versions differ**: CI runs a newer git (2.5x) than the sandbox (2.43); oracle tests that compare bytes with native git must pin config that changed defaults (e.g. `transfer.advertiseObjectInfo`) or normalise version-dependent lines
- **Background maintenance in native git**: git 2.5x runs `git maintenance run --auto --detach` after `commit` and similar commands; the detached process changes `.git/objects` while a test copies or reads the repository (CI fails with ENOENT). Set `maintenance.auto=false` and `gc.auto=0` (e.g. `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, as `nativeGitEnv` in vcs-commands tests does)
- **Merge-family twins**: `merge`/`cherry-pick`/`revert`/`rebase`/`pull` native tests build both twins with `buildHistory` (`tests/merge-native-scenarios.ts`) and compare `snapshot(..., normalizeState)` (`tests/merge-native-helpers.ts`); `normalizeState` evens out what 2.43 and 2.5x write differently in `rebase-merge/` (todo `# ` subjects, `message`). A refused `git merge` runs `restore_state` (reset --hard + `stash apply --index`), which leaves AUTO_MERGE and rewrites dirty files through smudge
- **Gitea oracle**: `GITEA=1 pnpm --filter @statewalker/vcs-testing-gitea test` runs a real Gitea (test infra; Node APIs allowed in that package via a biome override)
- **Funcname patterns**: `diff.<driver>.xfuncname`/`funcname` and the builtin driver patterns are POSIX regexes; run them through `compilePosixRegex` (vcs-utils `regex/`), never a JavaScript `RegExp` (different semantics, catastrophic backtracking)

## Self-Maintenance

When you discover an undocumented convention, encounter a repeated mistake, or learn a project-specific gotcha during a session, **propose an update to CLAUDE.md** (or the relevant `.claude/*` file). This keeps guidance current and prevents the same mistakes across sessions.

Trigger examples:
- You get corrected on a pattern — add it to the relevant conventions section
- A build/test fails due to an undocumented requirement — document it
- You discover a stale reference or outdated instruction — fix it

## Project-Specific Tools

For Jira URLs, use the format: `https://<domain>/browse/<ISSUE-KEY>`
