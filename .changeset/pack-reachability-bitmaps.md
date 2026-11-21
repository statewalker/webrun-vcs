---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-core": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

**Pack reachability bitmaps (`.bitmap` v1), read, used and written as git does.**

- **vcs-utils:** `EwahBitmap` (git's `ewah/`: 64-bit words held as two halves, run-length words, `ewah_set`/`ewah_add`/`ewah_xor` in git's exact buffer layout, JavaEWAH serialization) and `RawBitmap` (git's uncompressed `struct bitmap`, `bitmap_to_ewah`).
- **vcs-working-tree:** the untracked cache and split index use the shared `EwahBitmap` (`Ewah` is now an alias of it).
- **vcs-core:** `parsePackBitmap` reads a pack's bitmap (header and options, type bitmaps, XOR-compressed entries, lookup table, name-hash cache), checks its trailing SHA-1 and pack checksum, and refuses a damaged file with git's message (`PackBitmapError`); `PackSet.bitmap()` loads the first usable one (`bitmapErrors` holds git's error lines). `bitmapWalk` enumerates wants minus haves through it (unbitmapped tips walked down to bitmapped commits, objects outside the pack in an extended index, the `blob:none`, `tree:0` and `object:type` filters), and `listObjects({ bitmap })` and `exportPack` (`useBitmaps`, git's `pack.useBitmaps`) use it. `writePackBitmap` writes git's file byte for byte: `bitmap_writer_select_commits`' selection, the XOR choice of `compute_xor_offsets`, 2.5x's or 2.43's entry order, the lookup table and name-hash cache. `PackFile` gains `packOrder()`, `idAt()` and `indexOf()`; `PackObjectRef` and `ListedObject` take a `nameHash`.
- **vcs-transport:** `createRepositoryFacade({ useBitmaps })`.
- **vcs-store-files:** `repack({ writeBitmaps })` (`git repack -b`, `repack.writeBitmaps`, git's default of writing for `-a` in a bare repository, `pack.writeBitmapHashCache`, `pack.writeBitmapLookupTable`, `pack.preferBitmapTips`) writes the new pack's bitmap through a temporary file, drops a stale one, refuses `-b` without `-a` (`IncrementalBitmapError`) and warns as git when alternates keep objects out; `gc` writes one in a bare repository.
- **vcs-commands:** fsck verifies bitmap checksums as each git version does (`verify_bitmap_files`); served repositories honour `pack.useBitmaps`; push passes `setUseBitmaps` on.
- **Fixes after review:** name hashes are git's `pack_name_hash` over the path's bytes (non-ASCII and non-UTF-8 names, only git's isspace bytes skipped), trees and blobs named by refs are listed as git's pending objects (named "", before the commits' trees; `listObjects({ tipPaths })` names index entries and cache-tree nodes), the plain walk marks only edge trees uninteresting, `pack.preferBitmapTips` is matched as each version does (`isPreferredBitmapTip`), `repack.packKeptObjects` and `push.useBitmaps` are read and local transports pass the remote's `pack.useBitmaps`, a bitmap the new pack cannot close fails the repack before anything is replaced (`BitmapWriteError`), the bitmap is not used when no have is in its pack, and bitmaps claiming more objects than their pack are refused (stray bits ignored).
