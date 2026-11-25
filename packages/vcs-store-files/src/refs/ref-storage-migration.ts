/**
 * `git refs migrate` (refs.c `repo_migrate_ref_storage_format`): the refs and reflogs of a
 * repository copied from one ref storage (`files`: loose refs, packed-refs and `logs/`;
 * `reftable`: `<git dir>/reftable`) into the other.
 *
 * As git, the new storage is first written beside the old one, in
 * `<git dir>/ref_migration.XXXXXX`: every ref (root refs, symbolic and dangling ones
 * included, each as stored, never peeled: git's transaction carries no peeled value) and
 * then every reflog entry, as one initial transaction of the new storage. A dry run stops
 * there and leaves the directory for inspection.
 *
 * The swap differs from git's in its order, not its result. git deletes the old storage,
 * moves the new files in and then rewrites the config, so a process killed in between leaves
 * a repository with neither. Here the files the old storage does not read go in first, the
 * config (`extensions.refStorage`, `core.repositoryFormatVersion`) is then renamed over in
 * one step, the commit point, and only after it is the old storage removed. A migration that
 * stops anywhere before the config's rename leaves the repository in its old format, every
 * ref and reflog as before (plus files the old format never reads); one that stops after it
 * leaves the new format complete, with leftovers of the old one that the new never reads. A
 * failure before the commit point removes what it moved in.
 *
 * @example
 * ```typescript
 * await migrateRefStorage({ files, gitDir: ".git", to: "reftable" });
 * // reopen the repository: the ref store it had is the old format's
 * ```
 */

import type { FilesApi } from "@statewalker/vcs-core";
import { compareRefNames, isValidRefName, joinPath } from "@statewalker/vcs-core";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import type { PosixFilesApi } from "@statewalker/vcs-utils/files";
import { type ObjectFormat, SHA1_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";

import { readRepositoryFormat } from "../repository-format.js";
import { editConfigFile } from "../workspace/working-copy/config-file-edit.js";
import { isRootRefName } from "./files-ref-batch.js";
import { readPackedRefs } from "./packed-refs-reader.js";
import { createReftableStackReader } from "./reftable/reftable-stack.js";
import { createReftableStackWriter } from "./reftable/reftable-stack-writer.js";
import type { ReftableLogWrite, ReftableWriteOptions } from "./reftable/reftable-writer.js";

/** A ref storage format: `files` or `reftable`. */
export type RefStorageFormat = "files" | "reftable";

/** Options of {@link migrateRefStorage}. */
export interface MigrateRefStorageOptions {
  /** The FilesApi the repository is in (the backend's, so shared repositories keep their modes) */
  files: FilesApi;
  /** The repository's (common) git directory within {@link files} */
  gitDir: string;
  /** The format to migrate to */
  to: RefStorageFormat;
  /** `--dry-run`: write the new storage into the migration directory and stop there */
  dryRun?: boolean;
  /** `--no-reflog`: the reflogs are dropped (git's REPO_MIGRATE_REF_STORAGE_FORMAT_SKIP_REFLOG) */
  skipReflog?: boolean;
  /** The reftable write options (`reftable.*` of the config); git's defaults when absent */
  reftable?: ReftableWriteOptions;
  /** The suffix of the migration directory (mkdtemp's six characters); random by default */
  suffix?: () => string;
}

/** What {@link migrateRefStorage} did. */
export interface MigrateRefStorageResult {
  /** The format the repository had */
  from: RefStorageFormat;
  /** The migration directory (`<git dir>/ref_migration.XXXXXX`), left in place by a dry run */
  migrationDir: string;
  /** Problems after the commit point (a leftover git could not remove either): git's warnings */
  warnings: string[];
}

/**
 * A refused or failed migration; the message is git's (`error: <message>` once printed).
 * Every such failure comes before the commit point and leaves the repository in its old
 * format with the migration directory removed (git's `migrated refs can be found at` is never
 * needed: problems after the commit point are {@link MigrateRefStorageResult.warnings}).
 */
export class RefMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefMigrationError";
  }
}

/** A ref as git's migration copies it: an id (broken ones too) or a symbolic target. */
interface MigratedRef {
  name: string;
  objectId?: string;
  target?: string;
}

