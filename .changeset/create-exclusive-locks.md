---
"@statewalker/vcs-utils": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-utils-node": patch
---

**Lock files use `FilesApi.createExclusive` when the FilesApi has it.** `atomicFilesOver(files, root).createExclusive` now delegates to the FilesApi's own exclusive create (webrun-files: `open "wx"` on Node, Web Locks in the browser, a transaction in sqlite) when it is present, detected at run time. Every git lock goes through it (`<ref>.lock` and `packed-refs.lock` in ref batches, `index.lock`, `gc.pid` and `gc.pid.takeover`), so the exclusion becomes cross-process: native git, other tabs and other FilesApi instances over the same directory are excluded. A delegated create that fails with ENOENT (another process, such as native git, pruned the empty directory between webrun-files-node's `mkdir` and its `open`) is retried, as git's `raceproof_create_file` does. Without it, locks behave as before: check-then-write, exclusive only among writers sharing one FilesApi instance.

**webrun-files 0.11.** The catalog moves `@statewalker/webrun-files`, `-node`, `-mem` and `-browser` to `^0.11.0`. Every one of them now has `createExclusive`, so on Node locks hold across processes: two processes with their own `createNodeFilesApi` over one repository never both take `<ref>.lock` or `index.lock`, and native `git` sees our locks (and we see its). `createNodeFilesApi().write` streams to a temporary file and renames it over the target, and a `createNodeFilesApi({ rootDir: "/" })` accepts absolute paths. The vcs `FilesApi` interface declares the optional `createExclusive`, as webrun-files does.
