# Git CLI Sandbox

## What it is

A small `git`-like command-line tool (`vcs-git`) built on the porcelain API of `@statewalker/vcs-commands`. It reads and writes a real `.git` directory on disk through `@statewalker/vcs-store-files` and talks to remotes over smart HTTP through `@statewalker/vcs-transport`. It is a sandbox for trying the library against the file system, not a replacement for git.

## Layout

```
src/
  main.ts              command table, help output, error handling
  shared.ts            opens/creates a repository, output colors, default author
  commands/
    init.ts            init [directory] [--bare]
    clone.ts           clone <url> [directory] [--branch <name>] [--depth <n>] [--bare]
    staging.ts         add, status, rm
    commit.ts          commit -m <message> [--author "Name <email>"] [--allow-empty] [--amend]
    branch.ts          branch, checkout
    merge.ts           merge <branch> [--no-ff] [--squash] [-m <message>]
    history.ts         log, diff
    remote.ts          remote, fetch, pull, push
```

Every command except `init` and `clone` finds the repository by walking up from the current directory to the first directory that contains a `.git` directory, then builds a `Git` facade over it (`shared.ts`):

```
createNodeFilesApi({ rootDir })
  -> createGitFilesBackend({ files, gitDir: ".git" })   history + objects
  -> FileStagingStore(files, ".git/index")              index
  -> createFileWorktree(...)                            working tree
  -> createMemoryWorkingCopy({ history, checkout, worktree })
  -> Git.fromWorkingCopy(workingCopy)
```

## How to run it

The `@statewalker/vcs-*` workspace packages resolve to their built `dist/`, so build once first.

1. `pnpm install && pnpm build` at the repository root (Node 24).
2. Run the CLI with the working directory set to where the repository should live. The simplest way is to call `tsx` from the workspace root directly:

   ```bash
   VCS_ROOT=$PWD    # the repository root
   alias vcs-git="$VCS_ROOT/node_modules/.bin/tsx $VCS_ROOT/apps/demos/git-cli-sandbox/src/main.ts"

   mkdir /tmp/sandbox && cd /tmp/sandbox
   vcs-git init repo
   cd repo
   echo hello > a.txt
   vcs-git add a.txt
   vcs-git commit -m "first"
   vcs-git log --oneline
   vcs-git branch feature
   vcs-git checkout feature
   ```

3. `vcs-git --help` lists the commands; `vcs-git <command> --help` prints one command's usage.

The package also has `start` and `git` scripts (`tsx src/main.ts`). Through `pnpm --filter @statewalker/vcs-demo-git-cli-sandbox git <args>` they run with the app directory as the working directory, which is rarely what you want (see below).

## Why it is the way it is

- **Porcelain for local commands, transport functions for the network.** `add`, `commit`, `branch`, `checkout`, `merge`, `log`, `diff`, `remote`, `fetch` and `pull` go through `git.<command>().call()`. `clone` and `push` call `clone()` and `push()` from `@statewalker/vcs-transport` directly: `clone` indexes the received pack with `indexPack()` and writes `pack-<sha>.pack` and `.idx` itself, then writes `.git/config` with the `origin` remote; `push` collects the commit, its tree and blobs and hands them to `push()`.
- **One process per command.** Each command opens the repository, does its work and closes the history, so state lives only in `.git`.
- **Author from the environment.** `commit` uses `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`, falling back to `$USER` and `$USER@localhost`, unless `--author "Name <email>"` is given.

## What will surprise you

- **`pnpm --filter ... git status` operates on the wrong repository.** pnpm runs the script from `apps/demos/git-cli-sandbox/`; the repository search walks up from there and finds the monorepo's own `.git` (if it is a directory). Run the CLI from the directory you mean, as shown above. The app's `.gitignore` ignores `vcs/`, a place to `init` scratch repositories inside the app folder.
- **Outside a repository** every command except `init` and `clone` prints `fatal: not a git repository (or any of the parent directories): .git` and exits 1.
- **`init` in an existing repository fails** with `fatal: Reinitialized existing Git repository in <path>/.git/` and exit code 1; it does not reinitialize.
- **`status` shows only staged changes and conflicts.** Untracked and modified-but-unstaged files are not listed, so a fresh `init` with files in it reports `nothing to commit, working tree clean`. `diff` with no arguments likewise prints `No changes` for unstaged edits.
- **`status` and `commit` print `On branch HEAD` / `[HEAD <id>]`** instead of the branch name: they resolve `HEAD` through to the commit, so the symbolic-ref check never matches. `commit` also reports ` 0 file(s) changed`, because it counts staged changes after the commit has emptied them.
- **`commit` without `-m`** fails with `fatal: Aborting commit due to empty commit message.`
- **Unknown commands** print `vcs-git: '<name>' is not a command. See 'vcs-git --help'.` and exit 1.
- **`clone`, `fetch`, `pull` and `push` need network access** to an HTTP Git server. `clone` refuses a non-empty target (`fatal: destination path '<dir>' already exists and is not an empty directory.`) and deletes the target directory if the clone fails. `push` without a configured remote fails with `fatal: Remote 'origin' not found`.
- **The `vcs-git` bin entry points to `dist/main.js`, which nothing builds.** The package has no `build` script, so the bin is not usable after install; run the source with `tsx`.

## Reference

### Commands

| Command | Usage |
|---|---|
| `init` | `init [directory] [--bare]` (default branch `main`) |
| `clone` | `clone <url> [directory] [--branch <name>] [--depth <n>] [--bare]` |
| `add` | `add <pathspec>... [-u]` |
| `status` | `status` |
| `rm` | `rm <file>... [--cached]` |
| `commit` | `commit -m <message> [--author "Name <email>"] [--allow-empty] [--amend]` |
| `branch` | `branch [-v] [-a]` to list, `branch <name> [<start>]` to create, `-d <name>...`, `-m <old> <new>` |
| `checkout` | `checkout <branch>`, `checkout -b <new-branch>` |
| `merge` | `merge <branch> [--no-ff] [--squash] [-m <message>]` |
| `log` | `log [-n <number>] [--oneline] [--all]` (default 10 commits) |
| `diff` | `diff [<commit>] [<commit>] [--cached] [--stat]` (lists changed paths, no hunks) |
| `remote` | `remote [-v]`, `remote add <name> <url>`, `remote remove <name>`, `remote set-url <name> <url>` |
| `fetch` | `fetch [remote]` |
| `pull` | `pull [remote] [branch] [--rebase]` |
| `push` | `push [remote] [branch] [-f]` |

### Scripts

| Script | What it does |
|---|---|
| `start`, `git` | `tsx src/main.ts` (from the app directory) |
| `typecheck` | `tsc --noEmit` |

### Environment

| Variable | Used for |
|---|---|
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | Commit author and committer; default `$USER`, `$USER@localhost` |

### Dependencies

`@statewalker/vcs-commands` (porcelain), `@statewalker/vcs-core` (types, `indexPack`, `writePackIndex`), `@statewalker/vcs-store-files` (Git file backend, index, worktree), `@statewalker/vcs-working-tree` (working copy), `@statewalker/vcs-transport` (HTTP clone/push), `@statewalker/vcs-utils` and `@statewalker/vcs-utils-node` (compression, Node `FilesApi`). `@statewalker/vcs-store-mem` is declared but not imported.
