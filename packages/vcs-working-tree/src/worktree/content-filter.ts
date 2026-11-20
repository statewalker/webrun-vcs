/**
 * The content conversion a worktree applies between its files and the repository: git's
 * clean (worktree to index: `convert_to_git`) and smudge (index to worktree:
 * `convert_to_working_tree`) for end-of-line conversion, `ident`, `working-tree-encoding`
 * and filter drivers. A working copy installs one built from its attributes and
 * configuration (`createGitContentFilter`); without one, content passes as it is.
 */

/** How a clean conversion is run. */
export interface ContentConversionOptions {
  /**
   * The content is written to the repository (`git add`, `commit -a`, `stash`): git's
   * `core.safecrlf` check runs, warning or refusing a change of line endings
   */
  write?: boolean;
  /**
   * Renormalising (`git add --renormalize`): CRLF already in the index does not hold back the
   * conversion, and no round-trip warning is given
   */
  renormalize?: boolean;
  /**
   * The line-ending step is skipped (git's `CONV_EOL_KEEP_CRLF`, as `git apply` reads a file
   * its patch has CRLF context for); the clean filter, encoding and ident still run
   */
  keepCrlf?: boolean;
  /** Receives warnings (git prints them as `warning: ...`) */
  onWarning?: (message: string) => void;
}

/** The conversion of one path in one direction. */
export interface ContentConversion {
  /** Converts the whole content (clean or smudge, depending on how it was obtained) */
  apply(content: Uint8Array, options?: ContentConversionOptions): Promise<Uint8Array>;
}

/**
 * The index an operation reads in-tree `.gitattributes` from: git's attribute index
 * (`istate`). A checkout reads the index it leaves behind (unpack-trees' `o->result`), so
 * every file it writes, `.gitattributes` itself included, is converted with the target's
 * rules whatever order the files are written in.
 */
export interface AttributesIndex {
  /**
   * The blob id of the in-tree attributes file `path` (`.gitattributes`,
   * `dir/.gitattributes`) in this index; undefined when the index holds none there
   */
  attributesBlob(path: string): string | undefined | Promise<string | undefined>;
}

/**
 * Where a smudge reads attributes from (git's `git_attr_set_direction` and attribute index).
 *
 * - `checkout` (git's `GIT_ATTR_CHECKOUT`, set by unpack-trees for `checkout <branch>`,
 *   `reset --hard`, `read-tree -u`, merges and `clone`): the index's file first, the
 *   worktree's when the index holds none.
 * - `checkin` (the default, as for `checkout -- <path>`, `checkout-index`, `restore`): the
 *   worktree's file first, the index's when the worktree has none.
 */
export interface ContentAttributesContext {
  direction: "checkin" | "checkout";
  /** The index read (default: the working copy's current index) */
  index?: AttributesIndex;
  /**
   * The path names a directory (only for {@link WorktreeContentFilter.attributes}): patterns
   * ending in `/` may match it, as git's `git_check_attr` of a name ending in `/`
   */
  isDirectory?: boolean;
}

/**
 * An {@link AttributesIndex} over index (or tree) entries: `[path, blob id]` pairs.
 *
 * @example
 * ```typescript
 * const index = attributesIndexOf(plan.entries.map((e) => [e.path, e.objectId]));
 * await worktree.writeContent(path, blob, { attributes: { direction: "checkout", index } });
 * ```
 */
export function attributesIndexOf(entries: Iterable<readonly [string, string]>): AttributesIndex {
  const blobs = new Map<string, string>();
  for (const [path, id] of entries) if (isAttributesFile(path)) blobs.set(path, id);
  return { attributesBlob: (path) => blobs.get(path) };
}

/**
 * An {@link AttributesIndex} over a tree: the attributes files a `read-tree` of it would
 * stage, looked up when asked.
 */
export function attributesIndexOfTree(
  trees: {
    getEntry(
      treeId: string,
      name: string,
    ): Promise<{ id: string; mode: number } | undefined | null>;
  },
  treeId: string,
): AttributesIndex {
  const found = new Map<string, Promise<string | undefined>>();
  const lookup = async (path: string): Promise<string | undefined> => {
    let current = treeId;
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const entry = await trees.getEntry(current, parts[i]);
      if (!entry) return undefined;
      const isTree = (entry.mode & 0o170000) === 0o040000;
      if (i < parts.length - 1) {
        if (!isTree) return undefined;
        current = entry.id;
      } else return isTree ? undefined : entry.id;
    }
    return undefined;
  };
  return {
    attributesBlob: (path) => {
      let id = found.get(path);
      if (!id) {
        id = lookup(path).catch(() => undefined);
        found.set(path, id);
      }
      return id;
    },
  };
}

/** The clean and smudge conversions of a worktree. */
export interface WorktreeContentFilter {
  /** The clean conversion of `path`; undefined when its content goes in as it is */
  checkin(path: string): Promise<ContentConversion | undefined>;
  /**
   * The smudge conversion of `path`; undefined when its content is written as it is.
   * `context` says where its attributes are read (default: the worktree, then the index).
   */
  checkout(
    path: string,
    context?: ContentAttributesContext,
  ): Promise<ContentConversion | undefined>;
  /**
   * The worktree wrote or removed the file at `path`: what the filter cached from it (an
   * in-tree `.gitattributes`) is read again
   */
  noteChanged?(path: string): void;
  /**
   * Runs `fn` as one operation: the configuration and the attributes files are read once
   * for all of it (dropped when it ends), except a `.gitattributes` the worktree changes
   * meanwhile ({@link noteChanged}). Nested operations join the outer one.
   */
  batch?<T>(fn: () => Promise<T>): Promise<T>;
}

/** Collects an iterable of chunks into one array. */
export async function collectChunks(
  content: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array,
): Promise<Uint8Array> {
  if (content instanceof Uint8Array) return content;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of content) {
    chunks.push(chunk);
    size += chunk.length;
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The last component of a path. */
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Whether `path` names an in-tree attributes file. */
export const isAttributesFile = (path: string) => baseName(path) === ".gitattributes";
