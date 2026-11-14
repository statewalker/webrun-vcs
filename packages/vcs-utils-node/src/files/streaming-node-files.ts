/**
 * NodeFilesApi whose `write` streams each chunk to the file. The published
 * `@statewalker/webrun-files-node` (0.10) collects every chunk before
 * `fs.writeFile`, so writing a 500 MB object would cost 500 MB of memory.
 * Until that is fixed upstream, this class keeps writes bounded.
 */
import { mkdir, open } from "node:fs/promises";
import { dirname, posix, resolve, sep } from "node:path";
import { NodeFilesApi } from "@statewalker/webrun-files-node";

export class StreamingNodeFilesApi extends NodeFilesApi {
  readonly #root: string;

  constructor(options: { rootDir: string }) {
    super(options);
    this.#root = resolve(options.rootDir);
  }

  #real(path: string): string {
    const real = resolve(this.#root, `.${posix.normalize(`/${path}`)}`);
    if (real !== this.#root && !real.startsWith(this.#root + sep)) {
      throw new Error(`path escapes root: ${path}`);
    }
    return real;
  }

  /**
   * Write `content` chunk by chunk, creating parent directories and replacing
   * an existing file. Memory stays at one chunk. A failed write can leave a
   * partial file; callers that need all-or-nothing write a temporary and
   * rename it (as git's lock files and loose objects do). Like git with its
   * default `core.fsync`, loose writes are not fsynced.
   */
  override async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const real = this.#real(path);
    await mkdir(dirname(real), { recursive: true });
    const fh = await open(real, "w");
    try {
      for await (const chunk of content) {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await fh.write(chunk, offset, chunk.length - offset);
          offset += bytesWritten;
        }
      }
    } finally {
      await fh.close();
    }
  }
}
