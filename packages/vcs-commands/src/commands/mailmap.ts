/**
 * git's mailmap (mailmap.c): `.mailmap`, `mailmap.blob` and `mailmap.file`, mapping the
 * names and emails of commits to canonical ones (`%aN`, `%aE`, and `git log`'s headers when
 * `log.mailmap` is on, its default).
 *
 * @example
 * ```typescript
 * const map = new Mailmap();
 * map.read("Jane Doe <jane@example.com> <jane@old.example>\n");
 * map.map("jane", "JANE@old.example"); // { name: "Jane Doe", email: "jane@example.com" }
 * ```
 *
 * @module
 */

import { parseGitBool } from "@statewalker/vcs-utils";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  expandUserPath,
  type GitHostEnvironment,
  type Worktree,
} from "@statewalker/vcs-working-tree";

interface MailmapInfo {
  name?: string;
  email?: string;
}

interface MailmapEntry extends MailmapInfo {
  /** The entries that also match the old name, by lower-cased name */
  names: Map<string, MailmapInfo>;
}

/** strcasecmp's folding: ASCII letters only */
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** git's isspace: space, tab, LF, CR */
const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

/** mailmap.c's parse_name_and_email: the name, the email and what follows the `>`. */
function parseNameAndEmail(
  buffer: string,
  allowEmptyEmail: boolean,
): { name?: string; email?: string; rest?: string } {
  const left = buffer.indexOf("<");
  if (left < 0) return {};
  const right = buffer.indexOf(">", left + 1);
  if (right < 0) return {};
  if (!allowEmptyEmail && left + 1 === right) return {};
  let start = 0;
  while (start < left && isSpace(buffer[start])) start++;
  let end = left - 1;
  while (end > start && isSpace(buffer[end])) end--;
  const name = start <= end ? buffer.slice(start, end + 1) : undefined;
  const email = buffer.slice(left + 1, right);
  const rest = buffer.slice(right + 1);
  return {
    ...(name !== undefined ? { name } : {}),
    email,
    ...(rest !== "" ? { rest } : {}),
  };
}

/** A mailmap: entries keyed by email, case-insensitively, as git's string list keeps them. */
export class Mailmap {
  private readonly entries = new Map<string, MailmapEntry>();

  /** Whether it has no entries (git maps nothing then). */
  get empty(): boolean {
    return this.entries.size === 0;
  }

  /** The lines of a mailmap file (read_mailmap_string / read_mailmap_file) added. */
  read(text: string): this {
    for (const raw of text.split("\n")) {
      // fgets reads 1023 bytes at most; longer lines are rare enough to keep whole
      this.readLine(raw);
    }
    return this;
  }

  private readLine(buffer: string): void {
    if (buffer.startsWith("#")) return;
    const first = parseNameAndEmail(buffer, false);
    if (first.email === undefined) return;
    let name2: string | undefined;
    let email2: string | undefined;
    if (first.rest !== undefined) {
      const second = parseNameAndEmail(first.rest, true);
      name2 = second.name;
      email2 = second.email;
    }
    this.add(first.name, first.email, name2, email2);
  }

  /** mailmap.c's add_mapping. */
  private add(
    newName: string | undefined,
    newEmail: string | undefined,
    oldName: string | undefined,
    oldEmail: string | undefined,
  ): void {
    let key = oldEmail;
    let email = newEmail;
    if (key === undefined) {
      key = newEmail as string;
      email = undefined;
    }
    const lower = fold(key);
    let entry = this.entries.get(lower);
    if (!entry) {
      entry = { names: new Map() };
      this.entries.set(lower, entry);
    }
    if (oldName === undefined) {
      if (newName !== undefined) entry.name = newName;
      if (email !== undefined) entry.email = email;
    } else {
      entry.names.set(fold(oldName), {
        ...(newName !== undefined ? { name: newName } : {}),
        ...(email !== undefined ? { email } : {}),
      });
    }
  }

