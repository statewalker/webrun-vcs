# Offline-First PWA Demo

## What it is

A Vite single-page app, packaged as a Progressive Web App with `vite-plugin-pwa`, that creates a Git repository in the browser with `@statewalker/vcs-commands`, stages files, commits them and lists the history. After the first load of a production build, the service worker serves the app without a network. The page also shows the online/offline state and an install button when the browser offers one.

## Layout

```
index.html               connection indicator, storage buttons, file form, staged list, commits, install button
src/
  main.ts                UI wiring, Git.init(), staging, commit, history, PWA install handling
  storage-manager.ts     createMemoryStorage(), createPersistentStorage(), navigator.storage helpers
  styles.css
vite.config.ts           VitePWA: manifest, workbox precache, Google Fonts runtime cache
```

The service worker and web manifest are generated at build time by `vite-plugin-pwa`; they are not checked in.

## How to run it

1. `pnpm install && pnpm build` at the repository root (Node 24); the `@statewalker/vcs-*` packages resolve to their built `dist/`.
2. For the Git part only:

   ```bash
   pnpm --filter @statewalker/vcs-demo-offline-pwa dev
   ```

3. For the offline and install behaviour, build and serve the production bundle, load it once online, then go offline (for example in DevTools) and reload:

   ```bash
   pnpm --filter @statewalker/vcs-demo-offline-pwa build
   pnpm --filter @statewalker/vcs-demo-offline-pwa preview
   ```

In the page: click **Initialize Repository**, enter a file name and content, **Add File**, enter a message, **Create Commit**.

## How the app uses the library

```typescript
import { Git } from "@statewalker/vcs-commands";
import { FileMode } from "@statewalker/vcs-core";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

const { git, workingCopy, repository } = await Git.init()
  .setFilesApi(new MemFilesApi())
  .setGitDir(".git")
  .setInitialBranch("main")
  .call();

// Stage a file directly: store the blob, then add an index entry.
const data = new TextEncoder().encode(content);
const objectId = await repository.blobs.store([data]);
const editor = workingCopy.checkout.staging.createEditor();
editor.add({
  path: fileName,
  apply: () => ({
    path: fileName,
    mode: FileMode.REGULAR_FILE,
    objectId,
    stage: 0,
    size: data.length,
    mtime: Date.now(),
  }),
});
await editor.finish();

const commit = await git.commit().setMessage(message).call();
console.log(commit.id);
```

The PWA side is configured in `vite.config.ts`:

```typescript
VitePWA({
  registerType: "autoUpdate",
  manifest: { name: "Offline Git VCS", short_name: "VCS PWA", display: "standalone", /* ... */ },
  workbox: { globPatterns: ["**/*.{js,css,html,ico,png,svg}"] },
});
```

## Why it is the way it is

- **No working tree on disk.** Files are written straight into the object store and the index with a staging editor, so the app needs no file-system access at all and works in every browser.
- **Everything the app needs is precached.** Workbox precaches all built JS, CSS, HTML and images, and the Git engine is part of that bundle, so once installed nothing in the commit path touches the network.
- **`autoUpdate` registration.** A new build replaces the service worker without asking the user.

## What will surprise you

- **"Persistent" storage is not persistent.** `createPersistentStorage()` checks for the Origin Private File System and creates a `vcs-pwa` directory in it, but then returns an in-memory `MemFilesApi` (the OPFS adapter is not implemented). The label reads `Persistent (OPFS - limited)`. On browsers without OPFS it falls back to `In-Memory (OPFS not available)` and the button is disabled. Either way, all data is lost on reload.
- **The history lives in memory regardless of backend.** `Git.init()` always creates an in-memory history.
- **Offline does not work under `dev`.** `vite-plugin-pwa` only generates and registers the service worker in a build; use `build` + `preview`.
- **The manifest icons are missing.** The manifest points at `/icons/icon-192.png` and `/icons/icon-512.png`, and there is no `public/icons/` directory, so the browser reports icon fetch errors and may refuse to offer installation.
- **Errors are shown in the repository status line** (`Initialize repository first`, `No files staged`, `Error: <reason>`) or only in the console (`Failed to add file:`). An empty file name or commit message is silently ignored.

## Reference

### Commands

| Command | What it does |
|---|---|
| `pnpm --filter @statewalker/vcs-demo-offline-pwa dev` | Vite dev server (no service worker) |
| `pnpm --filter @statewalker/vcs-demo-offline-pwa build` | Production build with service worker and manifest, to `dist/` |
| `pnpm --filter @statewalker/vcs-demo-offline-pwa preview` | Serve the production build |
| `pnpm --filter @statewalker/vcs-demo-offline-pwa typecheck` | `tsc --noEmit` |

### Dependencies

`@statewalker/vcs-commands` (`Git`), `@statewalker/vcs-core` (`FileMode`, types), `@statewalker/vcs-working-tree` (types), `@statewalker/webrun-files` and `@statewalker/webrun-files-mem` (`MemFilesApi`); `vite-plugin-pwa`, `workbox-build` and `workbox-window` at build time. `@statewalker/vcs-store-mem` and `@statewalker/webrun-files-browser` are declared but not imported.