/** A reflog entry as git's for_each_reflog_ent gives it. */
interface MigratedLogEntry {
  oldId: string;
  newId: string;
  name: string;
  email: string;
  time: number;
  /** git's `tz` as an hhmm integer (`-0700` is -700) */
  tz: number;
  message: string;
}

const REFTABLE_HEADS_STUB = "this repository uses the reftable format\n";
const REFTABLE_HEAD_STUB = "ref: refs/heads/.invalid\n";
const SUFFIX_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => SUFFIX_CHARS[b % SUFFIX_CHARS.length]).join("");
}

const text = (s: string) => [encodeGitPath(s)];

async function readBytes(files: FilesApi, path: string): Promise<Uint8Array | undefined> {
  if ((await files.stats(path))?.kind !== "file") return undefined;
  const chunks: Uint8Array[] = [];
  for await (const c of files.read(path)) chunks.push(c);
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

async function listNames(files: FilesApi, dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of files.list(dir)) names.push(entry.name);
  return names;
}

async function kindOf(files: FilesApi, path: string): Promise<string | undefined> {
  const posix = files as PosixFilesApi;
  if (posix.lstat) return (await posix.lstat(path))?.kind;
  return (await files.stats(path))?.kind;
}

/** git's copy_reflog_msg (normalize_reflog_message): whitespace runs to one space, trimmed. */
function normalizeReflogMessage(message: string): string {
  return message.replace(/[ \t\n\v\f\r]+/g, " ").trim();
}

/** `-0700` from an hhmm integer. */
function tzText(tz: number): string {
  const sign = tz < 0 ? "-" : "+";
  return `${sign}${String(Math.abs(tz)).padStart(4, "0")}`;
}

/** hhmm integer to minutes east of UTC (reftable's `tz_offset`). */
function hhmmToMinutes(tz: number): number {
  const abs = Math.abs(tz);
  const minutes = Math.floor(abs / 100) * 60 + (abs % 100);
  return tz < 0 ? -minutes : minutes;
}

/** Minutes east of UTC to an hhmm integer. */
function minutesToHhmm(minutes: number): number {
  const abs = Math.abs(minutes);
  const hhmm = Math.floor(abs / 60) * 100 + (abs % 60);
  return minutes < 0 ? -hhmm : hhmm;
}

/**
 * git's files_reflog_iterator over `logs/` (regular files whose basename is a valid one-level
 * name), each name as its path below `logs/`, in its order: each directory's entries sorted
 * by name (DIR_ITERATOR_SORTED), a directory entered where it sorts (`a/b` before `a-b`).
 */
async function filesReflogNames(files: FilesApi, gitDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    const names = (await listNames(files, joinPath(gitDir, dir))).sort(compareRefNames);
    for (const name of names) {
      const path = `${dir}/${name}`;
      const kind = await kindOf(files, joinPath(gitDir, path));
      if (kind === "symlink") throw new Error(`cannot migrate the symbolic link '${path}'`);
      if (kind === "directory") await walk(path, `${prefix}${name}/`);
      else if (kind === "file" && isValidRefName(name, { allowOneLevel: true })) {
        out.push(`${prefix}${name}`);
      }
    }
  };
  await walk("logs", "");
  return out;
}

/** git's show_one_reflog_ent over a files reflog; lines it cannot parse are skipped. */
function parseFilesReflog(content: string, hexLength: number): MigratedLogEntry[] {
  const out: MigratedLogEntry[] = [];
  const hex = new RegExp(`^[0-9a-f]{${hexLength}}$`);
  let start = 0;
  while (start < content.length) {
    const nl = content.indexOf("\n", start);
    if (nl < 0) break; // a last line without its newline is not an entry
    const line = content.slice(start, nl);
    start = nl + 1;
    const oldId = line.slice(0, hexLength);
    const newId = line.slice(hexLength + 1, 2 * hexLength + 1);
    if (!hex.test(oldId) || line[hexLength] !== " ") continue;
    if (!hex.test(newId) || line[2 * hexLength + 1] !== " ") continue;
    const rest = line.slice(2 * hexLength + 2);
    const emailEnd = rest.indexOf(">");
    if (emailEnd < 0 || rest[emailEnd + 1] !== " ") continue;
    const after = rest.slice(emailEnd + 2);
    const m = /^(\d+) ([+-]\d{4})/.exec(after);
    if (!m || Number(m[1]) === 0) continue;
    let message = after.slice(m[0].length);
    if (message.startsWith("\t")) message = message.slice(1);
    const ident = rest.slice(0, emailEnd + 1);
    const lt = ident.lastIndexOf("<");
    out.push({
      oldId,
      newId,
      name: lt < 0 ? ident : ident.slice(0, lt).trimEnd(),
      email: lt < 0 ? "" : ident.slice(lt + 1, -1),
      time: Number(m[1]),
      tz: Number.parseInt(m[2] as string, 10),
      message,
    });
  }
  return out;
}

