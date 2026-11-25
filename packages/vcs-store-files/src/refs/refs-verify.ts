/**
 * The ref database checks of `git refs verify` (git 2.47+; `git fsck` runs them first): the
 * files backend's (refs/files-backend.c `files_fsck`: every file below `refs/` and every root
 * ref file, by name and content, then refs/packed-backend.c `packed_fsck` over packed-refs)
 * and the reftable backend's (refs/reftable-backend.c `reftable_be_fsck`: each table's name,
 * then each ref's value), for the main worktree and each linked one.
 *
 * Checks report through {@link RefsVerifyOptions.report}, which answers whether the report
 * counted as an error (git's `fsck_report_ref` returning nonzero): the severities
 * (`fsck.<msg-id>`, `--strict`) belong to the caller, and checks that stop at an error do so
 * on that answer, as git's do.
 *
 * @example
 * ```typescript
 * const failed = await verifyRefStorage({
 *   files, gitDir: ".git", worktrees: [{}],
 *   report: (r) => { console.error(`${r.path}: ${r.msgId}: ${r.message}`); return true; },
 * });
 * ```
 */

import type { FilesApi } from "@statewalker/vcs-core";
import { isValidRefName, joinPath } from "@statewalker/vcs-core";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import type { PosixFilesApi } from "@statewalker/vcs-utils/files";
import { type ObjectFormat, SHA1_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";

import { isRootRefName } from "./files-ref-batch.js";
import { createReftableStackReader } from "./reftable/reftable-stack.js";

/** The ids `git refs verify` reports (fsck.h), in git's camel case. */
export type RefFsckMsgId =
  | "badHeadTarget"
  | "badPackedRefEntry"
  | "badPackedRefHeader"
  | "badReferentName"
  | "badRefContent"
  | "badRefFiletype"
  | "badRefName"
  | "badRefOid"
  | "packedRefEntryNotTerminated"
  | "packedRefUnsorted"
  | "badReftableTableName"
  | "emptyPackedRefsFile"
  | "refMissingNewline"
  | "symlinkRef"
  | "symrefTargetIsNotARef"
  | "trailingRefContent";

/** One finding: git prints it as `<path>: <msgId>: <message>`. */
export interface RefFsckReport {
  path: string;
  msgId: RefFsckMsgId;
  message: string;
}

/** A worktree to check: the main one (no id) or a linked one (`worktrees/<id>`). */
export interface RefsVerifyWorktree {
  id?: string;
}

/** Options of {@link verifyRefStorage}. */
export interface RefsVerifyOptions {
  files: FilesApi;
  /** The repository's common git directory */
  gitDir: string;
  /** How git names the common git directory in its messages (default {@link gitDir}) */
  displayGitDir?: string;
  /** The ref storage (`extensions.refStorage`) */
  refStorage: "files" | "reftable";
  objectFormat?: ObjectFormat;
  /** The worktrees, main first (git's get_worktrees_without_reading_head) */
  worktrees: readonly RefsVerifyWorktree[];
  /** Reports a finding; true when it counts as an error (git's nonzero fsck_report_ref) */
  report(report: RefFsckReport): boolean;
  /** `--verbose`: git's progress lines (`Checking ...`), for stderr */
  verbose?(line: string): void;
  /** An `error:` line git prints for a failure that is no finding (a directory it cannot open) */
  error?(line: string): void;
}

const isSpace = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r";

const HEX = /^[0-9a-fA-F]$/;

/** git's parse_oid_hex_algop: `hexLength` hex digits at `at`; the end, or -1. */
function parseHex(s: string, at: number, hexLength: number): number {
  if (at + hexLength > s.length) return -1;
  for (let i = at; i < at + hexLength; i++) if (!HEX.test(s[i] as string)) return -1;
  return at + hexLength;
}

/** git's parse_worktree_ref: the name without `worktrees/<id>/` or `main-worktree/`. */
function strippedRefName(name: string): string {
  const current = (n: string) =>
    /^[A-Z_-]*$/.test(n) ||
    n.startsWith("refs/worktree/") ||
    n.startsWith("refs/bisect/") ||
    n.startsWith("refs/rewritten/");
  if (name.startsWith("worktrees/")) {
    const rest = name.slice("worktrees/".length);
    const slash = rest.indexOf("/");
    if (slash >= 0 && current(rest.slice(slash + 1))) return rest.slice(slash + 1);
  }
  if (name.startsWith("main-worktree/")) {
    const rest = name.slice("main-worktree/".length);
    if (current(rest)) return rest;
  }
  return name;
}

/** git's is_root_ref (HEAD included). */
const isRootRef = (name: string) => name === "HEAD" || isRootRefName(name);

/** refs.c refs_fsck_symref; true when an error stopped it (git's -1). */
function checkSymref(o: RefsVerifyOptions, path: string, refname: string, target: string): boolean {
  if (strippedRefName(refname) === "HEAD" && !target.startsWith("refs/heads/")) {
    if (
      o.report({ path, msgId: "badHeadTarget", message: `HEAD points to non-branch '${target}'` })
    )
      return true;
  }
  if (isRootRef(target)) return false;
  if (
    !isValidRefName(target) &&
    o.report({ path, msgId: "badReferentName", message: `points to invalid refname '${target}'` })
  ) {
    return true;
  }
  if (
    !target.startsWith("refs/") &&
    !target.startsWith("worktrees/") &&
    o.report({
      path,
      msgId: "symrefTargetIsNotARef",
      message: `points to non-ref target '${target}'`,
    })
  ) {
    return true;
  }
  return false;
}

/** refs.c refs_fsck_ref. */
function checkRefId(o: RefsVerifyOptions, path: string, id: string, format: ObjectFormat): boolean {
  if (/^0+$/.test(id) && id.length === format.hexLength) {
    return o.report({ path, msgId: "badRefOid", message: `points to invalid object ID '${id}'` });
  }
  return false;
}

/** files_fsck_symref_target. */
function checkSymrefTarget(
  o: RefsVerifyOptions,
  path: string,
  refname: string,
  referent: string,
  symbolicLink: boolean,
): boolean {
  let failed = false;
  let target = referent;
  if (!symbolicLink) {
    const origLen = referent.length;
    const lastByte = referent[origLen - 1];
    target = referent.replace(/[ \t\n\v\f\r]+$/, "");
    if (target.length === origLen || (target.length < origLen && lastByte !== "\n")) {
      failed =
        o.report({ path, msgId: "refMissingNewline", message: "misses LF at the end" }) || failed;
    }
    if (target.length !== origLen && target.length !== origLen - 1) {
      failed =
        o.report({
          path,
          msgId: "trailingRefContent",
          message: "has trailing whitespaces or newlines",
        }) || failed;
    }
  }
  return checkSymref(o, path, refname, target) || failed;
}

async function readText(files: FilesApi, path: string): Promise<string | undefined> {
  const chunks: Uint8Array[] = [];
  try {
    for await (const c of files.read(path)) chunks.push(c);
  } catch {
    return undefined;
  }
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return decodeGitPath(out);
}

type EntryKind = "file" | "directory" | "symlink" | "other" | undefined;

async function kindOf(files: FilesApi, path: string): Promise<EntryKind> {
  const posix = files as PosixFilesApi;
  if (posix.lstat) return (await posix.lstat(path).catch(() => undefined))?.kind;
  return (await files.stats(path))?.kind;
}

/** Normalizes a `/` path (`.` and `..` components). */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** files_fsck_refs_content of one file. */
async function checkLooseContent(
  o: RefsVerifyOptions,
  format: ObjectFormat,
  refname: string,
  filePath: string,
  kind: EntryKind,
): Promise<boolean> {
  const path = refname;
  if (kind === "symlink") {
    let failed = o.report({
      path,
      msgId: "symlinkRef",
      message: "use deprecated symbolic link for symref",
    });
    const raw = await (o.files as PosixFilesApi).readlink?.(filePath);
    const link = raw ? decodeGitPath(raw) : "";
    const dir = filePath.slice(0, filePath.lastIndexOf("/") + 1);
    const resolved = normalize(link.startsWith("/") ? link : `${dir}${link}`);
    const base = normalize(o.gitDir);
    const referent =
      base === ""
        ? resolved
        : resolved.startsWith(`${base}/`)
          ? resolved.slice(base.length + 1)
          : resolved;
    failed = checkSymrefTarget(o, path, refname, referent, true) || failed;
    return failed;
  }
  const content = await readText(o.files, filePath);
  if (content === undefined) return false;
  // parse_loose_ref_contents (the file read as a C string)
  const nul = content.indexOf("\0");
  const buf = nul >= 0 ? content.slice(0, nul) : content;
  if (buf.startsWith("ref:")) {
    let at = 4;
    while (isSpace(buf[at])) at++;
    return checkSymrefTarget(o, path, refname, buf.slice(at), false);
  }
  const end = parseHex(buf, 0, format.hexLength);
  if (end < 0 || (end < buf.length && !isSpace(buf[end]))) {
    return o.report({
      path,
      msgId: "badRefContent",
      message: buf.replace(/[ \t\n\v\f\r]+$/, ""),
    });
  }
  const trailing = buf.slice(end);
  if (trailing === "") {
    return o.report({ path, msgId: "refMissingNewline", message: "misses LF at the end" });
  }
  if (trailing !== "\n") {
    return o.report({
      path,
      msgId: "trailingRefContent",
      message: `has trailing garbage: '${trailing}'`,
    });
  }
  return checkRefId(o, path, buf.slice(0, end).toLowerCase(), format);
}

/** files_fsck_ref: the name and content checks of one file. */
async function checkLooseRef(
  o: RefsVerifyOptions,
  format: ObjectFormat,
  refname: string,
  filePath: string,
  kind: EntryKind,
): Promise<boolean> {
  o.verbose?.(`Checking ${refname}`);
  if (kind !== "file" && kind !== "symlink") {
    return o.report({ path: refname, msgId: "badRefFiletype", message: "unexpected file type" });
  }
  let failed = false;
  // files_fsck_refs_name
  if (!isRootRef(refname) && !isValidRefName(refname)) {
    failed =
      o.report({ path: refname, msgId: "badRefName", message: "invalid refname format" }) || failed;
  }
  failed = (await checkLooseContent(o, format, refname, filePath, kind)) || failed;
  return failed;
}

async function listNames(files: FilesApi, dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of files.list(dir)) names.push(entry.name);
  return names.sort();
}

