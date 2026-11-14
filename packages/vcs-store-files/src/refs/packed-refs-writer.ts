/**
 * Packed refs writer
 *
 * Writes the packed-refs file which stores multiple refs in a single file.
 * Every rewrite takes `packed-refs.lock` and re-reads the file under it, as git
 * does (see `createFilesRefOps`), so it never loses a concurrent ref batch or a
 * native `git pack-refs` / `git update-ref -d`.
 *
 * Based on:
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/lib/RefWriter.java
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/RefDirectory.java
 */

import {
  compareRefNames,
  type FilesApi,
  PACKED_REFS_HEADER,
  PACKED_REFS_PEELED,
  type Ref,
} from "@statewalker/vcs-core";
import { type AtomicFiles, atomicFilesOver } from "@statewalker/vcs-utils/files";
import {
  createFilesRefOps,
  type FilesRefBatchOptions,
  type FilesRefOps,
} from "./files-ref-batch.js";
import { parsePackedRefs } from "./packed-refs-reader.js";

/** Lock options of the packed-refs writers. */
export interface PackedRefsWriteOptions extends FilesRefBatchOptions {
  /**
   * Lock-file primitives rooted at `gitDir`; defaults to `atomicFilesOver(files, gitDir)`.
   * Pass the ref store's own to share its exclusion.
   */
  atomicFiles?: AtomicFiles;
}

const enc = new TextEncoder();

const opsFor = (files: FilesApi, gitDir: string, options: PackedRefsWriteOptions): FilesRefOps =>
  createFilesRefOps(options.atomicFiles ?? atomicFilesOver(files, gitDir), options);

/** The refs and peeled flag of packed-refs text (empty if absent). */
const parse = (text: string | undefined) =>
  text === undefined ? { refs: [] as Ref[], peeled: false } : parsePackedRefs(text);

/**
 * Write packed-refs file, under `packed-refs.lock`
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refs Refs to write (sorted here in git's order)
 * @param peeled Whether to include peeled data
 * @param options Lock options; throws `PackedRefsLockedError` if the lock stays held
 */
export async function writePackedRefs(
  files: FilesApi,
  gitDir: string,
  refs: Ref[],
  peeled = true,
  options: PackedRefsWriteOptions = {},
): Promise<void> {
  // git's order: byte order of the names
  const sortedRefs = [...refs].sort((a, b) => compareRefNames(a.name, b.name));
  const content = enc.encode(formatPackedRefs(sortedRefs, peeled));
  await opsFor(files, gitDir, options).updatePackedRefs(() => content);
}

/**
 * Format refs for packed-refs file
 *
 * @param refs Refs to format (should be sorted)
 * @param peeled Whether to include peeled trait in header
 * @returns Formatted packed-refs content
 */
export function formatPackedRefs(refs: Ref[], peeled = true): string {
  const lines: string[] = [];

  // Write header
  if (peeled) {
    lines.push(`${PACKED_REFS_HEADER}${PACKED_REFS_PEELED}`);
  }

  // Write refs
  for (const ref of refs) {
    if (ref.objectId === undefined) {
      continue; // Skip refs without object IDs
    }

    lines.push(`${ref.objectId} ${ref.name}`);

    // Write peeled line for annotated tags
    if (peeled && ref.peeledObjectId !== undefined) {
      lines.push(`^${ref.peeledObjectId}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Add a ref to packed-refs
 *
 * Under `packed-refs.lock`: re-reads packed-refs, adds or updates the ref, and writes back.
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param ref Ref to add
 * @param options Lock options; throws `PackedRefsLockedError` if the lock stays held
 */
export async function addPackedRef(
  files: FilesApi,
  gitDir: string,
  ref: Ref,
  options: PackedRefsWriteOptions = {},
): Promise<void> {
  await opsFor(files, gitDir, options).updatePackedRefs((text) => {
    const { refs, peeled } = parse(text);
    const index = refs.findIndex((r) => r.name === ref.name);
    if (index >= 0) refs[index] = ref;
    else refs.push(ref);
    return enc.encode(
      formatPackedRefs(
        [...refs].sort((a, b) => compareRefNames(a.name, b.name)),
        peeled,
      ),
    );
  });
}

/**
 * Remove a ref from packed-refs, under `packed-refs.lock` (the file is deleted when
 * it would be left empty)
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refName Name of ref to remove
 * @param options Lock options; throws `PackedRefsLockedError` if the lock stays held
 * @returns True if ref was removed, false if it wasn't in packed-refs
 */
export async function removePackedRef(
  files: FilesApi,
  gitDir: string,
  refName: string,
  options: PackedRefsWriteOptions = {},
): Promise<boolean> {
  let removed = false;
  await opsFor(files, gitDir, options).updatePackedRefs((text) => {
    const { refs, peeled } = parse(text);
    const index = refs.findIndex((r) => r.name === refName);
    if (index < 0) return undefined;
    refs.splice(index, 1);
    removed = true;
    return refs.length > 0 ? enc.encode(formatPackedRefs(refs, peeled)) : null;
  });
  return removed;
}

/**
 * Pack loose refs into packed-refs, as `git pack-refs`
 *
 * Under `packed-refs.lock`, reads the loose refs and writes packed-refs. Then, if
 * `deleteLoose`, removes each packed loose ref under its own `.lock`, and only if it
 * still holds the packed value: a ref updated meanwhile stays loose.
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refNames Names of refs to pack
 * @param deleteLoose Whether to delete loose ref files after packing
 * @param options Lock options; throws `PackedRefsLockedError` if packed-refs.lock stays held
 */
export async function packRefs(
  files: FilesApi,
  gitDir: string,
  refNames: string[],
  deleteLoose = true,
  options: PackedRefsWriteOptions = {},
): Promise<void> {
  await opsFor(files, gitDir, options).packRefs(refNames, { prune: deleteLoose });
}
