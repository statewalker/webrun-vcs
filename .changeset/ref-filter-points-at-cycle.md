---
"@statewalker/vcs-commands": patch
---

Ref filter: `--points-at` stops on a tag cycle made through replace refs instead of looping forever. It now peels with the same bound (`MAX_REF_FILTER_PEEL_DEPTH`) that `--contains`/`--merged` and `%(*atom)` already use, and counts such a tag as not matching (#263).