/** The refs and reflogs of the old storage, as git's migration enumerates them. */
interface SourceContent {
  refs: MigratedRef[];
  logs: { name: string; entries: MigratedLogEntry[] }[];
}

/**
 * A loose ref file as files_read_raw_ref reads it: a symbolic link naming `refs/...` is a
 * symbolic ref, any other link is followed (inside the FilesApi); content is an object id
 * (a line starting with one) or `ref: <target>`. Content git cannot parse (REF_ISBROKEN), a
 * file that cannot be read, or a link leading outside the storage throws: the migration
 * stops before anything of the old storage is touched. (git 2.56.1 migrates a repository
 * holding a broken loose ref into an empty storage and deletes the old one, losing every ref;
 * ours refuses instead.)
 */
async function readLooseRefFile(
  files: FilesApi,
  path: string,
  refName: string,
  hexLength: number,
): Promise<{ objectId?: string; target?: string } | undefined> {
  const posix = files as PosixFilesApi;
  let at = path;
  for (let depth = 0; depth < 5; depth++) {
    const kind = posix.lstat ? (await posix.lstat(at))?.kind : (await files.stats(at))?.kind;
    if (kind !== "symlink") break;
    const raw = await posix.readlink?.(at);
    if (!raw) throw new Error(`cannot read symbolic link '${at}'`);
    const link = decodeGitPath(raw);
    if (depth === 0 && link.startsWith("refs/") && isValidRefName(link)) return { target: link };
    if (link.startsWith("/")) throw new Error(`cannot follow symbolic link '${at}' to '${link}'`);
    const resolved = normalizeRelative(`${at.slice(0, at.lastIndexOf("/") + 1)}${link}`);
    if (resolved === undefined) throw new Error(`cannot follow symbolic link '${at}' to '${link}'`);
    at = resolved;
  }
  const bytes = await readBytes(files, at);
  if (bytes === undefined) throw new Error(`cannot read ref file '${path}'`);
  const text = decodeGitPath(bytes);
  if (text.startsWith("ref:")) {
    const target = text
      .slice(4)
      .replace(/^[ \t\n\v\f\r]+/, "")
      .replace(/[ \t\n\v\f\r]+$/, "");
    // refs_resolve_ref_unsafe: a target failing check_refname_format is a broken ref
    if (!isValidRefName(target, { allowOneLevel: true })) {
      throw new Error(`cannot migrate the broken ref '${refName}'`);
    }
    return { target };
  }
  const id = text.slice(0, hexLength);
  const next = text[hexLength];
  const broken =
    !new RegExp(`^[0-9a-fA-F]{${hexLength}}$`).test(id) ||
    (next !== undefined && !/[ \t\n\v\f\r]/.test(next));
  if (broken) throw new Error(`cannot migrate the broken ref '${refName}'`);
  return { objectId: id.toLowerCase() };
}

/** `a/b/../c` as `a/c`; undefined when it climbs above the root. */
function normalizeRelative(path: string): string | undefined {
  const lead = path.startsWith("/") ? "/" : "";
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return lead + out.join("/");
}

