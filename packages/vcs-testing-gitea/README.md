# @statewalker/vcs-testing-gitea

A real Gitea server as an oracle for our clients. Our smart HTTP client (`vcs-transport`) and our Git LFS client (`vcs-transport-lfs`) are tested against native git and our own servers elsewhere; here they meet a production forge, which makes its own choices about authentication, URL shapes, batch answers and ranges. This package is private test infrastructure: Node-only, never published.

## Running the oracle locally

```sh
pnpm install
pnpm -r build                                   # the tests import the built transports
cd packages/vcs-testing-gitea
GITEA=1 pnpm test                               # or: pnpm test:oracle
```

The first run downloads Gitea 1.22.6 (about 143 MB) from dl.gitea.com, checks it against its published SHA-256 and keeps it. Later runs hash the cached binary again and reuse it. Each oracle test file starts its own Gitea, so a run takes about twenty seconds once the binary is cached.

Without `GITEA=1` the oracle tests are skipped: `pnpm test` at the root runs only the unit tests of the configuration. With `GITEA=1` a Gitea that cannot be downloaded, verified or started fails the run rather than skipping it. Native `git` and `git-lfs` must be installed.

| Variable | Meaning |
|---|---|
| `GITEA=1` | Run the oracle tests (also `true`) |
| `GITEA_CACHE_DIR` | Where verified binaries are kept, named `gitea-<version>-<platform>`. Default: `$XDG_CACHE_HOME/webrun-vcs-gitea`, else `~/.cache/webrun-vcs-gitea` |
| `GITEA_BIN` | A local copy of the binary to take instead of downloading. It must still match the pinned SHA-256 |

Binaries are pinned for linux-amd64, linux-arm64 and macOS (amd64, arm64). Only linux-amd64 runs in CI.

### Where the bytes come from

The cache directory must be private: a real directory (not a symlink), owned by the current user and writable by no one else. The helper makes a new one with mode 0700 and refuses any other, so no one can swap the binary between its check and its use. Downloads land in a private temporary directory inside the cache and are renamed into place only once they match. A cached binary that others could write is fetched again.

Gitea never runs from the cache. Each instance copies the binary into its own work directory (mode 0700, made with `mkdtemp`), hashes that copy again and runs it. Its `app.ini` is mode 0600, and its admin password is random, so instances started side by side cannot be mistaken for each other.

### As root

Gitea refuses to run as root. When the tests run as root (a container, a sandbox), the helper runs Gitea as `nobody` through `runuser`, with its work directory (still 0700) owned by `nobody`. Gitea's own root override is not used. As an ordinary user, as in CI, Gitea runs directly.

## Using the helper

```ts
import { startGitea } from "@statewalker/vcs-testing-gitea";

const gitea = await startGitea(); // downloads or reuses the binary, then starts it
const repo = await gitea.createRepo("demo"); // private, empty, default branch main

await httpPush(repo.cloneUrl, facade, refStore, {
  refspecs: ["refs/heads/main:refs/heads/main"],
  credentials: { username: gitea.user, password: gitea.token },
});
lfsUpload(store, repo.lfsUrl, pointers, fetch, { headers: { authorization: gitea.authorization } });
execFileSync("git", ["clone", repo.authenticatedUrl, dir]); // native git, with credentials in the URL

await gitea.stop(); // in afterAll
```

`startGitea()` writes an `app.ini` (SQLite, LFS on, offline, no SSH, registration off, a free port on 127.0.0.1) into a fresh private work directory, runs `gitea migrate`, creates an admin with a random password, starts `gitea web` in its own process group and waits until `/api/v1/version` answers with the pinned version, its process is still alive, and `/api/v1/user` accepts this instance's password. It then creates an API token through the API. A start that fails, say because another server took the port in the meantime and this Gitea could not bind it, is retried on another port (three attempts within 240 s in all, below the tests' 600 s hook timeout together with the 300 s download limit), and the error carries the tail of Gitea's log.

