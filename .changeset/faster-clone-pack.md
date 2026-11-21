---
"@statewalker/vcs-core": patch
"@statewalker/vcs-transport": patch
"@statewalker/vcs-utils-node": patch
---

**Clones are about three times faster: pack generation and pack import do less work.**

On a 178 000-object repository (`node scripts/bench-clone.mjs <dir>`), a `clone().setLocal(false)` served by our upload-pack now takes 9.6 s instead of 27 s; the server's pack 3.7 s instead of 15 s, the import 4.1 s instead of 10.5 s.

- `writePack` copies a stored entry from the pack's cached windows in one piece (new optional `PackedEntry.data()`, CRC-checked once), instead of reading the file twice per entry, and gathers its output into 64 KiB chunks hashed once each.
- The delta search follows git's `try_delta` under reused deltas: a target stored whole in the pack its candidate base is in is not tried again (that pack's writer kept it whole), and contents are read only when a delta is tried. `PackSet.entry` reports the entry's `packId` for this. Packs written from one pack now match git's in size.
- `listObjects` marks ids in a table over raw ids (`ObjectIdFlags`) and decodes a tree entry's name only when the entry is listed; it reads objects synchronously when the store has them at hand (`getNow`, `GitObject.bytes`).
- `installPack` keeps the inflated deltas of the first pass for delta resolution (`deltaStashBytes`, default 32 MiB) and reads the others through sixteen 64 KiB windows (`windowBytes`, new `windowCount`) instead of one 1 MiB window refilled on every jump.
- Pkt-lines decode their text only when asked, so the side-band packets of a pack are not decoded as UTF-8.
- The Node FilesApi writes a file with synchronous open, write, close and rename where its content is small, as it already reads small files: a checkout writes thousands.
