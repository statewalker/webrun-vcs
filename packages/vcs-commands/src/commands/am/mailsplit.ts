/**
 * `git mailsplit` (builtin/mailsplit.c) as a library call: mailboxes (mbox, mboxrd) and
 * Maildirs cut into one file per message, named by number (`0001`, `0002`, ... with
 * `-d<prec>` digits, counting on from `-f<n>`), as git writes them into its `-o<directory>`.
 *
 * @example
 * ```typescript
 * const r = splitMail([{ mbox: bytes, name: "series.mbox" }], { allowBare: true });
 * for (const f of r.files) console.log(f.name, f.content.length);
 * ```
 */

import type { FilesApi } from "@statewalker/vcs-utils/files";
import { readFile } from "@statewalker/vcs-utils/files";

import { bytesToLatin1, latin1ToBytes } from "../apply/latin1.js";

/** Options of {@link splitMail}: git mailsplit's flags. */
export interface MailsplitOptions {
  /** `-b`: a mailbox that does not start with a `From ` line is one message (else corrupt) */
  allowBare?: boolean;
  /** `--keep-cr`: lines keep their CR before LF */
  keepCr?: boolean;
  /** `--mboxrd`: one `>` taken from each `>From ` line */
  mboxrd?: boolean;
  /** `-d<prec>`: digits of the file names, 3 to 9 (default 4) */
  precision?: number;
  /** `-f<n>`: the number of messages already split (the first file is `n + 1`) */
  skip?: number;
}

/** One input of {@link splitMail}. */
export type MailsplitSource =
  | {
      /** An mbox's bytes (a string is taken as UTF-8 text) */
      mbox: Uint8Array | string;
      /** Its path as git names it in messages; none: standard input (`-`) */
      name?: string;
    }
  | {
      /**
       * A Maildir's messages: each with its name below the Maildir (`cur/<file>` or
       * `new/<file>`); other names and names starting with `.` are left out, as git reads
       * only those two directories
       */
      maildir: { name: string; content: Uint8Array | string }[];
      /** The Maildir's path as git names it in messages */
      name: string;
    };

/** What `git mailsplit` wrote and printed. */
export interface MailsplitResult {
  /** 0, or 1 when git fails (the files written before stay) */
  exitCode: number;
  /** stdout: the number of messages split, on success */
  output: string;
  /** stderr */
  errors: string;
  /** The files written, in order: their names (`0001`...) and contents */
  files: { name: string; content: Uint8Array }[];
  /** The number of messages split (the last file's number less `skip`) */
  count: number;
}

// git's isspace (sane_ctype): space, tab, LF, CR
const gitSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

/** `is_from_line`: an mbox "From " separator with something like a date. */
export function isMboxFromLine(line: string): boolean {
  const len = line.length;
  if (len < 20 || !line.startsWith("From ")) return false;
  let colon = len - 2;
  for (;;) {
    if (colon < 5) return false;
    if (line[--colon] === ":") break;
  }
  if (
    !isDigit(line[colon - 4]) ||
    !isDigit(line[colon - 2]) ||
    !isDigit(line[colon - 1]) ||
    !isDigit(line[colon + 1]) ||
    !isDigit(line[colon + 2])
  )
    return false;
  // strtol: leading whitespace and a sign, then digits
  const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(line.slice(colon + 3));
  return m ? Number(m[1]) > 90 : false;
}

/** `is_gtfrom`: `>+From ` */
function isGtFrom(line: string): boolean {
  if (line.length < 6) return false;
  let n = 0;
  while (line[n] === ">") n++;
  return n > 0 && line.startsWith("From ", n);
}

/** Lines with their LF (the last one maybe without). */
function linesOf(text: string, from = 0): string[] {
  const out: string[] = [];
  let at = from;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl + 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

/** strtol of the digits at `at`: the value and where it ends. */
function digitsAt(s: string, at: number): { value: bigint; end: number } {
  let end = at;
  while (isDigit(s[end])) end++;
  return { value: BigInt(s.slice(at, end)), end };
}

/** `maildir_filename_cmp`: runs of digits compared as numbers. */
export function maildirFilenameCompare(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (isDigit(a[i]) && isDigit(b[j])) {
      const na = digitsAt(a, i);
      const nb = digitsAt(b, j);
      if (na.value !== nb.value) return na.value < nb.value ? -1 : 1;
      i = na.end;
      j = nb.end;
    } else {
      const ca = a.charCodeAt(i);
      const cb = b.charCodeAt(j);
      if (ca !== cb) return ca - cb;
      i++;
      j++;
    }
  }
  return (i < a.length ? a.charCodeAt(i) : 0) - (j < b.length ? b.charCodeAt(j) : 0);
}

/**
 * `split_one`: the message starting at `lines[i]`, up to the next "From " line (a bare one,
 * one not starting with such a line, up to the end); undefined for a corrupt mailbox.
 */
function splitOne(
  lines: string[],
  start: number,
  allowBare: boolean,
  options: MailsplitOptions,
): { message: string; next: number; done: boolean } | undefined {
  const bare = !isMboxFromLine(lines[start] as string);
  if (bare && !allowBare) return undefined;
  let msg = "";
  let i = start;
  for (;;) {
    let line = lines[i] as string;
    if (!options.keepCr && line.length > 1 && line.endsWith("\r\n"))
      line = `${line.slice(0, -2)}\n`;
    if (options.mboxrd && isGtFrom(line)) line = line.slice(1);
    msg += line;
    i++;
    if (i >= lines.length) return { message: msg, next: i, done: true };
    if (!bare && isMboxFromLine(lines[i] as string)) return { message: msg, next: i, done: false };
  }
}

const toLatin1 = (v: Uint8Array | string) =>
  typeof v === "string" ? bytesToLatin1(new TextEncoder().encode(v)) : bytesToLatin1(v);