/** files_fsck_refs_dir and the root refs of one worktree's ref store. */
async function verifyFilesWorktree(
  o: RefsVerifyOptions,
  format: ObjectFormat,
  worktree: RefsVerifyWorktree,
): Promise<boolean> {
  let failed = false;
  const storeDir =
    worktree.id === undefined ? o.gitDir : joinPath(o.gitDir, "worktrees", worktree.id);
  const prefix = worktree.id === undefined ? "" : `worktrees/${worktree.id}/`;
  const refsDir = joinPath(storeDir, "refs");
  if ((await o.files.stats(refsDir))?.kind !== "directory") {
    if (worktree.id === undefined) {
      const display = `${o.displayGitDir ?? o.gitDir}/refs`;
      o.error?.(`error: cannot open directory ${display}: No such file or directory`);
      failed = true;
    }
  } else {
    const walk = async (dir: string, relative: string) => {
      for (const name of await listNames(o.files, dir)) {
        const path = joinPath(dir, name);
        const kind = await kindOf(o.files, path);
        if (kind === "directory") {
          await walk(path, `${relative}${name}/`);
          continue;
        }
        // lock files are skipped, a dot-file named like one is checked
        if (!name.startsWith(".") && name.endsWith(".lock")) continue;
        if (await checkLooseRef(o, format, `${prefix}refs/${relative}${name}`, path, kind)) {
          failed = true;
        }
      }
    };
    await walk(refsDir, "");
  }
  // for_each_root_ref: regular files (links followed) named as root refs
  for (const name of await listNames(o.files, storeDir).catch(() => [] as string[])) {
    if (name.startsWith(".") || name.endsWith(".lock") || !isRootRef(name)) continue;
    const path = joinPath(storeDir, name);
    if ((await o.files.stats(path))?.kind !== "file") continue;
    if (await checkLooseRef(o, format, `${prefix}${name}`, path, "file")) failed = true;
  }
  return failed;
}

