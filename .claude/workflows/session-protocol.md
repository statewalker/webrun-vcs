# Session Protocol

This document defines the mandatory workflow for completing work sessions. Work is **NOT complete** until all changes are pushed to the remote repository.

## Pre-Commit Quality Checks

Before every commit, run these commands in order:

```bash
pnpm test         # Ensure all tests pass
pnpm lint:fix     # Fix and verify linting
pnpm format:fix   # Fix and verify formatting
```

Do not commit code that fails tests or has linting/formatting issues. If any command fails, fix the issues before proceeding.

## Session Completion Checklist

When ending a work session, complete ALL steps below:

### 1. Run Quality Gates

If code changed, run tests, linters, and builds:

```bash
pnpm test
pnpm lint:fix
pnpm format:fix
```

### 2. Push to Remote

This is **MANDATORY**:

```bash
git pull --rebase
git add .
git commit -m "Your commit message"
git push
git status  # MUST show "up to date with origin"
```

### 3. Clean Up

- Clear any stashes
- Prune remote branches if needed

### 4. Verify

- All changes committed AND pushed
- `git status` shows clean working tree
- Remote is up to date

### 5. Hand Off

Provide context for the next session about:
- What was completed
- What's in progress
- Any blockers or issues discovered

## Why Formatting Runs at Session End (Not Per-Edit)

The PostToolUse hook runs `tsc --noEmit` after each edit for fast type-checking. Biome formatting is deferred to session end (`pnpm format:fix`) because running it after every edit adds latency without proportional benefit — formatting issues don't block development flow the way type errors do.

## Critical Rules

- **Work is NOT complete until `git push` succeeds**
- **NEVER stop before pushing** - that leaves work stranded locally
- **NEVER say "ready to push when you are"** - YOU must push
- **If push fails**, resolve conflicts and retry until it succeeds

## Quick Reference

```bash
# Complete session workflow
pnpm test && pnpm lint:fix && pnpm format:fix  # Quality gates
git pull --rebase                               # Get latest
git add . && git commit -m "..."               # Commit
git push                                        # Push (MANDATORY)
git status                                      # Verify
```
