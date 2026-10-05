/**
 * Reflog reader implementation
 *
 * Reads reflog entries from .git/logs/<refname> files.
 *
 * Reflog file format (each line):
 * <old-sha> <new-sha> <committer-ident> <timestamp> <timezone>\t<message>
 *
 * Example:
 * 0000000... abc123... John <john@example.com> 1703936400 +0000\tcommit (initial): Initial commit
 *
 * Reference: jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/ReflogReaderImpl.java
 */

import {
  type FilesApi,
  joinPath,
  parsePersonIdent,
  type ReflogEntry,
  type ReflogReader,
} from "@statewalker/vcs-core";

const LOGS_DIR = "logs";

/**
 * Create reflog reader for a ref
 *
 * @param files FilesApi for filesystem access
 * @param gitDir Path to .git directory
 * @param refName Ref name (e.g., "HEAD", "refs/heads/main")
 * @returns ReflogReader instance
 */
export function createReflogReader(files: FilesApi, gitDir: string, refName: string): ReflogReader {
  const logPath =
    refName === "HEAD" ? joinPath(gitDir, LOGS_DIR, "HEAD") : joinPath(gitDir, LOGS_DIR, refName);

  return new ReflogReaderImpl(files, logPath);
}

/**
 * ReflogReader implementation
 */
class ReflogReaderImpl implements ReflogReader {
  constructor(
    private readonly files: FilesApi,
    private readonly logPath: string,
  ) {}

  async getLastEntry(): Promise<ReflogEntry | undefined> {
    return this.getReverseEntry(0);
  }

  async getReverseEntries(max = Number.MAX_SAFE_INTEGER): Promise<ReflogEntry[]> {
    const content = await this.readLog();
    if (!content) return [];

    // Split into lines and reverse to get newest first
    const lines = content.trim().split("\n").filter(Boolean).reverse();
    const entries: ReflogEntry[] = [];

    for (const line of lines.slice(0, max)) {
      const entry = parseReflogLine(line);
      if (entry) entries.push(entry);
    }

    return entries;
  }

  async getReverseEntry(index: number): Promise<ReflogEntry | undefined> {
    const entries = await this.getReverseEntries(index + 1);
    return entries[index];
  }

  private async readLog(): Promise<string | undefined> {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of this.files.read(this.logPath)) {
        chunks.push(chunk);
      }
      return new TextDecoder().decode(concatUint8Arrays(chunks));
    } catch {
      return undefined;
    }
  }
}

/**
 * Parse single reflog line
 *
 * Format: <old> <new> <name> <email> <timestamp> <timezone>\t<message>
 *
 * @param line Raw reflog line
 * @returns Parsed ReflogEntry or undefined if invalid
 */
export function parseReflogLine(line: string): ReflogEntry | undefined {
  // Find tab separator between header and message
  const tabIndex = line.indexOf("\t");
  if (tabIndex < 0) return undefined;

  const header = line.slice(0, tabIndex);
  const comment = line.slice(tabIndex + 1);

  // Parse header: <old> <new> <ident>
  // The ident includes name, email, timestamp, and timezone
  const firstSpace = header.indexOf(" ");
  if (firstSpace < 0) return undefined;

  const secondSpace = header.indexOf(" ", firstSpace + 1);
  if (secondSpace < 0) return undefined;

  const oldId = header.slice(0, firstSpace);
  const newId = header.slice(firstSpace + 1, secondSpace);
  const identStr = header.slice(secondSpace + 1);

  // Validate object IDs (40 hex characters)
  if (oldId.length !== 40 || newId.length !== 40) return undefined;

  try {
    const who = parsePersonIdent(identStr);
    return { oldId, newId, who, comment };
  } catch {
    return undefined;
  }
}

/**
 * Concatenate Uint8Array chunks
 */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
