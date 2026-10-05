# Real Repository Performance Benchmark

## What it is

A command-line benchmark that builds a small repository through the low-level `History` API of `@statewalker/vcs-core` and times each step: storing 100 blobs, writing a 100-entry tree, the first commit, 20 follow-up commits that each change 5 files, walking the commit chain, loading the last tree, reading every blob it references, and a few ref writes and reads. It uses `createMemoryHistory()`, so it measures the object and ref layers in memory, not file I/O, staging, checkout or the commands layer. It needs no network or files.

## The shape

One file, `src/main.ts`, run top to bottom:

```
createMemoryHistory(); initialize()
 1. Store blobs            100 x blobs.store()          (file-000.ts ... file-099.ts content)
 2. Create tree            trees.store(100 entries)     (flat tree, no directories)
 3. Create first commit    commits.store() + refs.set("refs/heads/main")
 4. Create 20 commits      per commit: 5 x blobs.store(), trees.store(), commits.store()
 5. Traverse history       commits.load() following parents[0] from the tip
 6. Load tree              trees.load(last tree), collect entries
 7. Load all blobs         blobs.load() and drain each entry's content
 8. Reference operations   2 x refs.set(), 3 x refs.resolve()
print table and summary
```

Every blob is the same TypeScript snippet with two appended comment lines (`// Variant N` and `// Generated: <Date.now()>`).

## How to run it

Requires Node 24 and pnpm. From the repository root:

```bash
pnpm install
pnpm --filter @statewalker/vcs-benchmark-real-repo-perf start
```

`start` runs `tsx src/main.ts`. A run takes well under a second.

## What the output means

A real run (timings vary by machine):

```
Configuration:
  Files per tree: 100
  Commits: 20

Operation                           |         Time | Details
--------------------------------------------------------------------------------
Store blobs                         |       9.93ms | 100 blobs
Create tree                         |       2.28ms | 100 entries
Create first commit                 |        534μs |
Create 20 commits                   |      42.17ms | 5 files modified each
Traverse history                    |       4.13ms | 21 commits
Load tree                           |       1.98ms | 100 entries
Load all blobs                      |       6.08ms | 100 blobs
Reference operations                |        162μs | 2 writes, 3 reads

Total benchmark time: 67.26ms
Total commits created: 21
Total blobs stored: 200
Average commit time: 2.11ms
History traversal: 4.13ms for 21 commits
```

"Create 20 commits" includes the 5 blob writes and the tree write of each commit; "Average commit time" is that total divided by 20.

## Why it is the way it is

- **Low-level API on purpose.** The benchmark talks to `history.blobs`, `trees`, `commits` and `refs` directly, so the numbers reflect object hashing, serialization and the memory store without the working tree, index or command layers on top.
- **Memory backend.** `createMemoryHistory()` removes disk variance and makes the run self-contained. To measure a persistent backend, swap the factory; the rest of the code only uses the `History` interface.
- **Sizes are constants.** `FILE_COUNT = 100` and `COMMIT_COUNT = 20` keep the run short enough to use as a smoke check; raise them in `src/main.ts` to look at scaling.

## What will surprise you

- **Each commit changes 5 files relative to the first tree, not the previous one.** The loop copies `treeEntries` (the initial tree) on every iteration, so changes do not accumulate: commit 20's tree differs from the first tree only in files 95 to 99. History is still a linear chain of 21 commits.
- **Object ids differ between runs.** Blob content embeds `Date.now()` and commits use the current time, so nothing is reproducible by id; only counts and timings are comparable.
- **Summary counts are computed, not measured.** "Total blobs stored: 200" is `FILE_COUNT + COMMIT_COUNT * 5`; "Total commits created: 21" is `COMMIT_COUNT + 1`.
- **Timings are single-shot** with no warm-up, so the first step includes JIT warm-up and small numbers move between runs.
- **No memory measurement.** The benchmark reports time only.

## Reference

### Commands

| Command | What it does |
|---------|--------------|
| `pnpm --filter @statewalker/vcs-benchmark-real-repo-perf start` | Runs `tsx src/main.ts` |
| `pnpm --filter @statewalker/vcs-benchmark-real-repo-perf typecheck` | Runs `tsc --noEmit` |

### Configuration

Edit `FILE_COUNT` and `COMMIT_COUNT` in `src/main.ts`. The number of files changed per commit (5) is hard-coded in the commit loop. There are no flags or environment variables.

### Related

- [../delta-compression/](../delta-compression/): delta algorithm benchmark
- [../pack-operations/](../pack-operations/): pack file benchmark
- [../../examples/10-custom-storage/](../../examples/10-custom-storage/): the `History` factories, including the one used here
