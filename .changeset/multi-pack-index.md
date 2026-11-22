---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
---

**Multi-pack-indexes as git reads and writes them, and repack and gc that keep them sound.**

```typescript
// git multi-pack-index write --bitmap: the bytes native git writes for the same packs
const written = await multiPackIndexWrite({ files, bitmap: true });
// git multi-pack-index verify / expire / repack --batch-size, with git's messages and exits
const { exitCode, stderr } = await multiPackIndexVerify({ files });
// git repack -a -d -b -m: the new pack under a midx with a midx bitmap
await repack({ ...backend, writeMidx: true, writeBitmaps: true });
```

Native git reads a midx-covered pack only through the midx, so deleting packs a midx names
leaves native fsck and `multi-pack-index verify` failing. Our repack and gc (and
`PackSet.remove`) now clear such a midx first, with its bitmaps and an incremental chain, as
git's `repack_remove_redundant_pack` does; `repack({ writeMidx })` writes the midx of the
packs that stay before anything is removed.

- vcs-core: `parseMultiPackIndex` (v1 and v2, chunks PNAM/OIDF/OIDL/OOFF/LOFF/RIDX/BTMP, git's
  refusals), `loadMultiPackIndex` (with 2.5x's `multi-pack-index.d` chain),
  `encodeMultiPackIndex` (git's entry selection, pack order, pseudo-pack order), the clear
  helpers, and `multiPackIndexBitmapPack` for midx bitmaps. The pack set uses a valid midx
  for lookups (`core.multiPackIndex`, three packs or more), falls back to the packs' own idx
  for a refused, corrupt (checksum) or stale midx (`midxErrors`), and prefers the midx's
  bitmap, refused when it names another midx. `PackFile.offsetAt`, `writePackBitmap({
  nameTags })`.
- vcs-store-files: `multiPackIndexWrite` (`--preferred-pack`, `--stdin-packs`, `--bitmap`,
  2.5x `--incremental`), `multiPackIndexVerify`, `multiPackIndexExpire`,
  `multiPackIndexRepack`, `repack({ writeMidx })`, `readPackSetSettings`.
- vcs-commands: fsck runs `multi-pack-index verify` per source (2.5x after each source's packs,
  object bit; 2.43 last, bit 040), checks the midx bitmap's checksum, and dies on a midx git
  refuses fatally.

Crafted or damaged midxes cannot cost data or crash us: `expire` checks the checksum and that
every pack still selecting objects opens before it deletes anything (git deletes the only
copies left when a midx names a missing pack), PNAM entries must be `pack-<hex>.idx` names,
incremental chains are capped and walked without recursion, a midx bitmap's `RIDX`/`BTMP` are
checked before use, and a pack-int-id out of range is git's `fatal: bad pack-int-id` in verify
and fsck while the pack set falls back to the packs; `midx.version=2` writes version 2 files as
2.5x does.
