---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": minor
---

A submodule using git master's `extensions.objectStorage = files://<dir>` no longer fails its superproject's status and diff: the submodule is reported with a `warning: cannot look into submodule` line (`SubmoduleDirt.unreadable`), its commit change still read from refs. Clone reports such a source's format instead of "does not exist". New `setObjectStorageFormat` on `CloneCommand`, `SubmoduleAddCommand` and `SubmoduleUpdateCommand` (t7427's `--object-storage-format`); `UnsupportedRepositoryFormatError.notSupportedHere` tells our limitations from git's refusals. Fixes statewalker/webrun-vcs#441.
