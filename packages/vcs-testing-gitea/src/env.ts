import { homedir } from "node:os";
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
 * Where verified binaries are kept: `GITEA_CACHE_DIR`, else a per-user
 * directory, `$XDG_CACHE_HOME/webrun-vcs-gitea` or
 * `~/.cache/webrun-vcs-gitea`. Never a shared directory such as the system
 * temp: the directory must belong to the current user and be writable by no
 * one else (`ensureGiteaBinary` refuses it otherwise). Binaries are named by
 * version and platform, so one directory can hold several versions.
 */
export function giteaCacheDir(env: Env = process.env, home: string = homedir()): string {
  const dir = env.GITEA_CACHE_DIR?.trim();
  if (dir) return dir;
  const xdg = env.XDG_CACHE_HOME?.trim();
  return join(xdg ? xdg : join(home, ".cache"), "webrun-vcs-gitea");
}