/**
 * git mailsplit over contents: each mbox cut at its "From " lines (leading whitespace
 * skipped; an empty file is an error, empty standard input is not), each Maildir's messages
 * from `cur/` then `new/` in `maildir_filename_cmp` order (one message per file: what follows
 * a second "From " line is dropped, as git does), CRs before LF dropped unless `keepCr`.
 *
 * @throws RangeError for a precision git refuses (outside 3 to 9: its usage)
 */
export function splitMail(
  sources: MailsplitSource[],
  options: MailsplitOptions = {},
): MailsplitResult {
  const precision = options.precision ?? 4;
  if (!(precision >= 3 && precision < 10))
    throw new RangeError(`mailsplit: precision ${precision}`);
  const files: { name: string; content: Uint8Array }[] = [];
  let nr = options.skip ?? 0;
  const first = nr;
  const errors = "";
  const emit = (message: string) => {
    nr++;
    files.push({ name: String(nr).padStart(precision, "0"), content: latin1ToBytes(message) });
  };
  const fail = (lines: string, exitCode = 1): MailsplitResult => ({
    exitCode,
    output: "",
    errors: errors + lines,
    files,
    count: nr - first,
  });
  const inputs: MailsplitSource[] = sources.length ? sources : [{ mbox: "" }];
  for (const source of inputs) {
    if ("maildir" in source) {
      // populate_maildir_list: cur/ then new/, sorted (equal names kept once)
      const names: { key: string; content: Uint8Array | string }[] = [];
      for (const sub of ["cur", "new"]) {
        for (const m of source.maildir) {
          const slash = m.name.indexOf("/");
          if (slash < 0 || m.name.slice(0, slash) !== sub) continue;
          const base = m.name.slice(slash + 1);
          if (!base || base.startsWith(".") || base.includes("/")) continue;
          const key = `${sub}/${base}`;
          let lo = 0;
          let hi = names.length;
          let found = false;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            const c = maildirFilenameCompare((names[mid] as { key: string }).key, key);
            if (c === 0) {
              found = true;
              break;
            }
            if (c < 0) lo = mid + 1;
            else hi = mid;
          }
          if (!found) names.splice(lo, 0, { key, content: m.content });
        }
      }
      for (const { key, content } of names) {
        const text = toLatin1(content);
        if (!text.length) return fail(`error: cannot read mail ${source.name}/${key}: Success\n`);
        const r = splitOne(linesOf(text), 0, true, options) as { message: string };
        emit(r.message);
      }
      continue;
    }
    const text = toLatin1(source.mbox);
    let at = 0;
    while (at < text.length && gitSpace(text.charCodeAt(at))) at++;
    if (at >= text.length) {
      if (source.name === undefined) continue;
      return fail(
        `error: empty mbox: '${source.name}'\nerror: cannot split patches from ${source.name}\n`,
      );
    }
    const lines = linesOf(text, at);
    let i = 0;
    for (;;) {
      const r = splitOne(lines, i, options.allowBare ?? false, options);
      if (!r) return fail("corrupt mailbox\n");
      emit(r.message);
      if (r.done) break;
      i = r.next;
    }
  }
  return { exitCode: 0, output: `${nr - first}\n`, errors, files, count: nr - first };
}

/**
 * `git mailsplit -o<outDir> [options] <paths>...` over a FilesApi: each path a mailbox file
 * or a Maildir directory (none: standard input, given as `stdin`), the message files written
 * into `outDir` as git writes them. A file that exists already is refused (git's `O_EXCL`:
 * exit 128), a missing path fails as git's `stat` (exit 1).
 *
 * @example
 * ```typescript
 * const r = await mailsplitFiles(files, ["inbox.mbox"], ".git/rebase-apply", { allowBare: true });
 * ```
 */
export async function mailsplitFiles(
  files: FilesApi,
  paths: string[],
  outDir: string,
  options: MailsplitOptions & { stdin?: Uint8Array } = {},
): Promise<MailsplitResult> {
  const precision = options.precision ?? 4;
  const written: { name: string; content: Uint8Array }[] = [];
  let nr = options.skip ?? 0;
  const first = nr;
  let errors = "";
  const finish = (exitCode: number): MailsplitResult => ({
    exitCode,
    output: exitCode ? "" : `${nr - first}\n`,
    errors,
    files: written,
    count: nr - first,
  });
  const inputs = paths.length ? paths : ["-"];
  for (const path of inputs) {
    let source: MailsplitSource;
    if (path === "-") source = { mbox: options.stdin ?? new Uint8Array() };
    else {
      const stats = await files.stats(path);
      if (!stats) {
        errors += `error: cannot stat ${path}: No such file or directory\n`;
        return finish(1);
      }
      if (stats.kind === "directory") {
        const maildir: { name: string; content: Uint8Array }[] = [];
        for (const sub of ["cur", "new"]) {
          for await (const entry of files.list(`${path}/${sub}`)) {
            if (entry.kind !== "file") continue;
            maildir.push({
              name: `${sub}/${entry.name}`,
              content: await readFile(files, entry.path),
            });
          }
        }
        source = { maildir, name: path };
      } else source = { mbox: await readFile(files, path), name: path };
    }
    const r = splitMail([source], { ...options, precision, skip: nr });
    for (const f of r.files) {
      const target = `${outDir}/${f.name}`;
      if (await files.exists(target)) {
        errors += `${r.errors}fatal: could not open '${target}' for writing: File exists\n`;
        return finish(128);
      }
      await files.write(target, [f.content]);
      written.push(f);
      nr++;
    }
    errors += r.errors;
    if (r.exitCode) return finish(r.exitCode);
  }
  return finish(0);
}
