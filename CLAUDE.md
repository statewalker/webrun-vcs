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
Approved plans: `planning/YYYY-MM-DD/CC-[project]-subject.md`

**[Full Guide](.claude/workflows/planning-organization.md)**

### Issue Tracking (Beads)
Use `bd` for AI-native issue tracking:

```bash
bd ready                                  # Find available work
bd update <id> --status in_progress       # Claim issue
bd close <id>                             # Complete work
bd create --title="..." --type=task --priority=2
```

**[Full Guide](.claude/workflows/beads-integration.md)**

### Pull Requests
Branch from `main`, use descriptive branch names (`feat/X`, `fix/Y`). PR titles under 70 chars. Include a test plan in the description.

### Session Protocol
Before ending any session:

```bash
pnpm test && pnpm lint:fix && pnpm format:fix  # Quality gates
bd sync                                         # Sync beads
git add . && git commit -m "..."               # Commit
git push                                        # MANDATORY
```

**[Full Guide](.claude/workflows/session-protocol.md)**

## Common Pitfalls

- **Import extensions**: Always use `.js` in imports, never `.ts` or extensionless
- **`git-cli-sandbox`**: `apps/demos/git-cli-sandbox/` is stale — ignore its test failures
- **`split()` limit**: `"a b".split(" ", 2)` gives `["a","b"]` not `["a","b c"]` — use `indexOf` + `slice`
- **Refs vs Checkout**: `CommitCommand` uses `history.refs`, not `checkout.head`

## Self-Maintenance

When you discover an undocumented convention, encounter a repeated mistake, or learn a project-specific gotcha during a session, **propose an update to CLAUDE.md** (or the relevant `.claude/*` file). This keeps guidance current and prevents the same mistakes across sessions.

Trigger examples:
- You get corrected on a pattern — add it to the relevant conventions section
- A build/test fails due to an undocumented requirement — document it
- You discover a stale reference or outdated instruction — fix it

## Project-Specific Tools

Beads CLI is installed via the project's own install script, not npm/pip. For Jira URLs, use the format: `https://<domain>/browse/<ISSUE-KEY>`
