---
"@statewalker/vcs-core": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-transport-adapters": patch
"@statewalker/vcs-workspace": minor
---

**upload-pack honours `include-tag`, both servers hide refs as git's `hideRefs`, upload-pack gets hooks, and the fetch client gzips large requests.**

- **vcs-core:** `listObjects` takes `includeTags` (candidate tag ids) and `ExportOptions.includeTags` passes it from `SerializationApi.exportPack`: as `git pack-objects --include-tag`, each annotated tag peeling to a packed object is added after the other objects, with every tag of its chain.
- **vcs-transport, include-tag:** upload-pack (v0/v1 and v2) adds the annotated tags of packed objects when the client asks for `include-tag`, so a client no longer needs a second fetch to backfill them. The candidates are the visible `refs/tags/*` (a hidden tag is never sent; git's pack-objects ignores hideRefs). `ExportPackOptions.includeTags` carries them to the facade; `includeTag: true` without it uses the facade's own `refs/tags/*`.
- **vcs-transport, hidden refs:** new `hideRefs` (git's `transfer.hideRefs`) on `serveOverDuplex`, `createHttpHandler`, `createGitHttpServer`, `createFetchHandler` and `messagePortServe`, plus upload-pack's (`uploadPack.hideRefs` / `uploadPackHideRefs`, git's `uploadpack.hideRefs`) and receive-pack's (`receivePack.hideRefs` / `receivePackHideRefs`, git's `receive.hideRefs`), with git's pattern rules (`isRefHidden`: component prefixes, `!` negation, `^` full names, last match wins). Hidden refs are left out of the v0 advertisements and v2 `ls-refs`; a want of a hidden tip is `not our ref` under the "ADVERTISED" policy ("TIP" and the reachable policies count hidden tips, as git's `allow*SHA1InWant`); a v2 `want-ref` of one is `unknown ref <name>`; receive-pack refuses changing one (`deny updating a hidden ref`, `deny deleting a hidden ref`) after the connectivity check, as git.
- **vcs-transport, upload-pack hooks:** new `UploadPackHooks` (`uploadPack.hooks` on the HTTP handlers, `uploadPackHooks` on `serveOverDuplex`, `hooks` on `messagePortServe`): `authorize(request, ctx)` sees the wants, the refs they name, the haves (v2) and the capabilities before any negotiation or pack byte and may refuse with `ERR <message>`; `postUpload(result, ctx)` runs detached once a pack was sent.
- **vcs-transport, v2:** `ls-refs peel` fully peels a chain of tags (was one level); an unknown `want-ref` reads git's `unknown ref <name>` (was `Unknown ref: <name>`).
- **vcs-transport, fetch client:** upload-pack request bodies over 1024 bytes (large have-batches) are sent with `Content-Encoding: gzip`, as git's remote-curl, where `CompressionStream` exists.
- **vcs-workspace:** `createSyncServer` takes `hideRefs` and `uploadPackHooks`.
