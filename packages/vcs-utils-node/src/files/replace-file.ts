/**
 * Writing and replacing files as `NodeFilesApi` does (ported from
 * `@statewalker/webrun-files-node`, which does not export them), with one change: the
 * in-place copy fallback never opens the target through a symbolic link.
 */

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";

/** Windows refuses to replace a file another process holds open; such holds are brief. */
const WIN32_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WIN32_RETRIES = 7;
/**
 * A rename cannot replace a mount point (a bind-mounted file: EBUSY on POSIX) or cross
 * devices (EXDEV). On Windows EBUSY is a sharing violation, retried above, not a mount.
 */
const COPY_CODES = new Set(["EBUSY", "EXDEV"]);
const WIN32_COPY_CODES = new Set(["EXDEV"]);
const COPY_CHUNK = 65536;
/** Small chunks are gathered up to this size before each write call. */
const WRITE_BATCH = 65536;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

/** Options of {@link replaceFile}. */
export interface ReplaceFileOptions {
  /** The rename to use (tests inject failures). */
  rename?: (from: string, to: string) => Promise<void>;
  /** The platform whose rename rules apply (default: `process.platform`). */
  platform?: string;
  /** Delay before the first Windows retry; it doubles each time (default 10 ms). */
  retryDelayMs?: number;
}

/**
 * Moves `tmp` over `target`. Normally a rename, so readers see the old file or the new one.
 * On Windows a rename refused because the file is open elsewhere is retried for about a
 * second. A rename refused because `target` is a mount point or on another device (EBUSY,
 * EXDEV) falls back to copying `tmp` into `target` in place (the target keeps its inode,
 * owner and mode; a failure part way leaves it partial) — never through a symbolic link.
 * Then `tmp` is removed (best effort). Any other failure is thrown and `tmp` is left to the
 * caller.
 */
export async function replaceFile(
  tmp: string,
  target: string,
  options: ReplaceFileOptions = {},
): Promise<void> {
  const rename = options.rename ?? fs.rename;
  const win32 = (options.platform ?? process.platform) === "win32";
  let delay = options.retryDelayMs ?? 10;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (error) {
      const code = codeOf(error);
      if (win32 && code && WIN32_RETRY_CODES.has(code) && attempt < WIN32_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      if (code && (win32 ? WIN32_COPY_CODES : COPY_CODES).has(code)) {
        await copyInto(tmp, target);
        await fs.rm(tmp, { force: true }).catch(() => {});
        return;
      }
      throw error;
    }
  }
}

/** Overwrites `target` in place with `source`; a link at `target` is refused (ELOOP). */
async function copyInto(source: string, target: string): Promise<void> {
  const from = await fs.open(source, "r");
  try {
    const to = await fs.open(target, fsConstants.O_RDWR | O_NOFOLLOW);
    try {
      const buffer = new Uint8Array(COPY_CHUNK);
      let position = 0;
      for (;;) {
        const { bytesRead } = await from.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await to.write(
            buffer,
            offset,
            bytesRead - offset,
            position + offset,
          );
          offset += bytesWritten;
        }
        position += bytesRead;
      }
      await to.truncate(position);
    } finally {
      await to.close();
    }
  } finally {
    await from.close();
  }
}

/**
 * Writes the content to the handle, small chunks gathered into 64 KiB writes, each write
 * repeated until all its bytes are written (a write may be short).
 */
export async function writeBatched(
  handle: fs.FileHandle,
  content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<void> {
  const batch: Uint8Array[] = [];
  let batched = 0;
  const flush = async () => {
    if (batched === 0) return;
    const bytes = batch.length === 1 ? batch[0] : Buffer.concat(batch);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
      offset += bytesWritten;
    }
    batch.length = 0;
    batched = 0;
  };
  for await (const chunk of content) {
    if (chunk.length === 0) continue;
    batch.push(chunk);
    batched += chunk.length;
    if (batched >= WRITE_BATCH) await flush();
  }
  await flush();
}
