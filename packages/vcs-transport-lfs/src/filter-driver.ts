/**
 * Git LFS as a filter driver (`filter=lfs`): what `git lfs clean` / `git lfs smudge` do,
 * over an {@link LfsObjectStore}, in the shape of `FilterDriver` from
 * `@statewalker/vcs-working-tree`. A working copy registers it under the name `lfs`
 * (`filterDrivers: { lfs: createLfsFilterDriver(store) }`) and files matching
 * `*.bin filter=lfs` are stored as pointers and checked out as their content.
 */
import { createLfsPointer, formatLfsPointer, parseLfsPointer } from "./pointer.js";
import { type ByteSource, chunksOf } from "./sha256.js";
import type { LfsObjectStore } from "./store.js";
import type { LfsPointer } from "./types.js";

/** What the driver is told about the file it converts. */
export interface LfsFilterContext {
  path: string;
}

/** The driver: the shape of `FilterDriver` (`@statewalker/vcs-working-tree`). */
export interface LfsFilterDriver {
  clean(content: Uint8Array, context: LfsFilterContext): Promise<Uint8Array>;
  smudge(content: Uint8Array, context: LfsFilterContext): Promise<Uint8Array>;
  /** `git lfs install` sets `filter.lfs.required=true` */
  required: boolean;
}

/** Options of {@link createLfsFilterDriver}. */
export interface LfsFilterDriverOptions {
  /**
   * Fetches an object the store does not hold (a download from the LFS server) and returns
   * its content, or undefined to check the pointer out as it is (as `GIT_LFS_SKIP_SMUDGE`)
   */
  fetchMissing?(pointer: LfsPointer, context: LfsFilterContext): Promise<ByteSource | undefined>;
  /** Whether the driver is required (default true, as `git lfs install` configures it) */
  required?: boolean;
}

async function collect(content: ByteSource): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunksOf(content)) {
    chunks.push(chunk);
    size += chunk.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * The `lfs` filter driver over `store`: clean stores the content as an LFS object and gives
 * its pointer (a pointer given to it stays as it is, as git-lfs leaves it); smudge gives the
 * object a pointer names, fetched with `fetchMissing` when the store lacks it, and anything
 * that is not a pointer as it is.
 *
 * @example
 * ```typescript
 * const lfs = createLfsFilterDriver(createFilesLfsStore(files, ".git"));
 * const wc = new MemoryWorkingCopy({ history, checkout, worktree, config, filterDrivers: { lfs } });
 * ```
 */
export function createLfsFilterDriver(
  store: LfsObjectStore,
  options: LfsFilterDriverOptions = {},
): LfsFilterDriver {
  const encoder = new TextEncoder();
  return {
    required: options.required ?? true,
    async clean(content) {
      if (parseLfsPointer(content)) return content;
      const pointer = await createLfsPointer(content);
      if (pointer.size > 0 && (await store.size(pointer.oid)) === undefined) {
        const result = await store.put(content, { oid: pointer.oid, size: pointer.size });
        if (!result.ok) throw new Error(`git-lfs clean: ${result.reason}`);
      }
      return encoder.encode(formatLfsPointer(pointer));
    },
    async smudge(content, context) {
      const pointer = parseLfsPointer(content);
      if (!pointer) return content;
      if (pointer.size === 0) return new Uint8Array(0);
      if ((await store.size(pointer.oid)) !== undefined) return collect(store.read(pointer.oid));
      const fetched = await options.fetchMissing?.(pointer, context);
      if (!fetched) return content;
      const bytes = await collect(fetched);
      const result = await store.put(bytes, { oid: pointer.oid, size: pointer.size });
      if (!result.ok) throw new Error(`git-lfs smudge: ${result.reason}`);
      return bytes;
    },
  };
}