/** packed_fsck over `<git dir>/packed-refs` (main worktree only). */
async function verifyPackedRefs(o: RefsVerifyOptions, format: ObjectFormat): Promise<boolean> {
  const file = joinPath(o.gitDir, "packed-refs");
  o.verbose?.(`Checking packed-refs file ${o.displayGitDir ?? o.gitDir}/packed-refs`);
  const kind = await kindOf(o.files, file);
  if (kind === undefined) return false;
  if (kind === "symlink") {
    return o.report({
      path: "packed-refs",
      msgId: "badRefFiletype",
      message: "not a regular file but a symlink",
    });
  }
  if (kind !== "file") {
    return o.report({
      path: "packed-refs",
      msgId: "badRefFiletype",
      message: "not a regular file",
    });
  }
  const content = (await readText(o.files, file)) ?? "";
  if (content.length === 0) {
    return o.report({
      path: "packed-refs",
      msgId: "emptyPackedRefsFile",
      message: "file is empty",
    });
  }
  const hexsz = format.hexLength;
  const eof = content.length;
  const entry = (line: number) => `packed-refs line ${line}`;
  let failed = false;
  let sorted = false;

  /** packed_fsck_ref_next_line: the end of the line at `start` (reported when unterminated) */
  const nextLine = (line: number, start: number): number => {
    const nl = content.indexOf("\n", start);
    if (nl >= 0) return nl;
    if (
      o.report({
        path: entry(line),
        msgId: "packedRefEntryNotTerminated",
        message: `'${content.slice(start)}' is not terminated with a newline`,
      })
    ) {
      failed = true;
    }
    return eof;
  };

  let lineNumber = 1;
  let start = 0;
  let eol = nextLine(lineNumber, start);
  if (content[start] === "#") {
    const header = content.slice(start, eol);
    const prefix = "# pack-refs with: ";
    if (!header.startsWith(prefix)) {
      if (
        o.report({
          path: "packed-refs.header",
          msgId: "badPackedRefHeader",
          message: `'${header}' does not start with '${prefix}'`,
        })
      ) {
        failed = true;
      }
    } else {
      sorted = header.slice(prefix.length).split(" ").includes("sorted");
    }
    start = eol + 1;
    lineNumber++;
  }
  while (start < eof) {
    eol = nextLine(lineNumber, start);
    // packed_fsck_ref_main_line
    const line = content.slice(start, eol);
    const p = parseHex(content, start, hexsz);
    if (p < 0 || p > eol) {
      if (
        o.report({
          path: entry(lineNumber),
          msgId: "badPackedRefEntry",
          message: `'${line}' has invalid oid`,
        })
      ) {
        failed = true;
      }
    } else if (p === eol || !isSpace(content[p])) {
      const oid = content.slice(start, p).toLowerCase();
      if (
        o.report({
          path: entry(lineNumber),
          msgId: "badPackedRefEntry",
          message: `has no space after oid '${oid}' but with '${content.slice(p, eol)}'`,
        })
      ) {
        failed = true;
      }
    } else {
      const refname = content.slice(p + 1, eol);
      const nul = refname.indexOf("\0");
      if (nul >= 0) {
        if (
          o.report({
            path: entry(lineNumber),
            msgId: "badPackedRefEntry",
            message: `refname '${refname.slice(0, nul)}' contains NULL binaries`,
          })
        ) {
          failed = true;
        }
      }
      const name = nul >= 0 ? refname.slice(0, nul) : refname;
      if (!isValidRefName(name)) {
        if (
          o.report({
            path: entry(lineNumber),
            msgId: "badRefName",
            message: `has bad refname '${name}'`,
          })
        ) {
          failed = true;
        }
      }
    }
    start = eol + 1;
    lineNumber++;
    if (start < eof && content[start] === "^") {
      eol = nextLine(lineNumber, start);
      // packed_fsck_ref_peeled_line
      const after = start + 1;
      const q = parseHex(content, after, hexsz);
      if (q < 0 || q > eol) {
        if (
          o.report({
            path: entry(lineNumber),
            msgId: "badPackedRefEntry",
            message: `'${content.slice(after, eol)}' has invalid peeled oid`,
          })
        ) {
          failed = true;
        }
      } else if (q !== eol) {
        if (
          o.report({
            path: entry(lineNumber),
            msgId: "badPackedRefEntry",
            message: `has trailing garbage after peeled oid '${content.slice(q, eol)}'`,
          })
        ) {
          failed = true;
        }
      }
      start = eol + 1;
      lineNumber++;
    }
  }
  if (failed || !sorted) return failed;

  // packed_fsck_ref_sorted: the first refname not above its predecessor
  lineNumber = 1;
  start = 0;
  if (content[0] === "#") {
    start = content.indexOf("\n") + 1;
    lineNumber++;
  }
  let former: string | undefined;
  for (; start < eof; lineNumber++) {
    let end = content.indexOf("\n", start);
    if (end < 0) end = eof;
    if (content[start] !== "^") {
      const name = content.slice(start + hexsz + 1, end);
      if (former !== undefined && former >= name) {
        return o.report({
          path: entry(lineNumber),
          msgId: "packedRefUnsorted",
          message: `refname '${name}' is less than previous refname '${former}'`,
        });
      }
      former = name;
    }
    start = end + 1;
  }
  return false;
}

