# Versioned Documents Demo

## What it is

A Vite single-page app that keeps versions of an office document in an in-memory Git repository. You drop in a `.docx` or `.odt` file; the app unpacks the ZIP archive into its internal files (XML parts, media), commits them as one version, and lets you save more versions, list them, restore one into the view, download any version as a rebuilt document, and compare two versions file by file.

## Layout

```
index.html                 drop zone, document panel (file tree, save form), history and compare panels
src/
  main.ts                  UI wiring; creates one VersionTracker on page load
  document-decomposer.ts   decomposeDocument(), reconstructDocument() with JSZip
  version-tracker.ts       VersionTracker: in-memory repository, one commit per version
  styles.css
```

```
.docx / .odt ──JSZip──> Map<path, bytes> ──blobs.store + staging editor──> commit (= version)
                                                                              │
download <──JSZip.generateAsync── Map<path, bytes> <──trees.load + blobs.load──┘
compare: git.diff().setOldTree(a).setNewTree(b)
```

## How to run it

1. `pnpm install && pnpm build` at the repository root (Node 24); the `@statewalker/vcs-*` packages resolve to their built `dist/`.
2. Start the dev server:

   ```bash
   pnpm --filter @statewalker/vcs-demo-versioned-documents dev
   ```

3. Open the URL Vite prints (`http://localhost:5173` by default) and drop a `.docx` or `.odt` file on the page. The upload is saved at once as version `Initial upload`.

## How it works

### Taking a document apart

```typescript
const components = await decomposeDocument(file);
// components.files: Map<string, Uint8Array>, one entry per file in the ZIP
// components.metadata: { type: "docx" | "odf" | "unknown", fileName, fileCount }
```

The type is detected from the contents: `[Content_Types].xml` means DOCX, a `mimetype` entry means ODF.

### Storing a version

`VersionTracker.initialize()` builds a working copy from in-memory parts and wraps it in a `Git` facade:

```typescript
import { Git } from "@statewalker/vcs-commands";
import { createMemoryHistory } from "@statewalker/vcs-core";
import {
  createMemoryCheckout,
  createMemoryGitStaging,
  createMemoryWorkingCopy,
  createMemoryWorktree,
} from "@statewalker/vcs-working-tree";

const history = createMemoryHistory();
await history.initialize();
const checkout = createMemoryCheckout({ staging: createMemoryGitStaging() });
const worktree = createMemoryWorktree({ blobs: history.blobs, trees: history.trees });
const git = Git.fromWorkingCopy(createMemoryWorkingCopy({ history, checkout, worktree }));
```

`saveVersion(files, message)` stores each part as a blob, adds an index entry for it through `workingCopy.checkout.staging.createEditor()`, and commits with `git.commit().setMessage(message).call()`. The version id is the commit id.

### Reading versions back

| Method | What it returns |
|---|---|
| `getVersion(id)` | `Map<path, Uint8Array>` from the commit's tree |
| `listVersions()` | `{ id, message, date, author }[]`, newest first, walking ancestry from HEAD |
| `compareVersions(fromId, toId)` | `{ path, type: "added" \| "removed" \| "modified" }[]` from `git.diff()` |
| `getLatestVersionId()`, `getVersionCount()` | HEAD commit id, number of versions |

`reconstructDocument(files, fileName)` zips a version back into a `Blob` with the MIME type for `.docx` or `.odt`.

## Why it is the way it is

- **Parts, not whole files.** Storing each internal file as its own blob means an edit that touches only `word/document.xml` adds one new blob; styles, media and the rest are shared with earlier versions by content address. It also makes the comparison meaningful at the part level.
- **A flat tree.** Paths are stored with `/` replaced by `__` (`word/document.xml` becomes `word__document.xml`), so every part is a top-level entry and no subtrees need to be built. Paths are turned back on read and in diff output.
- **No working tree.** Parts go straight into the object store and the index with a staging editor; nothing needs a file system, so the app runs in any browser.

## What will surprise you

- **Everything is in memory.** One repository is created per page load; reloading the page loses all versions.
- **Parts removed in a later version stay in the commit.** Staging is never cleared between saves, so each version contains every part ever added; a part deleted from the document is still there, and a comparison never reports `removed` for it.
- **Only `.docx` and `.odt` are accepted.** Any other extension shows `Please upload a DOCX or ODT file`. Other ODF types (`.ods`, `.odp`) are rejected even though the decomposer would handle them.
- **A part name containing `__` comes back with `/`** in its place, because of the flat-tree encoding.
- **Rebuilt ODF files may not open everywhere.** The archive is rebuilt in tree order, so `mimetype` is not guaranteed to be the first entry, which ODF readers expect.
- **"Restore" only changes the view.** It loads the version's parts into the page; nothing is committed until you save a version again.
- **Errors appear in the status line** under the drop zone, as `Error processing file: <reason>`, `Error restoring version: <reason>`, `Error downloading version: <reason>` or `Error comparing versions: <reason>`.

## Reference

### Commands

| Command | What it does |
|---|---|
| `pnpm --filter @statewalker/vcs-demo-versioned-documents dev` | Vite dev server |
| `pnpm --filter @statewalker/vcs-demo-versioned-documents build` | Production build to `dist/` |
| `pnpm --filter @statewalker/vcs-demo-versioned-documents preview` | Serve the production build |
| `pnpm --filter @statewalker/vcs-demo-versioned-documents typecheck` | `tsc --noEmit` |

### Dependencies

`@statewalker/vcs-commands` (`Git`), `@statewalker/vcs-core` (`createMemoryHistory`, `FileMode`), `@statewalker/vcs-working-tree` (in-memory staging, checkout, worktree, working copy), `jszip` (archive read/write). `@statewalker/vcs-store-mem`, `@statewalker/webrun-files`, `@statewalker/webrun-files-browser` and `@statewalker/webrun-files-mem` are declared but not imported.
