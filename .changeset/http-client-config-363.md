---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-utils": minor
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-working-tree": minor
---

git's HTTP client configuration (statewalker/statewalker-root#363): remote commands read `http.<url>.*` for the remote's URL (`httpClientSettingsOf`, git's urlmatch; `urlMatchedEntries` in vcs-utils) and the smart-HTTP client (`SmartHttpClient`) applies `http.extraHeader`, `http.userAgent`, `http.followRedirects` (default `initial`: later requests re-rooted where the first redirect ended, as git), `http.emptyAuth`, and git 2.52's 429 retries (`http.maxRetries`, `retryAfter`, `maxRetryTime`, the `GIT_HTTP_*` variables through `GitHostEnvironment.httpVariables`). `setCredentialHelper` answers a 401 with the server's challenges and is told what worked (`approve`) or was refused (`reject`); `Credentials.authtype`/`credential` send another scheme (`Bearer`). The submodule credential guard now follows a browser's opaque redirect within the approved origin (statewalker/webrun-vcs#313). TLS, proxies, cookies and Negotiate stay the host `fetch`'s.
