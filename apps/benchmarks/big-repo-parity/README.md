# Big-repository parity

A prototype that takes a large real repository (git.git itself), puts it into one webrun-vcs
storage backend, and checks that everything we read back, write and export is exactly what native
git has. It also runs our porcelain commands on a git.git checkout and compares their output with
native git's, byte for byte. Along the way it times each step, so the same run tells you both
"is it correct" and "how slow is it".

This is a prototype on a side branch, not for merging. The numbers below come from one run on a
4-core cloud VM (16 GB RAM, Node 22.23, native git 2.43.0, RustFS 1.0.6 in Docker), recorded on
2026-11-25.

## Quick start

```bash
# 1. the source repository
git clone --bare https://github.com/git/git.git /data/git.git

# 2. S3 storage, for the s3 backend
docker run -d --name rustfs -p 9000:9000 \
  -e RUSTFS_ACCESS_KEY=rustfsadmin -e RUSTFS_SECRET_KEY=rustfsadmin \
  -e RUSTFS_VOLUMES=/data rustfs/rustfs:latest

# 3. build the packages once (the scripts load packages/*/dist)
pnpm install && pnpm -r --filter './packages/*' build

# 4. storage backends: fsbare, s3, sqlite
cd apps/benchmarks/big-repo-parity
node --max-old-space-size=8192 scripts/parity.mjs fsbare /data/work-fsbare /data/git.git
node --max-old-space-size=8192 scripts/parity.mjs s3     /data/work-s3     /data/git.git

# 5. porcelain commands on a worktree
node --max-old-space-size=8192 scripts/worktree.mjs /data/work-wt /data/git.git
```

