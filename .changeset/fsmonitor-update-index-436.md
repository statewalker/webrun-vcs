---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
---

fsmonitor: `UpdateIndexCommand.setFsmonitor` / `setFsmonitorValid` (`git update-index --[no-]fsmonitor`, `--[no-]fsmonitor-valid`, with git's warnings and its bare-repository refusal), `update-index --refresh` asks the monitor and skips and marks fsmonitor-valid entries, and diff-files, `git diff` and diff-index take entries the monitor reported nothing for as unchanged without an lstat. `FsmonitorState.writtenWhileDisabled` keeps an `FSMN` that `update-index --fsmonitor` added with `core.fsmonitor` off.
