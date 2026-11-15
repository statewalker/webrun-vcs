import { tmpdir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/**
 * Whether the Gitea oracle tests run: `GITEA=1` (or `true`). Otherwise they
 * are skipped. When they run, a Gitea that cannot be obtained or started is a
 * failure, never a skip.
 */
export function giteaOracleEnabled(env: Env = process.env): boolean {
  const v = env.GITEA?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Where verified binaries are kept: `GITEA_CACHE_DIR`, else
 * `<os temp>/webrun-vcs-gitea-cache`. Binaries are named by version and
 * platform, so one directory can hold several versions.
 */
export function giteaCacheDir(env: Env = process.env): string {
  const dir = env.GITEA_CACHE_DIR?.trim();
  return dir ? dir : join(tmpdir(), "webrun-vcs-gitea-cache");
}
