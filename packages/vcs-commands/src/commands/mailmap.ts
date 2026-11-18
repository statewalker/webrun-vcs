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