async function readFilesSource(
  files: FilesApi,
  gitDir: string,
  objectFormat: ObjectFormat,
  skipReflog: boolean,
): Promise<SourceContent> {
  const refs: MigratedRef[] = [];
  const hex = objectFormat.hexLength;
  const add = (name: string, value: { objectId?: string; target?: string } | undefined) => {
    if (value?.target !== undefined) refs.push({ name, target: value.target });
    else if (value?.objectId !== undefined) refs.push({ name, objectId: value.objectId });
  };
  // refs_for_each_ref_ext with REFS_FOR_EACH_INCLUDE_ROOT_REFS: the root refs git finds in
  // the git directory (HEAD among them; FETCH_HEAD and MERGE_HEAD stay files), then refs/
  for (const name of (await listNames(files, gitDir)).sort(compareRefNames)) {
    if (name.startsWith(".") || name.endsWith(".lock")) continue;
    if (name !== "HEAD" && !isRootRefName(name)) continue;
    const path = joinPath(gitDir, name);
    if ((await kindOf(files, path)) === "directory") continue;
    add(name, await readLooseRefFile(files, path, name, hex));
  }
  // `refs`, `packed-refs` and `logs` linked elsewhere (contrib/git-new-workdir) are refused:
  // git follows such links, but the old storage is removed after the commit point, and
  // removing a link here would leave what it shares behind
  for (const name of ["refs", "packed-refs", "logs"]) {
    if ((await kindOf(files, joinPath(gitDir, name))) === "symlink") {
      throw new Error(`cannot migrate the symbolic link '${name}'`);
    }
  }
  // the loose refs (every listing error stops the migration), then the packed ones they do
  // not shadow, in name order
  const loose = new Map<string, { objectId?: string; target?: string } | undefined>();
  const walk = async (dir: string, prefix: string) => {
    for (const name of await listNames(files, joinPath(gitDir, dir))) {
      const path = joinPath(gitDir, dir, name);
      const kind = await kindOf(files, path);
      if (kind === "directory") {
        await walk(`${dir}/${name}`, `${prefix}${name}/`);
        continue;
      }
      if (name.endsWith(".lock")) continue;
      const refName = `${prefix}${name}`;
      if (!isValidRefName(refName)) continue;
      loose.set(refName, await readLooseRefFile(files, path, refName, hex));
    }
  };
  if ((await files.stats(joinPath(gitDir, "refs")))?.kind === "directory") {
    await walk("refs", "refs/");
  }
  const all = new Map(loose);
  for (const ref of (await readPackedRefs(files, gitDir, { strict: true })).refs) {
    if (!all.has(ref.name)) all.set(ref.name, { objectId: ref.objectId as string });
  }
  for (const name of [...all.keys()].sort(compareRefNames)) add(name, all.get(name));
  const logs: SourceContent["logs"] = [];
  if (!skipReflog) {
    for (const name of await filesReflogNames(files, gitDir)) {
      const bytes = await readBytes(files, joinPath(gitDir, "logs", name));
      if (!bytes) continue;
      const entries = parseFilesReflog(decodeGitPath(bytes), objectFormat.hexLength);
      logs.push({ name, entries });
    }
  }
  return { refs, logs };
}

async function readReftableSource(
  files: FilesApi,
  gitDir: string,
  objectFormat: ObjectFormat,
  skipReflog: boolean,
): Promise<SourceContent> {
  const view = await createReftableStackReader(files, joinPath(gitDir, "reftable"), {
    objectFormat,
  }).read();
  const refs: MigratedRef[] = [];
  for (const record of view.refs("")) {
    const value = record.value;
    if (value.type === "symref") refs.push({ name: record.name, target: value.target });
    else if (value.type === "id" || value.type === "peeled") {
      refs.push({ name: record.name, objectId: value.id });
    }
  }
  const logs: SourceContent["logs"] = [];
  if (!skipReflog) {
    const zero = objectFormat.nullId;
    for (const name of view.logNames()) {
      if (!view.hasLogs(name)) continue;
      const entries: MigratedLogEntry[] = [];
      for (const log of view.logs(name)) {
        const u = log.update;
        // yield_log_record: the existence marker (both ids null) is not an entry
        if (!u || (u.oldId === zero && u.newId === zero)) continue;
        entries.push({
          oldId: u.oldId,
          newId: u.newId,
          name: u.name,
          email: u.email,
          time: u.time,
          tz: minutesToHhmm(u.tzOffset),
          message: u.message,
        });
      }
      // newest first in the table; git's for_each_reflog_ent gives them oldest first
      entries.reverse();
      logs.push({ name, entries });
    }
  }
  return { refs, logs };
}

