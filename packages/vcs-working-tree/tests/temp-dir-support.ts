import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Timeout of an `afterAll`/`afterEach` hook that removes a temporary root.
 *
 * ```ts
 * afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);
 * ```
 *
 * A root holding many fixture repositories takes seconds to remove, and much
 * longer on a loaded machine (a whole run with every worker busy): vitest's
 * default 10 s hook timeout then fails a file whose tests all passed
 * (statewalker/webrun-vcs#336). Only cleanup hooks get this timeout; the
 * global hook timeout stays as it is, so other slow hooks still show up.
 */
export const CLEANUP_TIMEOUT = 120_000;

/**
 * Removes a temporary file or directory tree, doing nothing for an empty or
 * missing path.
 *
 * The removal is asynchronous (libuv's thread pool, not a blocking `rmSync`)
 * and retries transient failures. Read-only files (loose objects, packs and
 * indexes are written 0444, by git and by ours) go with their directory, as
 * unlinking needs only the directory's write permission; a directory a test
 * left without write or search permission (simulating an unreadable one) is
 * opened up and the removal tried once more, which matters on CI, where tests
 * do not run as root.
 */
export async function removeTempDir(path: string | undefined | null): Promise<void> {
  if (!path) return;
  try {
    await removeTree(path);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await openUpDirectories(path);
    await removeTree(path);
  }
}

function removeTree(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function isPermissionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

async function openUpDirectories(path: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch {
    return;
  }
  if (!stats.isDirectory()) return;
  await chmod(path, 0o700).catch(() => {});
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    return;
  }
  for (const name of names) await openUpDirectories(join(path, name));
}
