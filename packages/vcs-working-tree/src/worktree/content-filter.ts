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
  /** Receives warnings (git prints them as `warning: ...`) */
  onWarning?: (message: string) => void;
}

/** The conversion of one path in one direction. */
export interface ContentConversion {
  /** Converts the whole content (clean or smudge, depending on how it was obtained) */
  apply(content: Uint8Array, options?: ContentConversionOptions): Promise<Uint8Array>;
}

/** The clean and smudge conversions of a worktree. */
export interface WorktreeContentFilter {
  /** The clean conversion of `path`; undefined when its content goes in as it is */
  checkin(path: string): Promise<ContentConversion | undefined>;
  /** The smudge conversion of `path`; undefined when its content is written as it is */
  checkout(path: string): Promise<ContentConversion | undefined>;
  /**
   * The worktree wrote `content` (the repository's form, before smudging) to `path`: a
   * checkout in progress reads the attributes of the files it writes next from it
   */
  noteWritten?(path: string, content: Uint8Array): void;
  /** The worktree removed `path` */
  noteRemoved?(path: string): void;
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