The server gives the admin's `user`, `password`, `token` and `authorization` (`Basic …`), a `fetch` that adds those credentials when a request has none, its `workDir` and its process group `pid`. `stop()` sends SIGTERM to the process group, SIGKILL after ten seconds, and removes the work directory. A process that exits, or is ended by SIGTERM, SIGINT or SIGHUP, without stopping its servers kills their process groups and removes their work directories on the way out, then ends by the same signal. Only a SIGKILL of the test process itself leaves them behind.

The pure pieces (`giteaAppIni`, `giteaCommand`, `giteaRelease`, `giteaOracleEnabled`, `giteaCacheDir`) are exported for tests of their own; `tests/config.test.ts` covers them without a binary.

## What the oracle checks

| # | Check |
|---|---|
| G1 | The transport's `fetch` clones a repository native git pushed (refs, tags and every commit equal), then fetches only the new commit (haves sent; the pack holds exactly `git rev-list --objects old..new`). `httpPush` with the token as password lands commits that a native `git clone` reads back and `fsck --strict` accepts, and a fast-forward on top. Without credentials, fetch and push of a private repository are a 401. |
| G2 | A commit with `.gitattributes` and an LFS pointer: `lfsUpload` sends the object (batch, PUT, Gitea's verify action) and `httpPush` the commit. A native `git clone` with git-lfs smudges the 3 MiB file byte-identical and `git lfs fsck` is clean. A second upload sends nothing. |
| G3 | A file native git-lfs pushed: an anonymous batch is a 401; `lfsDownload` stores it byte-identical. A download cut after 1 MiB resumes with `Range: bytes=N-`, Gitea answers 206, and the bytes over both attempts add up to the size. |
| G4 | A missing object is Gitea's per-object 404 (our error says not found). Bytes altered in transit are refused (`sha256 mismatch`) and nothing is kept. Gitea itself refuses a PUT whose bytes do not hash to their oid with 422. |
| G5 | The File Locking API (on whenever Gitea serves LFS): `lfsLocks` as the admin and as a second user with write access. A lock is created (201), the same path again is a 409 carrying the existing lock, listing by path, by id and page by page finds every lock, `verifyLocks` splits them into ours and theirs by owner, an unlock of someone else's lock without `force` is refused and leaves it in place, `force` takes it, and the owner unlocks their own. Anonymous listing of a private repository is a 401. |

Two Gitea 1.22 locking quirks are pinned loosely in G5, so a fixed Gitea still passes: its list cursor is a page number that starts at 0 while its pages are 1-based, so following `next_cursor` returns the first page twice (our `allLocks` drops locks it has already seen, by id, so G5 sees each lock once); and an unlock of another user's lock without `force` is a 500 ("unable to delete lock") rather than the spec's 403.

Two Gitea behaviours shape our client, and the oracle pins both. Gitea's LFS actions carry `Authorization` with a capital A: the client merges its own `authorization` with them by name, case-insensitively, or `fetch` sends the two joined by a comma and Gitea answers 401 to every transfer (reverting the merge fails G2 to G4). And Gitea 1.22 reports the total in `Content-Range` as size minus start (`bytes 1048576-4194303/3145728`), so the client reads only the start.

## In CI

`.github/workflows/gitea-oracle.yml` runs the oracle weekly, by hand (`workflow_dispatch`), and on pull requests that change the sources of `vcs-transport`, `vcs-transport-lfs`, `vcs-core`, `vcs-utils` or `vcs-utils-node`, this package, or the lockfile and workspace file. The binary is kept in `~/.cache/webrun-vcs-gitea` with `actions/cache/restore` and `actions/cache/save`, under a key derived from `src/release.ts`; it is saved even when the tests fail. To move to another Gitea version, update `GITEA_VERSION` and every hash in `src/release.ts` (from the `.sha256` files next to each binary on dl.gitea.com); the cache key follows.

`tests/lifecycle.test.ts` (also behind `GITEA=1`) checks the helper itself: instances started together reject each other's credentials and keep private work directories, a start on a port another Gitea holds retries elsewhere, and a child process ended by SIGTERM or SIGINT leaves no Gitea and no work directory.
