import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, chown, copyFile, mkdir, rename, rm } from "node:fs/promises";
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
  /** Download time limit (default 10 minutes) */
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
 * `<cacheDir>/gitea-<version>-<platform>`. A cached binary is hashed before
 * every use; a missing or altered one is fetched again (copied from `source` /
 * `GITEA_BIN`, else downloaded from dl.gitea.com) and must match the pinned
 * SHA-256, or this throws. Each writer fetches into a name of its own and
 * renames it into place, so parallel test files do not race.
 */
export async function ensureGiteaBinary(opts: GiteaBinaryOptions = {}): Promise<string> {
  const release = opts.release ?? giteaRelease();
  const dir = opts.cacheDir ?? giteaCacheDir();
  const bin = join(dir, release.fileName);
  const valid = async () => existsSync(bin) && (await fileSha256(bin)) === release.sha256;
  if (!(await valid())) {
    // world-readable: as root, Gitea runs as `nobody`, which must be able to execute it
    await mkdir(dir, { recursive: true, mode: 0o755 });
    const tmp = `${bin}.${process.pid}.${randomUUID()}.part`;
    try {
      const source = opts.source ?? process.env.GITEA_BIN;
      if (source) {
        await copyFile(source, tmp);
        // a copy keeps its source's owner: make it ours, so no one else can rewrite it
        const uid = process.getuid?.();
        const gid = process.getgid?.();
        if (uid !== undefined && gid !== undefined) await chown(tmp, uid, gid);
      } else {
        await download(release.url, tmp, opts.downloadTimeoutMs ?? 600_000);
      }
      const got = await fileSha256(tmp);
      if (got !== release.sha256)
        throw new Error(
          `${release.fileName}: SHA-256 ${got}, expected ${release.sha256} (from ${source ?? release.url})`,
        );
      await chmod(tmp, 0o755);
      await rename(tmp, bin);
    } catch (e) {
      await rm(tmp, { force: true });
      // another writer may have put a valid binary in place meanwhile
      if (!(await valid()))
        throw new Error(`cannot obtain Gitea ${release.version}: ${(e as Error).message}`, {
          cause: e,
        });
    }
  }
  await chmod(dir, 0o755).catch(() => {});
  return bin;
}