  /**
   * mailmap.c's map_user where it maps: the canonical name and email of an identity, or
   * undefined when no entry gives either (git leaves the identity as written then).
   */
  lookup(name: string, email: string): { name: string; email: string } | undefined {
    const entry = this.entries.get(fold(email));
    if (!entry) return undefined;
    let info: MailmapInfo = entry;
    if (entry.names.size > 0) {
      const sub = entry.names.get(fold(name));
      if (sub) info = sub;
    }
    if (info.name === undefined && info.email === undefined) return undefined;
    return { name: info.name ?? name, email: info.email ?? email };
  }

  /** mailmap.c's map_user: the canonical name and email of an identity. */
  map(name: string, email: string): { name: string; email: string } {
    const entry = this.entries.get(fold(email));
    if (!entry) return { name, email };
    let info: MailmapInfo = entry;
    if (entry.names.size > 0) {
      const sub = entry.names.get(fold(name));
      if (sub) info = sub;
    }
    return { name: info.name ?? name, email: info.email ?? email };
  }
}

/** What {@link readRepositoryMailmap} reads of a repository. */
export interface MailmapSources {
  /** A configuration value (`core.bare`, `mailmap.blob`, `mailmap.file`) */
  config(key: string): string | undefined;
  /** The worktree `.mailmap` is read from (none in a bare repository) */
  worktree?: Worktree;
  /** The host `mailmap.file` is read through (a relative path from its current directory) */
  environment?: GitHostEnvironment;
  /** The blob a revision names (`mailmap.blob`), undefined when it names none */
  readBlobNamed(name: string): Promise<Uint8Array | undefined>;
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * mailmap.c's read_mailmap: the worktree's `.mailmap` (not in a bare repository), then
 * `mailmap.blob` (default `HEAD:.mailmap` in a bare repository), then `mailmap.file`.
 *
 * @example
 * ```typescript
 * const map = await readRepositoryMailmap({ config, worktree, readBlobNamed });
 * ```
 */
export async function readRepositoryMailmap(sources: MailmapSources): Promise<Mailmap> {
  const map = new Mailmap();
  const worktree = sources.worktree;
  const bare = parseGitBool(sources.config("core.bare")) ?? !worktree;
  if (!bare && worktree) {
    try {
      const entry = await worktree.getEntry(".mailmap");
      if (entry && !entry.isDirectory && (entry.mode & 0o170000) !== 0o120000) {
        const chunks: Uint8Array[] = [];
        for await (const c of worktree.readContent(".mailmap")) chunks.push(c);
        map.read(decodeGitPath(joinChunks(chunks)));
      }
    } catch {
      // no .mailmap
    }
  }
  const blobName = sources.config("mailmap.blob") ?? (bare ? "HEAD:.mailmap" : undefined);
  if (blobName) {
    const bytes = await sources.readBlobNamed(blobName);
    if (bytes) map.read(decodeGitPath(bytes));
  }
  const file = sources.config("mailmap.file");
  if (file) {
    const environment = sources.environment;
    const path = expandUserPath(file, environment);
    const bytes =
      path !== undefined ? await readMailmapFile(path, environment, worktree) : undefined;
    if (bytes) map.read(decodeGitPath(bytes));
  }
  return map;
}

/**
 * `mailmap.file`, read as git reads it: through the host (a relative path from its current
 * directory). Without a host environment, a relative path is read from the worktree's top
 * (where git usually runs), and an absolute one inside the worktree through it as well.
 */
async function readMailmapFile(
  path: string,
  environment: GitHostEnvironment | undefined,
  worktree: Worktree | undefined,
): Promise<Uint8Array | undefined> {
  if (environment) return environment.readFile(path).catch(() => undefined);
  if (!worktree) return undefined;
  let relative = path;
  if (path.startsWith("/")) {
    const top = (worktree as { hostPath?: string }).hostPath?.replace(/\/+$/, "");
    if (!top || !path.startsWith(`${top}/`)) return undefined;
    relative = path.slice(top.length + 1);
  }
  if (relative.split("/").includes("..")) return undefined;
  try {
    const entry = await worktree.getEntry(relative);
    if (!entry || entry.isDirectory) return undefined;
    const chunks: Uint8Array[] = [];
    for await (const c of worktree.readContent(relative)) chunks.push(c);
    return joinChunks(chunks);
  } catch {
    return undefined;
  }
}
