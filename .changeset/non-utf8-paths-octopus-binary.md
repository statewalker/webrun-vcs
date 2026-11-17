---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-utils-node": patch
"@statewalker/vcs-core": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
---

**Paths that are not valid UTF-8 keep their bytes; octopus merges refuse binary files as git does.**

```typescript
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";

decodeGitPath(new Uint8Array([0x63, 0x61, 0x66, 0xe9])); // "caf\udce9" (latin-1 caf\xe9)
encodeGitPath("caf\udce9");                              // the same four bytes
```

Git paths are bytes. A tree or index entry named `caf\xe9.txt` (latin-1, made by native git) was decoded with `TextDecoder`, which turned the byte into U+FFFD: the name was lost, a tree or index written back got another id, and distinct names could collapse into one. Paths stay strings, now through a reversible encoding at the byte boundaries (Python's `surrogateescape`): valid UTF-8 decodes as before, and each byte outside a valid UTF-8 sequence becomes the lone surrogate U+DC00 + byte.

- **vcs-utils:** `decodeGitPath`, `encodeGitPath`, `compareGitPaths` (git's byte order) and `hasEscapedBytes` in `@statewalker/vcs-utils/encoding`. `ByteSink.text` writes escaped bytes as the bytes they stand for.
- **vcs-core:** tree entry names are decoded and encoded with them (and sorted by their bytes), so reading a tree and storing it again keeps its id; `listObjects` and the structural tree deltas keep the names too.
- **vcs-working-tree:** index entries (versions 2 to 4; reading version 4 now counts the shared prefix in bytes, as git writes it, which a non-ASCII path got wrong), the cache-tree (`TREE`) and resolve-undo (`REUC`) extensions keep the bytes, and the index is sorted by them; wildmatch matches the bytes; a C-quoted `.gitattributes` pattern with octal escapes unquotes to the same bytes.
- **vcs-store-files:** the staging store sorts by bytes.
- **vcs-utils-node:** the Node `FilesApi` hands such a path to the operating system as its bytes and lists names as bytes, so on Linux the worktree file has the original name (checkout, status, add). Hosts whose names are Unicode cannot hold it: the browser file system APIs store U+FFFD for each escaped byte, and macOS and Windows refuse or rewrite the name; trees, the index and commits keep the bytes there too.
- **vcs-commands:** diff (`patch`, `stat`, `numstat`, `name-only`, `name-status`, renames) and status quote the names as git does (`"caf\351.txt"`), and with `core.quotePath=false` print the bytes themselves; diff, status, rename detection and clean sort paths in git's byte order.

Octopus merges (`include("a").include("b")`): a binary file the last head changes is refused as `git merge-file` refuses it (`error: Cannot merge binary files: .merge_file_XXXXXX`, then `ERROR: content conflict in <path>`): ours stays in the worktree, with stages 1 to 3 in the index, where conflict markers were written before. The conflict markers git-merge-one-file writes carry the names of its temporary files (`<<<<<<< .merge_file_XXXXXX`, also on `|||||||` with `diff3`/`zdiff3`), random in git; ours are numbered. A `MergeResult` of an octopus left with conflicts now carries what git-merge-one-file printed on stderr in `message` (`ERROR: content conflict in f`, `fatal: merge program failed`).