Each run prints one line per step and writes `results-<backend>.json` into its work directory.
`--steps load,refs,...` runs a subset; the data stays in the backend between runs, so after one
`load` you can repeat any other step. The S3 endpoint and keys default to the RustFS values above
and can be changed with `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`; the repository lives in
bucket `vcs` under the prefix `S3_PREFIX` (default: the work directory's name).

## How the storage test works

`scripts/parity.mjs <backend> <work-dir> <source.git>` opens one backend and runs seven steps.
Every step compares with native git run on the source repository, so nothing is checked against
our own code.

| Step | What we do | What native git says |
|---|---|---|
| `load` | `importPack` of the source's pack file, then every ref and HEAD written through `refs` | (the source itself) |
| `refs` | list every ref and resolve HEAD | `for-each-ref` |
| `walk` | `commits.walkAncestry` from every ref's commit; tree and parents of every 997th commit | `rev-list --all`, `show -s --format=%T %P` |
| `trees` | recursive tree listing of three tags (newest, v2.30.0, v1.7.0) | `ls-tree -r` |
| `blobs` | read every file of the newest tag and SHA-1 it | the ids `ls-tree` gave |
| `write` | store a blob, a tree and a commit through the History API | the same commit built with `hash-object`, `write-tree`, `commit-tree` must get the same id |
| `roundtrip` | `exportPack` of every ref plus the new commit | `index-pack` of our pack into an empty repository, `fsck --strict`, `rev-list --objects --all --count` |

The roundtrip is the strongest check. Native git re-hashes every object we send, so one wrong
byte anywhere in 425 thousand objects fails it. git.git's own history does not pass
`fsck --strict` (99 warnings: zero-padded tree modes, tags without a tagger from 2005), so the
step passes when our pack's fsck output equals the source's.

The backends:

- **fsbare**: `vcs-store-files` over the Node FilesApi, a bare repository on local disk.
- **s3**: `vcs-store-files` over `S3FilesApi` (`@statewalker/webrun-files-s3`) against RustFS. Bare only:
  the worktree needs POSIX calls (`lstat`, modes) that S3 has no answer for. Each step also
  reports how many S3 requests it made.
- **sqlite**: `vcs-store-sql` over `node:sqlite` with a file on disk (WAL). The SQL store had
  only the in-memory sql.js adapter, so the script has a small `DatabaseClient` for `node:sqlite`.

## How the worktree test works

`scripts/worktree.mjs <work-dir> <source.git>` makes two clones of the source, ours with our
`clone` (no local shortcut, so the whole pack goes through fetch and index-pack) and one with
native `git clone --no-local`, then does the same thing in both:

| Step | What is compared |
|---|---|
| `clone` | refs and `ls-files -s` equal; native `status` in our clone is clean; native `fsck` passes |
| `status` | edit two files, delete one, add untracked files: `status --porcelain` and long status equal |
| `log` | `log --oneline -n 5000`, `log --stat -n 200`, `log -p -n 30 -- Makefile`, as bytes |
| `diff` | `diff --stat` and `-p` for v2.40.0..v2.41.0 and v2.0.0..v2.30.0 (1.2 million lines), as bytes |
| `checkout` | v2.30.0, v1.7.0, master: native `status` clean, HEAD and `write-tree` equal the target |
| `commit` | the same edit committed by both: same commit id, same reflog line |
| `gc` | our `gc --prune=now`, then native `fsck` and the object count; native `gc` for timing |

Output is compared as bytes. git.git has commits with Latin-1 author names; our `callText` keeps
such bytes as U+DC80..U+DCFF escapes and Node decodes native output to U+FFFD, so text comparison
would report false differences. The script compares `callBytes` with native stdout instead.

## Results: git.git

The source: 425,249 objects, 86,440 commits, 1,027 refs, a 325 MB pack (git.git master on
2026-11-23).

| Step | fsbare | s3 (RustFS) | sqlite | native git |
|---|---|---|---|---|
| load (import 425k objects) | 38.8 s | 538.5 s, 176,482 requests | fails | index-pack 14.1 s (1 thread: 33.9 s) |
| refs (1,027) | 0.06 s | 3.0 s, 2,065 requests | | |
| walk (86,440 commits) | 2.7 s | 4.7 s, 562 requests | | rev-list 0.65 s |
| trees (3 tags, 10,479 entries) | 0.09 s | 0.9 s | | |
| blobs (4,741 files, 45 MB) | 0.5 s | 1.8 s | | |
| write (commit, same id as native) | 0.07 s | 0.25 s | | |
| export (313 MB pack, 425,252 objects) | 24.2 s | 92.0 s, 20,907 requests | | pack-objects 6.8 s |
| fsck of the export equals native's | yes | yes | | |
| peak memory | 1.1 GB | 1.0 GB | | |

Every comparison passed on fsbare and s3. SQLite stops in `load`, see the findings.

Our porcelain commands on a git.git checkout (ours / native):

| Step | Result | Ours | Native |
|---|---|---|---|
| clone, no local shortcut, with checkout | equal | 147.8 s, 1.3 GB | 30.9 s |
| status after edits | equal | under 1 s | |
| log --oneline -n 5000 | equal | 0.42 s | 0.08 s |
| log --stat -n 200 | equal | 0.34 s | 0.11 s |
| log -p -n 30 -- Makefile | equal | 0.09 s | 0.03 s |
| diff --stat v2.0.0 v2.30.0 | equal | 1.7 s | 0.7 s |
| diff -p v2.0.0 v2.30.0 (1.2M lines) | equal | 2.4 s | 1.0 s |
| checkout v2.30.0 / v1.7.0 / master | equal | 3.1 / 2.3 / 3.5 s | |
| commit | same id | 0.4 s | |
| gc --prune=now | fsck ok, 425,253 objects kept | 74.2 s | 7.5 s |

The clone and gc rows ran while other tests used the same 4 cores, so treat them as rough; the
log and diff rows were measured on their own.

## Results: a synthetic history, all three backends

SQLite cannot hold git.git, so to compare the three backends on the same data the same script
runs on a repository made by `scripts/bench-clone.mjs` (repository root): 20,000 commits editing
2,000 files, 178,403 objects, a 32 MB pack, UTF-8 only.

| Step | fsbare | s3 (RustFS) | sqlite | native git |
|---|---|---|---|---|
| load | 2.5 s | 5.0 s, 936 requests | 150.7 s | index-pack 1.9 s |
| walk (20,000 commits) | 0.39 s | 0.54 s | 1.6 s | |
| blobs (2,000 files) | 0.16 s | 0.41 s | 0.16 s | |
| export | 3.3 s (27 MB pack) | 3.7 s | 123.4 s (12 MB pack) | pack-objects 1.0 s |
| storage size | 33 MB | | 547 MB | 32 MB |
| every comparison | passed | passed | passed | |

## What we learned

**fsbare and s3 hold git.git exactly.** Every ref, commit, tree and file read back equals native
git's, a commit we write gets native git's id, and the 313 MB pack we export passes native
`index-pack` and `fsck` with the source's own warnings and nothing else. Our commands give
byte-identical `status`, `log`, `diff`, `checkout` and `commit` results on a git.git checkout, and
native git finds our clone and our gc'd repository sound.

**The SQL backend cannot store git.git.** Its stores parse objects into rows, so an object whose
bytes the rows cannot reproduce is refused. The first is commit 7eb93c89 (2005): the author's name
is Latin-1 ("David K\xe5gedal"), not UTF-8, and the row keeps it as text
(`ObjectIdMismatchError: ... would keep e863b60b...`). The import stops there; `scripts/sql-census.mjs`
stores every commit, tree and tag one at a time instead and reads each back. Of git.git's 257,624
non-blob objects, 137 commits come back changed: 134 lose their `mergetag` header, 2 their
non-UTF-8 bytes, 1 an unknown `change-id` header. Every tree and tag survives. The loss is in the
typed commit model (no extra headers, text decoded with U+FFFD), and `importObject` returns the
changed object's id without an error (statewalker/webrun-vcs#399). On clean data it is correct but slow: 60 times
slower to import and 37 times slower to export than fsbare, and 17 times larger on disk
(547 MB for a 32 MB pack).

**S3 is correct, but the import makes one request per few objects.** git.git takes 176 thousand
requests and nine minutes to import, the synthetic pack (a tenth of git.git's size) 936 requests
and five seconds. The likely cause, not yet confirmed, is delta resolution reading bases back
from the pack in 64 KiB windows, one range request each, which git.git's deep delta chains
exercise far more. Listing refs makes two requests per ref (2,065 for 1,027 refs).

**Speed against native git**: on local disk our import is 2.7 times slower than native
`index-pack` (14.1 s, multithreaded; about equal to its one-thread 33.9 s), the export 3.6 times,
the commit walk 4 times, log and diff 2 to 5 times, clone 4.8 times and gc 10 times. Memory stays
near 1 GB for the largest steps.

**Pitfalls in the test setup, not in webrun-vcs.** s3rver, the pure-JavaScript S3 stand-in we
tried first, cannot parse a fully URL-encoded `CopySource` (RustFS and S3 can) and needs Node's
legacy OpenSSL provider. A shallow clone is a poor source: our files backend reads
`.git/shallow` only together with replace refs or grafts, so its walk reaches one parent more
than native `rev-list`.