/** files_ref_store_create_on_disk plus the initial transaction: loose, packed, logs. */
async function writeFilesTarget(
  files: FilesApi,
  dir: string,
  content: SourceContent,
): Promise<void> {
  await files.mkdir(joinPath(dir, "refs", "heads"));
  await files.mkdir(joinPath(dir, "refs", "tags"));
  // files_transaction_finish_initial: symbolic refs and root refs loose, the rest packed
  // (sorted, unpeeled: the migration's updates carry no peeled value)
  const packed: MigratedRef[] = [];
  for (const ref of content.refs) {
    // each update locks its ref; once the lock is gone, try_remove_empty_parents removes
    // the empty directories below `refs/<kind>/`, which stays
    const parts = ref.name.split("/");
    if (parts[0] === "refs" && parts.length >= 3) {
      await files.mkdir(joinPath(dir, "refs", parts[1] as string));
    }
    const loose = ref.target !== undefined || !ref.name.startsWith("refs/");
    if (!loose) {
      packed.push(ref);
      continue;
    }
    const body = ref.target !== undefined ? `ref: ${ref.target}\n` : `${ref.objectId}\n`;
    await files.write(joinPath(dir, ref.name), text(body));
  }
  packed.sort((a, b) => compareRefNames(a.name, b.name));
  const lines = packed.map((r) => `${r.objectId} ${r.name}\n`).join("");
  await files.write(
    joinPath(dir, "packed-refs"),
    text(`# pack-refs with: peeled fully-peeled sorted \n${lines}`),
  );
  for (const log of content.logs) {
    if (log.entries.length === 0) continue;
    let body = "";
    for (const e of log.entries) {
      const message = normalizeReflogMessage(e.message);
      body += `${e.oldId} ${e.newId} ${e.name} <${e.email}> ${e.time} ${tzText(e.tz)}`;
      body += message ? `\t${message}\n` : "\n";
    }
    await files.write(joinPath(dir, "logs", log.name), text(body));
  }
}

/** reftable_be_create_on_disk plus its stubs and the initial transaction: one table. */
async function writeReftableTarget(
  files: FilesApi,
  dir: string,
  content: SourceContent,
  objectFormat: ObjectFormat,
  options: ReftableWriteOptions,
): Promise<void> {
  const stack = joinPath(dir, "reftable");
  await files.mkdir(stack);
  await files.write(joinPath(dir, "HEAD"), text(REFTABLE_HEAD_STUB));
  await files.write(joinPath(dir, "refs", "heads"), text(REFTABLE_HEADS_STUB));
  const reader = createReftableStackReader(files, stack, { objectFormat });
  const writer = createReftableStackWriter(files, stack, reader, {
    ...options,
    objectFormat,
    autoCompaction: false,
  });
  const addition = await writer.begin();
  const ts = addition.nextUpdateIndex;
  // write_transaction_table: refs at the transaction's index, each reflog entry at that
  // index plus its number in the migration's order (data->index++, from 0)
  const logs: ReftableLogWrite[] = [];
  let index = 0;
  for (const log of content.logs) {
    for (const e of log.entries) {
      logs.push({
        refName: log.name,
        updateIndex: ts + index++,
        update: {
          oldId: e.oldId,
          newId: e.newId,
          name: e.name,
          email: e.email,
          time: e.time,
          tzOffset: hhmmToMinutes(e.tz),
          message: normalizeReflogMessage(e.message),
        },
      });
    }
  }
  try {
    await addition.add({
      minUpdateIndex: ts,
      maxUpdateIndex: ts + Math.max(0, index - 1),
      refs: content.refs.map((ref) => ({
        name: ref.name,
        updateIndex: ts,
        value:
          ref.target !== undefined
            ? { type: "symref" as const, target: ref.target }
            : { type: "id" as const, id: ref.objectId as string },
      })),
      logs,
    });
    await addition.commit();
  } catch (error) {
    await addition.rollback().catch(() => undefined);
    throw error;
  }
}

/** git's has_worktrees: a `worktrees/<id>` whose `gitdir` file can be read. */
async function hasLinkedWorktrees(files: FilesApi, gitDir: string): Promise<boolean> {
  const dir = joinPath(gitDir, "worktrees");
  if ((await files.stats(dir))?.kind !== "directory") return false;
  for (const id of await listNames(files, dir)) {
    const bytes = await readBytes(files, joinPath(dir, id, "gitdir"));
    if (bytes && bytes.length > 0) return true;
  }
  return false;
}

