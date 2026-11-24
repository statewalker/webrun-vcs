---
"@statewalker/vcs-commands": minor
---

`git submodule update` and `git submodule status` (`git.submoduleUpdate()`, `git.submoduleStatus()`): update clones missing submodules into `.git/modules/<name>` and brings each to the commit the index records with its strategy (checkout, rebase, merge, `none`, or a configured `!command`), with `--init`, `--remote` (`submodule.<name>.branch`), `--recursive`, `--force`, `--no-fetch`, `--depth` and `--[no-]recommend-shallow`; its clones and fetches go through the command's transports, and credentials and headers reach only the URLs they are given for (`setCredentialsForUrl`/`setHeadersForUrl` per URL; static `setCredentials`/`setHeaders` only for the origins named with `addCredentialOrigin`, else the superproject's remote's origin), never another host a `.gitmodules` names. Status prints git's `-`/`+`/`U`/` ` lines with `describe`'s names, `--cached` and `--recursive`. `%(describe)` takes `all` and `always`.
