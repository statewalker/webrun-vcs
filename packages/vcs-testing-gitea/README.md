# @statewalker/vcs-testing-gitea

A real Gitea server as an oracle for our clients. Our smart HTTP client (`vcs-transport`) and our Git LFS client (`vcs-transport-lfs`) are tested against native git and our own servers elsewhere; here they meet a production forge, which makes its own choices about authentication, URL shapes, batch answers and ranges. This package is private test infrastructure: Node-only, never published.

## Running the oracle locally

```sh
pnpm install
pnpm -r build                                   # the tests import the built transports
cd packages/vcs-testing-gitea
GITEA=1 pnpm test                               # or: pnpm test:oracle
```

The first run downloads Gitea 1.22.6 (about 143 MB) from dl.gitea.com, checks it against its published SHA-256 and keeps it. Later runs hash the cached binary again and reuse it. Both test files start their own Gitea, so a run takes about ten seconds once the binary is cached.

Without `GITEA=1` the oracle tests are skipped: `pnpm test` at the root runs only the unit tests of the configuration. With `GITEA=1` a Gitea that cannot be downloaded, verified or started fails the run rather than skipping it. Native `git` and `git-lfs` must be installed.

| Variable | Meaning |
|---|---|
| `GITEA=1` | Run the oracle tests (also `true`) |
| `GITEA_CACHE_DIR` | Where verified binaries are kept, named `gitea-<version>-<platform>`. Default: `<os temp>/webrun-vcs-gitea-cache` |
| `GITEA_BIN` | A local copy of the binary to take instead of downloading. It must still match the pinned SHA-256 |

Binaries are pinned for linux-amd64, linux-arm64 and macOS (amd64, arm64). Only linux-amd64 runs in CI.

### As root

Gitea refuses to run as root. When the tests run as root (a container, a sandbox), the helper runs Gitea as `nobody` through `runuser`, with its work directory owned by `nobody`. If `nobody` cannot reach the cached binary (a cache under a private directory of root), Gitea runs from a copy in its work directory. Gitea's own root override is not used. As an ordinary user, as in CI, Gitea runs directly.

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

`startGitea()` writes an `app.ini` (SQLite, LFS on, offline, no SSH, registration off, a free port on 127.0.0.1) into a fresh temporary work directory, runs `gitea migrate`, creates an admin with `gitea admin user create`, starts `gitea web` in its own process group and waits until `/api/v1/version` answers with the pinned version. It then creates an API token through the API. A start that fails, say because the port was taken in the meantime, is retried on another port, and the error carries the tail of Gitea's log.

The server gives the admin's `user`, `password`, `token` and `authorization` (`Basic …`), and a `fetch` that adds those credentials when a request has none. `stop()` sends SIGTERM to the process group, SIGKILL after ten seconds, and removes the work directory. A process that exits without stopping its servers kills them on the way out.

The pure pieces (`giteaAppIni`, `giteaCommand`, `giteaRelease`, `giteaOracleEnabled`, `giteaCacheDir`) are exported for tests of their own; `tests/config.test.ts` covers them without a binary.

## What the oracle checks

| # | Check |
|---|---|
| G1 | `httpFetch` clones a repository native git pushed (refs, tags and every commit equal), then fetches only the new commit. `httpPush` with the token as password lands commits that a native `git clone` reads back and `fsck --strict` accepts, and a fast-forward on top. Without credentials, fetch and push of a private repository are a 401. |
| G2 | A commit with `.gitattributes` and an LFS pointer: `lfsUpload` sends the object (batch, PUT, Gitea's verify action) and `httpPush` the commit. A native `git clone` with git-lfs smudges the 3 MiB file byte-identical and `git lfs fsck` is clean. A second upload sends nothing. |
| G3 | A file native git-lfs pushed: an anonymous batch is a 401; `lfsDownload` stores it byte-identical. A download cut after 1 MiB resumes with `Range: bytes=N-`, Gitea answers 206, and the bytes over both attempts add up to the size. |
| G4 | A missing object is Gitea's per-object 404 (our error says not found). Bytes altered in transit are refused (`sha256 mismatch`) and nothing is kept. Gitea itself refuses a PUT whose bytes do not hash to their oid with 422. |

Two Gitea behaviours shape our client, and the oracle pins both. Gitea's LFS actions carry `Authorization` with a capital A: the client merges its own `authorization` with them by name, case-insensitively, or `fetch` sends the two joined by a comma and Gitea answers 401 to every transfer (reverting the merge fails G2 to G4). And Gitea 1.22 reports the total in `Content-Range` as size minus start (`bytes 1048576-4194303/3145728`), so the client reads only the start.

## In CI

`.github/workflows/gitea-oracle.yml` runs the oracle weekly, by hand (`workflow_dispatch`), and on pull requests that change `vcs-transport/src`, `vcs-transport-lfs/src` or this package. The binary is cached with `actions/cache`, keyed by the Gitea version. To move to another Gitea version, update `GITEA_VERSION` and every hash in `src/release.ts` (from the `.sha256` files next to each binary on dl.gitea.com) and the version in the workflow.
