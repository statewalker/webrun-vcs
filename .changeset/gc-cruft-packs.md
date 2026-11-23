---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
---

**gc writes cruft packs, git 2.37+'s default, instead of loosening unreachable objects.**

- **gc:** with `gc.cruftPacks` true (the default; `GcOptions.cruftPacks`), the unreachable objects of the packs gc replaces and the unreachable loose objects go into a cruft pack (`.pack`, `.idx`, `.mtimes`, and `.rev` under `pack.writeReverseIndex`), as `git gc` runs `git repack --cruft --cruft-expiration=<gc.pruneExpire>`. Each object keeps the newest time of its copies (a loose file's mtime, its pack's mtime, an older cruft pack's `.mtimes`); objects not newer than the grace period are dropped unless a newer unreachable object reaches them, and those are kept with the expiration as their time. `gc.maxCruftSize` / `GcOptions.maxCruftSize` splits them into packs no larger (at least 1 MiB, as git). `--prune=now` (`pruneExpireMs: 0`) writes no cruft pack, as git runs `repack -a` then; `gc.cruftPacks=false` keeps the previous behaviour (`repack -A`, objects written loose). `gc.pruneExpire` is now read from the config when `pruneExpireMs` is not given (`never` keeps everything). `RepackResult.cruftPacks`/`cruftObjects` name what was written.
- **Loose prune:** the unreachable loose objects older than the grace period are kept when a younger unreachable object reaches them, as `git prune` marks recent objects' closure.
- **repack:** `repack({ cruft, cruftExpiration, maxCruftSize })` is `git repack --cruft [--cruft-expiration] [--max-cruft-size]`.
- **vcs-core:** `installPack({ mtimes })` writes `pack-<id>.mtimes` (renamed into place after the `.rev`, before the `.idx`; replaced when the same pack is installed again); `encodePackMtimes`, `parsePackMtimes`, `PackMtimesError`.
