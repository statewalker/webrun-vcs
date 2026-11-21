---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-commands": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-utils-node": patch
---

**The served HTTP handler serves the dumb protocol as `git http-backend` does, checks the request's content type, and appends to the alternates a quarantined pre-receive is given.**

- `createServedHttpHandler` / `createServedFetchHandler` answer the dumb protocol by default (`http.getanyfile`, as http-backend; `getAnyFile: false` or the repository's `http.getanyfile=false` turns it off): `objects/info/packs` generated from the repository's own packs (youngest first, no `update-server-info` needed), `objects/info/alternates`, `objects/info/http-alternates`, loose objects, packs and indexes, with http-backend's content types and caching (`no-cache`, or a year for objects and packs), `Content-Length` and `Last-Modified`; a missing file is a 404. A native client with `GIT_SMART_HTTP=0` clones and fetches from it. The dumb protocol is still served only where upload-pack is, and `info/refs` still leaves out hidden refs; the object files are not filtered, so servers relying on hidden refs turn it off.
- The files come from the new `ServedRepository.files` (`servedGitFilesOf(files, gitDir)`; `servedRepositoryOf` sets it from the new `OpenedRepository.files`, which `Worktree.openRepository` fills). A file whose links lead outside the git directory is not served. A repository without files (key-value, SQL, memory stores) answers `HEAD` and `info/refs` only and every `objects/...` path 404.
- A POST to `git-upload-pack` / `git-receive-pack` whose `Content-Type` is not exactly `application/x-git-<service>-request` is answered 415 with http-backend's message.
- A quarantined pre-receive's `GIT_ALTERNATE_OBJECT_DIRECTORIES` is the host's (new `GitHostEnvironment.alternateObjectDirectories`, read from `GIT_ALTERNATE_OBJECT_DIRECTORIES` by `createNodeGitHostEnvironment`) with the repository's objects appended, as tmp-objdir.c's `env_append`.
