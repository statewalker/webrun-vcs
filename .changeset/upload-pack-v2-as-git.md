---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-transport-adapters": patch
---

**upload-pack behaves as git's: "not our ref", ok_to_give_up, shallow fetches over protocol v2; smart-HTTP takes gzip bodies and limits their size.**

- **Protocol v2 `fetch`:**
  - A want that is no tip and no commit reachable from one is refused with `ERR upload-pack: not our ref <oid>` (git's `uploadpack.allowReachableSHA1InWant`). Before, any object the repository held was served. `serveOverDuplex` takes `requestPolicy`; `"ANY"` serves any object, as git's own v2 does.
  - Negotiation follows `upload-pack.c`: `ready` only once every want reaches a common commit (`ok_to_give_up`), never with `wait-for-done`; `NAK` when nothing is common; no acknowledgments section after `done` or without haves (real git clients failed on it).
  - Shallow: `deepen`, `deepen-relative`, `deepen-since`, `deepen-not`, client `shallow` lines and unshallowing (`--deepen`, `--unshallow`) answer a `shallow-info` section, and the pack is cut at the boundary. `shallow-info` was always empty and depth ignored.
  - `filter` is no longer advertised (no partial clone), and a `filter` request is refused.
- **Protocol v0/v1 upload-pack:** the refusal reads `upload-pack: not our ref <oid>`; the default advertisement drops `filter` and `deepen-relative`, lists `allow-tip-sha1-in-want`/`allow-reachable-sha1-in-want` only when the request policy allows them, and `deepen-since`/`deepen-not` only when the repository facade implements them.
- **`RepositoryFacade`:** new optional `getCommitInfo(oid)` (parents and committer time) for these walks; `createRepositoryFacade` implements it and `computeShallowBoundaries`. New exports `findUnreachableWant`, `okToGiveUp`, `computeShallowUpdate`, `notOurRef`, `defaultUploadPackCapabilities`.
- **Protocol v2 client:** each request resends the commits found common, and sends `done` once it has no new haves (it looped when the server was never ready).
- **Smart-HTTP server:** `Content-Encoding: gzip` request bodies are inflated (`DecompressionStream`), other encodings get 415; `maxRequestBodyBytes` (default 10 MiB for upload-pack, 1 GiB for receive-pack, counted after inflating, streamed) answers 413. receive-pack no longer advertises `report-status-v2`, which it never wrote.
- **vcs-transport-adapters:** `VcsRepositoryFacade.computeShallowBoundaries(wants, depth)` returns git's boundary (`depth` commits deep; it was one deeper), and the facade implements `getCommitInfo`.