/** Moves `from` onto `to` (a leftover at `to` removed first); throws git's message on failure. */
async function moveInto(files: FilesApi, from: string, to: string): Promise<void> {
  if ((await files.stats(to)) && (await files.stats(to))?.kind === "directory") {
    await files.remove(to);
  }
  if (!(await files.move(from, to))) {
    throw new Error(`could not link file '${from}' to '${to}'`);
  }
}

/** The config edits of initialize_repository_version(reinit) for `to`. */
async function writeRepositoryFormat(
  files: FilesApi,
  gitDir: string,
  to: RefStorageFormat,
  objectFormat: ObjectFormat,
): Promise<void> {
  const path = joinPath(gitDir, "config");
  const before = decodeGitPath((await readBytes(files, path)) ?? new Uint8Array(0));
  // the v1-only extensions left once refstorage changes (git re-reads the file for them)
  const others = new Set<string>();
  let section = "";
  for (const raw of before.split("\n")) {
    const line = raw.trim();
    const header = /^\[\s*([^\]\s"]+)\s*\]/.exec(line);
    if (header) {
      section = (header[1] as string).toLowerCase();
      continue;
    }
    if (section !== "extensions") continue;
    const key = /^([A-Za-z][A-Za-z0-9-]*)/.exec(line)?.[1]?.toLowerCase();
    if (!key || key === "refstorage") continue;
    if (
      [
        "noop-v1",
        "objectformat",
        "compatobjectformat",
        "relativeworktrees",
        "submodulepathconfig",
      ].includes(key)
    ) {
      others.add(key);
    }
  }
  const sha1 = objectFormat.name === SHA1_OBJECT_FORMAT.name;
  if (sha1) others.delete("objectformat");
  const v1 = !sha1 || to === "reftable" || others.size > 0;
  const outcome = await editConfigFile({ files, path, name: path }, [
    { key: "extensions.objectformat", value: sha1 ? undefined : objectFormat.name },
    { key: "extensions.refstorage", value: to === "reftable" ? "reftable" : undefined },
    { key: "core.repositoryformatversion", value: v1 ? "1" : "0" },
  ]);
  if (outcome.status !== 0) {
    throw new Error(
      outcome.stderr.map((l) => l.replace(/^error: /, "")).join("\n") || "could not write config",
    );
  }
}

/**
 * Migrates the repository's refs and reflogs to `options.to` (see the module's notes).
 *
 * @throws RefMigrationError with git's message: the repository has linked worktrees, the
 *   formats are equal, or a step failed (the repository is then in its old format)
 */
export async function migrateRefStorage(
  options: MigrateRefStorageOptions,
): Promise<MigrateRefStorageResult> {
  const { files, gitDir, to } = options;
  const format = await readRepositoryFormat(files, gitDir);
  const from = format.refStorage;
  const objectFormat = format.objectFormat;
  if (from === to) throw new RefMigrationError("current and new ref storage format are equal");
  if (await hasLinkedWorktrees(files, gitDir)) {
    throw new RefMigrationError("migrating repositories with worktrees is not supported yet");
  }

  // mkdtemp(<git dir>/ref_migration.XXXXXX)
  const suffix = options.suffix ?? randomSuffix;
  let migrationDir = "";
  for (let attempt = 0; ; attempt++) {
    const candidate = joinPath(gitDir, `ref_migration.${suffix()}`);
    if (!(await files.stats(candidate))) {
      migrationDir = candidate;
      break;
    }
    if (attempt > 100) {
      throw new RefMigrationError("cannot create migration directory: File exists");
    }
  }
  await files.mkdir(migrationDir);

  // the non-destructive phase: the new storage beside the old one
  try {
    const read = from === "files" ? readFilesSource : readReftableSource;
    const content = await read(files, gitDir, objectFormat, options.skipReflog === true);
    if (to === "files") await writeFilesTarget(files, migrationDir, content);
    else {
      await writeReftableTarget(files, migrationDir, content, objectFormat, options.reftable ?? {});
    }
  } catch (error) {
    await files.remove(migrationDir).catch(() => false);
    throw new RefMigrationError(error instanceof Error ? error.message : String(error));
  }
  if (options.dryRun) return { from, migrationDir, warnings: [] };

  return to === "reftable"
    ? swapToReftable(files, gitDir, migrationDir, objectFormat)
    : swapToFiles(files, gitDir, migrationDir, objectFormat);
}

/** The root ref files of a files git directory (HEAD excepted). */
async function rootRefFiles(files: FilesApi, gitDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listNames(files, gitDir)) {
    if (name.startsWith(".") || name.endsWith(".lock") || !isRootRefName(name)) continue;
    const kind = await kindOf(files, joinPath(gitDir, name));
    if (kind !== undefined && kind !== "directory") out.push(name);
  }
  return out;
}

async function swapToReftable(
  files: FilesApi,
  gitDir: string,
  migrationDir: string,
  objectFormat: ObjectFormat,
): Promise<MigrateRefStorageResult> {
  const stack = joinPath(gitDir, "reftable");
  // before the commit point: the stack goes in (a files repository never reads it)
  try {
    await moveInto(files, joinPath(migrationDir, "reftable"), stack);
    await writeRepositoryFormat(files, gitDir, "reftable", objectFormat);
  } catch (error) {
    if (!(await files.stats(joinPath(migrationDir, "reftable")))) {
      await files.remove(stack).catch(() => false);
    }
    await files.remove(migrationDir).catch(() => false);
    throw new RefMigrationError(error instanceof Error ? error.message : String(error));
  }
  // the commit point is behind: the old storage goes, the stubs come in
  const warnings: string[] = [];
  const step = async (what: () => Promise<unknown>) => {
    try {
      await what();
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  };
  await step(() => moveInto(files, joinPath(migrationDir, "HEAD"), joinPath(gitDir, "HEAD")));
  const refsDir = joinPath(gitDir, "refs");
  for (const name of await listNames(files, refsDir).catch(() => [])) {
    await step(() => files.remove(joinPath(refsDir, name)));
  }
  await step(() => files.remove(joinPath(gitDir, "logs")));
  for (const name of await rootRefFiles(files, gitDir).catch(() => [])) {
    await step(() => files.remove(joinPath(gitDir, name)));
  }
  await step(() => files.remove(joinPath(gitDir, "packed-refs")));
  await step(() =>
    moveInto(files, joinPath(migrationDir, "refs", "heads"), joinPath(refsDir, "heads")),
  );
  await step(() => files.remove(migrationDir));
  return { from: "files", migrationDir, warnings };
}

async function swapToFiles(
  files: FilesApi,
  gitDir: string,
  migrationDir: string,
  objectFormat: ObjectFormat,
): Promise<MigrateRefStorageResult> {
  const moved: string[] = [];
  const refsDir = joinPath(gitDir, "refs");
  const headsStub = joinPath(refsDir, "heads");
  const head = joinPath(gitDir, "HEAD");
  // before the commit point: everything the files storage reads goes in; a reftable
  // repository reads none of it (HEAD and refs/heads are stubs to it)
  try {
    // leftovers of an earlier run that stopped before its commit point
    for (const name of ["logs", "packed-refs", ...(await rootRefFiles(files, gitDir))]) {
      await files.remove(joinPath(gitDir, name));
    }
    if ((await files.stats(headsStub))?.kind === "file") await files.remove(headsStub);
    for (const name of await listNames(files, joinPath(migrationDir, "refs"))) {
      const to = joinPath(refsDir, name);
      await moveInto(files, joinPath(migrationDir, "refs", name), to);
      moved.push(to);
    }
    for (const name of await listNames(files, migrationDir)) {
      if (name === "refs" || name === "HEAD") continue;
      const to = joinPath(gitDir, name);
      await moveInto(files, joinPath(migrationDir, name), to);
      moved.push(to);
    }
    await moveInto(files, joinPath(migrationDir, "HEAD"), head);
    await writeRepositoryFormat(files, gitDir, "files", objectFormat);
  } catch (error) {
    // put the stubs back and take out what came in: the reftable repository as it was
    for (const path of moved) await files.remove(path).catch(() => false);
    await files.write(headsStub, text(REFTABLE_HEADS_STUB)).catch(() => undefined);
    await files.write(head, text(REFTABLE_HEAD_STUB)).catch(() => undefined);
    await files.remove(migrationDir).catch(() => false);
    throw new RefMigrationError(error instanceof Error ? error.message : String(error));
  }
  const warnings: string[] = [];
  for (const path of [joinPath(gitDir, "reftable"), migrationDir]) {
    try {
      await files.remove(path);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { from: "reftable", migrationDir, warnings };
}
