---
"@statewalker/vcs-transport": patch
"@statewalker/vcs-commands": patch
---

`git fetch <url>` from an empty remote, or one whose HEAD is unborn, dies with git's `fatal: couldn't find remote ref HEAD` (exit 128), as does any exact refspec source such a remote lacks; wildcards and configured refspecs still go through. A clone of a repository whose HEAD is unborn but which has refs now succeeds with git's configuration (`branch.<b>.*`; no fetch refspec for `--single-branch`). (#280)
