---
"@statewalker/vcs-transport": minor
---

**Smart-HTTP server speaks protocol v2.** `createFetchHandler`, `createHttpHandler` and `createGitHttpServer` answer `Git-Protocol: version=2` as git's http-backend does: `GET /info/refs?service=git-upload-pack` sends the v2 capability advertisement, and each `POST /git-upload-pack` runs one stateless v2 command (`ls-refs`, `fetch`, `object-info`) with the v2 server state machine, streaming the pack. gzip request bodies and `maxRequestBodyBytes` apply as in v0. Requests without the header, and receive-pack, stay v0. New exports: `handleInfoRefsV2`, `handleUploadPackV2`, `requestsProtocolV2`, `isProtocolV2Request`; new options `protocolV2` and `v2Capabilities`.

Also: the v0 HTTP handler advertises what upload-pack implements for the repository (`deepen-since`, `deepen-not`, `deepen-relative` with a commit graph); v0 upload-pack honours the `deepen-relative` capability (`git fetch --deepen`), which it ignored before; `object-info` reports the size of any object type, not only blobs. Real `git clone`/`fetch`/`ls-remote` over HTTP is tested with protocol v2 and v0 (shallow, deepen, unshallow, multi-round negotiation).
