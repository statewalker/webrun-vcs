import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { giteaCacheDir } from "./env.js";
import { type GiteaRelease, giteaRelease } from "./release.js";

const run = promisify(execFile);

/** The SHA-256 of a file, streamed (the binary is about 143 MB). */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const octal = (mode: number) => (mode & 0o777).toString(8).padStart(3, "0");

/**
 * Throws unless `path` is a real directory (not a symlink) owned by the
 * current user and writable by no one else: nobody else may swap a cached
 * binary between its hash check and its use. A no-op where there are no uids.
 */
export async function assertPrivateDir(path: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const st = await lstat(path);
  if (!st.isDirectory())
    throw new Error(`Gitea cache ${path} is not a directory (a symlink or a file)`);
  if (st.uid !== uid)
    throw new Error(`Gitea cache ${path} belongs to uid ${st.uid}, not to this user (${uid})`);
  if (st.mode & 0o022)
    throw new Error(`Gitea cache ${path} is writable by group or others (mode ${octal(st.mode)})`);
}

/** As {@link assertPrivateDir}, for a regular file. */
async function assertPrivateFile(path: string): Promise<void> {
  const uid = process.getuid?.();
  const st = await lstat(path);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (uid === undefined) return;
  if (st.uid !== uid) throw new Error(`${path} belongs to uid ${st.uid}, not ${uid}`);
  if (st.mode & 0o022) throw new Error(`${path} is writable by group or others`);
}

/**
 * Copies `source` to `dest` (a new file in a private directory) and hashes
 * the copy: the bytes that will run are the bytes that were checked. A copy
 * that does not match is removed and this throws.
 */
export async function copyVerified(source: string, dest: string, sha256: string): Promise<void> {
  await copyFile(source, dest);
  const got = await fileSha256(dest);
  if (got !== sha256) {
    await rm(dest, { force: true });
    throw new Error(`${dest}: SHA-256 ${got}, expected ${sha256}`);
  }
  await chmod(dest, 0o700);
}

export interface GiteaBinaryOptions {
  /** The release to use (default: the pinned one for this platform) */
  release?: GiteaRelease;
  /** Where verified binaries are kept (default: {@link giteaCacheDir}) */
  cacheDir?: string;
  /**
   * A local copy of the binary to take instead of downloading it (default:
   * `GITEA_BIN`). It must still have the pinned SHA-256.
   */
  source?: string;
  /** Download time limit (default 5 minutes) */
  downloadTimeoutMs?: number;
}

/** Downloads with curl: it follows the environment's proxy settings, which Node's fetch does not. */
async function download(url: string, dest: string, timeoutMs: number): Promise<void> {
  await run("curl", ["-sSfL", "--retry", "3", "--connect-timeout", "30", "-o", dest, url], {
    timeout: timeoutMs,
  });
}

/**
 * The path of a verified Gitea binary, kept in the cache directory as
 * `<cacheDir>/gitea-<version>-<platform>`. The directory must be private to
 * the current user ({@link assertPrivateDir}); a new one is made with mode
 * 0700. A cached binary is hashed on every call; a missing or altered one is
 * fetched again (copied from `source` / `GITEA_BIN`, else downloaded from
 * dl.gitea.com) into a private temporary directory, must match the pinned
 * SHA-256, and is renamed into place, so parallel test files do not race.
 *
 * `startGitea` does not run this path: it copies the binary into its own
 * private work directory and hashes that copy again ({@link copyVerified}).
 */
export async function ensureGiteaBinary(opts: GiteaBinaryOptions = {}): Promise<string> {
  const release = opts.release ?? giteaRelease();
  const dir = opts.cacheDir ?? giteaCacheDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertPrivateDir(dir);
  const bin = join(dir, release.fileName);
  const valid = async () => {
    try {
      await assertPrivateFile(bin);
    } catch {
      return false;
    }
    return (await fileSha256(bin)) === release.sha256;
  };
  if (await valid()) return bin;

  const staging = await mkdtemp(join(dir, ".fetch-"));
  const tmp = join(staging, release.fileName);
  try {
    const source = opts.source ?? process.env.GITEA_BIN;
    if (source) {
      await copyFile(source, tmp);
      // a copy keeps its source's owner: make it ours
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      if (uid !== undefined && gid !== undefined) await chown(tmp, uid, gid);
    } else {
      await download(release.url, tmp, opts.downloadTimeoutMs ?? 300_000);
    }
    const got = await fileSha256(tmp);
    if (got !== release.sha256)
      throw new Error(
        `${release.fileName}: SHA-256 ${got}, expected ${release.sha256} (from ${source ?? release.url})`,
      );
    await chmod(tmp, 0o700);
    await rename(tmp, bin);
  } catch (e) {
    // another writer may have put a valid binary in place meanwhile
    if (!(await valid()))
      throw new Error(`cannot obtain Gitea ${release.version}: ${(e as Error).message}`, {
        cause: e,
      });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return bin;
}