/** reftable/fsck.c table_has_valid_name: `<hex>-<hex>-<hex>.ref` (or `.log`), strtoul's way. */
function validTableName(name: string): boolean {
  let at = 0;
  const number = (max: number): boolean => {
    while (isSpace(name[at])) at++;
    if (name[at] === "+" || name[at] === "-") at++;
    if (
      name[at] === "0" &&
      (name[at + 1] === "x" || name[at + 1] === "X") &&
      HEX.test(name[at + 2] ?? "")
    ) {
      at += 2;
    }
    let significant = 0;
    let seen = false;
    while (at < name.length && HEX.test(name[at] as string)) {
      if (seen || name[at] !== "0") {
        seen = true;
        significant++;
      }
      at++;
    }
    // ERANGE past the type's width
    return significant <= max;
  };
  if (!number(16) || name[at] !== "-") return false;
  at++;
  if (!number(16) || name[at] !== "-") return false;
  at++;
  if (!number(16)) return false;
  const rest = name.slice(at);
  return rest === ".ref" || rest === ".log";
}

/** reftable_be_fsck of one worktree's stack. */
async function verifyReftableWorktree(
  o: RefsVerifyOptions,
  format: ObjectFormat,
  worktree: RefsVerifyWorktree,
): Promise<boolean> {
  const dir =
    worktree.id === undefined
      ? joinPath(o.gitDir, "reftable")
      : joinPath(o.gitDir, "worktrees", worktree.id, "reftable");
  let view: Awaited<ReturnType<ReturnType<typeof createReftableStackReader>["read"]>>;
  try {
    view = await createReftableStackReader(o.files, dir, { objectFormat: format }).read();
  } catch {
    o.error?.(
      worktree.id === undefined
        ? "error: could not read record for worktree '(null)'"
        : `error: reftable stack for worktree '${worktree.id}' is broken`,
    );
    return true;
  }
  let failed = false;
  for (const table of view.tables) {
    o.verbose?.(`Checking table: ${table}`);
    if (!validTableName(table)) {
      if (
        o.report({
          path: table,
          msgId: "badReftableTableName",
          message: "invalid reftable table name",
        })
      ) {
        failed = true;
      }
    }
  }
  const prefix = worktree.id === undefined ? "" : `worktrees/${worktree.id}/`;
  for (const record of view.refs("")) {
    const path = `${prefix}${record.name}`;
    const value = record.value;
    if (value.type === "symref") {
      if (checkSymref(o, path, path, value.target)) failed = true;
    } else if (value.type === "id" || value.type === "peeled") {
      if (checkRefId(o, path, value.id, format)) failed = true;
    }
  }
  return failed;
}

/**
 * Runs `git refs verify`'s checks over every worktree (see the module's notes).
 *
 * @returns Whether an error was reported (git's nonzero result, exit status 255)
 */
export async function verifyRefStorage(options: RefsVerifyOptions): Promise<boolean> {
  const format = options.objectFormat ?? SHA1_OBJECT_FORMAT;
  let failed = false;
  for (const worktree of options.worktrees) {
    options.verbose?.("Checking references consistency");
    if (options.refStorage === "reftable") {
      if (await verifyReftableWorktree(options, format, worktree)) failed = true;
      continue;
    }
    if (await verifyFilesWorktree(options, format, worktree)) failed = true;
    if (worktree.id === undefined && (await verifyPackedRefs(options, format))) failed = true;
  }
  return failed;
}
