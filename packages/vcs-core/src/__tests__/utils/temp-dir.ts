import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const activeTempDirs = new Set<string>();

/**
 * Create a temporary directory for testing.
 */
export async function createTempDir(prefix = "vcs-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  activeTempDirs.add(dir);
  return dir;
}

/**
 * Clean up a temporary directory.
 */
export async function cleanupTempDir(dir: string): Promise<void> {
  if (activeTempDirs.has(dir)) {
    await rm(dir, { recursive: true, force: true });
    activeTempDirs.delete(dir);
  }
}

/**
 * Clean up all temporary directories.
 * Call this in afterAll() or test cleanup hooks.
 */
export async function cleanupAllTempDirs(): Promise<void> {
  const promises = Array.from(activeTempDirs).map((dir) =>
    rm(dir, { recursive: true, force: true }).catch(() => {}),
  );
  await Promise.all(promises);
  activeTempDirs.clear();
}

/**
 * Create a git-initialized temp directory.
 */
export async function createTempGitDir(): Promise<string> {
  const dir = await createTempDir("vcs-git-test-");
  // Initialize as bare git repo structure
  await mkdir(join(dir, "objects"));
  await mkdir(join(dir, "objects", "pack"));
  await mkdir(join(dir, "refs"));
  await mkdir(join(dir, "refs", "heads"));
  await mkdir(join(dir, "refs", "tags"));

  // Create HEAD file
  await writeFile(join(dir, "HEAD"), "ref: refs/heads/main\n");

  // Create minimal config
  await writeFile(
    join(dir, "config"),
    `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
`,
  );

  return dir;
}

/**
 * Helper for tests that need temp directory.
 */
export function withTempDir(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = await createTempDir();
    try {
      await fn(dir);
    } finally {
      await cleanupTempDir(dir);
    }
  };
}
