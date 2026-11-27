---
"@statewalker/vcs-commands": patch
---

A partial clone's lazy fetch now asks the credential helper. A transport command given `setCredentialHelper` (and `setWarningCallback`) hands them to the promisor fetcher it installs for its call, and `installPromisorFetcher`/`createPromisorFetcher` take `credentialHelper` and `warningCallback`, as git's child `git fetch --filter=blob:none --stdin` reads `credential.helper` (statewalker/webrun-vcs#401).
