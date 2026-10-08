# @statewalker/vcs-transport

## 0.3.3

### Patch Changes

- 6e13964: HTTP `push`, `fetch`, `clone` and `lsRemote` send `Credentials.token` as the Basic auth password, with the username defaulting to `x-access-token`. They sent `Basic` auth built from the missing username and password (`undefined:undefined`) instead.
- Updated dependencies
- Updated dependencies
  - @statewalker/vcs-core@0.3.4
  - @statewalker/vcs-utils@0.3.3

## 0.3.2

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/vcs-core ^0.3.1 -> ^0.3.2
  - files changed: README.md, src/README.md
- Updated dependencies
- Updated dependencies
  - @statewalker/vcs-core@0.3.3
  - @statewalker/vcs-utils@0.3.2

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/vcs-core@0.1.1
  - @statewalker/vcs-utils@0.1.1
