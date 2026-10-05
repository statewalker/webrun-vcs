# Browser VCS App

## What it is

A single-page Vite app that runs Git operations in the browser with `@statewalker/vcs-commands`, over one of two file backends: an in-memory `FilesApi` or a folder the user picks through the File System Access API. It can initialize a repository, write files, stage them, commit, and show the last ten commits. There is no backend server.

## Layout

```
index.html               page markup (storage buttons, file form, trees, history, log)
src/
  main.ts                checks File System Access API support, calls createApp()
  app.ts                 UI wiring and all Git calls
  storage.ts             createMemoryStorage(), createBrowserFsStorage(), listAllFiles(), hasGitDirectory()
  styles.css
tests/
  browser-vcs-app.spec.ts  Playwright tests (in-memory, and browser FS with a mocked directory handle)
```

```
            app.ts  ── Git.init().setFilesApi(files).setWorktree(true) ──> git, workingCopy, repository
               │
          FilesApi (@statewalker/webrun-files)
       ┌───────┴─────────────────────────┐
  MemFilesApi                       BrowserFilesApi({ rootHandle })
  (@statewalker/webrun-files-mem)   (@statewalker/webrun-files-browser, showDirectoryPicker())
```

## How to run it

1. `pnpm install && pnpm build` at the repository root (Node 24); the `@statewalker/vcs-*` packages resolve to their built `dist/`.
2. Start the dev server:

   ```bash
   pnpm --filter @statewalker/vcs-demo-browser-app dev
   ```

3. Open the URL Vite prints (`http://localhost:5173` by default).
4. Choose **In-Memory** or **Browser Filesystem**, click **Initialize Repository**, add a file (name and content), enter a commit message, and commit.

## How the app uses the library

### Choosing a file backend

```typescript
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

const memoryFiles = new MemFilesApi();

const rootHandle = await window.showDirectoryPicker();
const browserFiles = new BrowserFilesApi({ rootHandle });
```

### Creating the repository

```typescript
import { Git } from "@statewalker/vcs-commands";
import { FileStagingStore } from "@statewalker/vcs-store-files";

const init = Git.init()
  .setFilesApi(files)
  .setGitDir(".git")
  .setInitialBranch("main")
  .setWorktree(true);

// Browser folder only: keep the index in .git/index in Git's binary format.
const staging = new FileStagingStore(files, ".git/index");
init.setStagingStore(staging);

const { git, workingCopy, repository } = await init.call();
```

### Adding and committing

```typescript
await files.write(fileName, [new TextEncoder().encode(content)]);
await git.add().addFilepattern(fileName).call();
await staging.write(); // browser folder only

const commit = await git.commit().setMessage(message).call();
console.log(commit.id);
```

History is read with `repository.commits.walkAncestry(headId, { limit: 10 })` and `repository.commits.load(id)`.

## Why it is the way it is

- **One `FilesApi`, two backends.** All file access goes through the `FilesApi` interface, so switching between memory and a real folder changes one constructor call and nothing in the Git code.
- **`FileStagingStore` only for the folder backend.** In a real folder the index is written to `.git/index` after each add and commit (re-read from the committed tree), so the staging state survives a reload and is visible to tools that read the index. In memory the default staging store is enough.
- **Porcelain commands.** Add and commit go through `git.add()` and `git.commit()` rather than editing the index and storing objects by hand.

## What will surprise you

- **Commits are not saved to the chosen folder.** `Git.init()` always creates an in-memory history; `setFilesApi()` only backs the working tree. Your files and `.git/index` land on disk, but objects and refs do not. After a reload, **Open Repository** on a folder with `.git` starts an empty history again (the button label changes, the log says `Opened existing repository`, and the history shows `No commits yet`).
- **Browser Filesystem needs the File System Access API.** Chrome, Edge and Opera have it. In Firefox and Safari the page shows `Not Supported (in-memory only)` and the button is disabled. Calling it anyway fails with `File System Access API is not supported in this browser`.
- **In-memory data is gone on reload or when switching backends.** Switching storage closes the current history.
- **Errors appear in the activity log, not as exceptions,** for example `No repository initialized`, `Please enter a file name`, `Please enter a commit message`, `No files staged for commit`, `Failed to create commit: <reason>`.
- **`test:app` starts its own dev server** on port 5173 (`pnpm dev`) and reuses one already running there outside CI. The browser-filesystem tests run against a mocked `showDirectoryPicker()`, not a real folder.

## Reference

### Commands

| Command | What it does |
|---|---|
| `pnpm --filter @statewalker/vcs-demo-browser-app dev` | Vite dev server |
| `pnpm --filter @statewalker/vcs-demo-browser-app build` | Production build to `dist/` |
| `pnpm --filter @statewalker/vcs-demo-browser-app preview` | Serve the production build |
| `pnpm --filter @statewalker/vcs-demo-browser-app test:app` | Playwright tests (Chromium) |
| `pnpm --filter @statewalker/vcs-demo-browser-app test:ui` | Playwright UI mode |
| `pnpm --filter @statewalker/vcs-demo-browser-app typecheck` | `tsc --noEmit` |

### Dependencies

`@statewalker/vcs-commands` (`Git`), `@statewalker/vcs-core` (types, `FileMode`), `@statewalker/vcs-store-files` (`FileStagingStore`), `@statewalker/vcs-working-tree` (types), `@statewalker/webrun-files`, `@statewalker/webrun-files-mem`, `@statewalker/webrun-files-browser`. `@statewalker/vcs-store-mem` is declared but not imported.
