import type { FileModeValue } from "../../common/files/index.js";
import type { ObjectId } from "../../common/id/object-id.js";

/**
 * Tree entry representing a file or subdirectory
 *
 * Following Git's tree entry format (JGit TreeEntry):
 * - mode: File mode (octal value as number)
 * - name: UTF-8 encoded filename (no path separators)
 * - id: ObjectId of the content (blob) or subtree (tree)
 *
 * Note: Tree entries are naturally sorted by name in Git format.
 * Directories (trees) are compared as if they had a trailing '/'.
 */
export interface TreeEntry {
  /** File mode (e.g., 0o100644 for regular file, 0o040000 for directory) */
  mode: FileModeValue | number;
  /** Filename (UTF-8, no path separators) */
  name: string;
  /** ObjectId of content (blob) or subtree (tree) */
  id: ObjectId;
}
