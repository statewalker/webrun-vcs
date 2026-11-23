/**
 * `fetch.fsckObjects` / `transfer.fsckObjects`: the fsck git's fetch-pack has index-pack run
 * over a received pack (`index-pack --strict=<fetch.fsck.* settings>`), as the fetch client's
 * `ReceivedObjectsFsck`.
 *
 * index-pack checks with `FSCK_OPTIONS_MISSING_GITMODULES`, a strict run: warnings are errors
 * unless `fetch.fsck.<msg-id>` sets them otherwise. Messages read `error: object <id>:
 * <msg-id>: <message>` (`warning: ...` for a warning); objects listed in `fetch.fsck.skipList`
 * report nothing.
 *
 * @example
 * ```ts
 * const fsck = await fetchFsckOf({ value: (key) => store.value(key), compatibility: "2.56" });
 * if (fsck) fetchOptions.fsckObjects = fsck;
 * ```
 */

import type { GitObjectTypeName, ReceivedObjectsFsck } from "@statewalker/vcs-transport";
import { parseGitBool } from "@statewalker/vcs-utils";

import { TransportError } from "../../errors/index.js";
import { FSCK_MSG_IDS, FsckMessageTypes, type FsckMsgId, parseFsckMsgId } from "./fsck-msg-ids.js";
import { fsckBlob, fsckCommit, fsckTag, fsckTree } from "./fsck-object-checks.js";

/** What {@link fetchFsckOf} reads. */
export interface FetchFsckSource {
  /** A configuration value, undefined when unset */
  value(key: string): string | undefined;
  /** Whose messages to give where 2.43 and 2.5x differ (a tag's `gpgsig` header) */
  compatibility: "2.43" | "2.56";
  /** Reads a host file (`fetch.fsck.skipList`); absent: a skip list cannot be read */
  readFile?(path: string): Promise<Uint8Array | undefined>;
  /** The directory a relative skip list path is read from (git's working directory: the worktree top) */
  baseDir?: string;
  /** `$HOME`, for a skip list path starting with `~/` */
  home?: string;
  /**
   * Every `fetch.fsck.*` variable in the configuration's order, keys canonical (lower case),
   * when the configuration can list them: git reads them so (fetch_pack_fsck_config), warns of
   * message ids it does not know and dies at the first demoted fatal one in that order.
   * Absent: each known message id is read with `value` (last value wins), unknown ones unseen.
   */
  entries?(prefix: string): { key: string; value: string | undefined }[] | undefined;
  /**
   * Receives the warnings git's fetch-pack prints when it starts (`warning: Skipping unknown
   * msg id '<id>'`): printed only when a fetch-pack conversation runs
   */
  warnings?: string[];
}

/**
 * The fsck of received objects git's fetch runs, or undefined when neither `fetch.fsckObjects`
 * nor (when that is unset) `transfer.fsckObjects` is true (`enabled` decides over both).
 *
 * A `fetch.fsck.<msg-id>` whose value is not `error`, `warn` or `ignore` throws git's `fatal:
 * Unknown fsck message type: '<value>'` (fetch-pack dies reading its settings, checked or not);
 * one demoting a fatal message makes index-pack die (`Cannot demote <id> to <type>`, the first
 * in the configuration's order where `entries` lists them). Message ids git does not know are
 * skipped with git's warning (`warnings`), and a `fetch.fsckObjects` or `transfer.fsckObjects`
 * that is no boolean throws git's `fatal: bad boolean config value`. git reads these settings
 * when fetch-pack starts, so an up-to-date fetch (no fetch-pack) does not die of them there;
 * ours reads them before the fetch.
 */
export async function fetchFsckOf(
  source: FetchFsckSource,
  enabled?: boolean,
): Promise<ReceivedObjectsFsck | undefined> {
  // fetch_pack_config's repo_config_get_bool: a value that is no boolean dies (both are read)
  const bool = (key: string) => {
    const v = source.value(key);
    if (v === undefined) return undefined;
    const parsed = parseGitBool(v);
    if (parsed === undefined) {
      throw new TransportError(`fatal: bad boolean config value '${v}' for '${key.toLowerCase()}'`);
    }
    return parsed;
  };
  const fetchFsck = bool("fetch.fsckObjects");
  const transferFsck = bool("transfer.fsckObjects");
  const on = enabled ?? fetchFsck ?? transferFsck ?? false;
  const types = new FsckMessageTypes({ strict: true });
  let startError: string | undefined;
  const setType = (id: FsckMsgId, value: string) => {
    // fetch_pack_fsck_config: is_valid_msg_type's parse_msg_type dies on any other value
    if (value !== "error" && value !== "warn" && value !== "ignore") {
      throw new TransportError(`fatal: Unknown fsck message type: '${value}'`);
    }
    // index-pack's fsck_set_msg_types, in the order of its --strict list: it dies at the first
    // fatal message demoted
    if (value !== "error" && FSCK_MSG_IDS[id] === "fatal") {
      startError ??= `fatal: Cannot demote ${id.toLowerCase()} to ${value}`;
      return;
    }
    types.set(id, value);
  };
  const listed = source.entries?.("fetch.fsck.");
  if (listed) {
    for (const { key, value } of listed) {
      const msgId = key.slice("fetch.fsck.".length);
      if (msgId === "skiplist" || value === undefined) continue;
      const id = parseFsckMsgId(msgId);
      if (!id) {
        source.warnings?.push(`warning: Skipping unknown msg id '${msgId}'`);
        continue;
      }
      setType(id, value);
    }
  } else {
    for (const id of Object.keys(FSCK_MSG_IDS) as FsckMsgId[]) {
      const value = source.value(`fetch.fsck.${id}`);
      if (value !== undefined) setType(id, value);
    }
  }
  if (!on) return undefined;

  // fetch.fsck.skipList: index-pack reads it when it starts (oidset_parse_file)
  const skip = new Set<string>();
  const skipList = source.value("fetch.fsck.skipList");
  if (skipList !== undefined && skipList !== "") {
    // git_config_pathname expands `~/`; a relative path is read from the worktree top
    const shown =
      skipList.startsWith("~/") && source.home
        ? `${source.home.replace(/\/+$/, "")}/${skipList.slice(2)}`
        : skipList;
    const path =
      !shown.startsWith("/") && source.baseDir
        ? `${source.baseDir.replace(/\/+$/, "")}/${shown}`
        : shown;
    const bytes = await source.readFile?.(path).catch(() => undefined);
    // (index-pack died on the message types already when startError is set)
    startError ??= parseSkipList(bytes, shown, skip);
  }

  return receivedObjectsFsck(types, skip, source.compatibility, startError);
}

/**
 * index-pack's (or unpack-objects') fsck of received objects under the message types `types`,
 * reporting nothing for the objects in `skip`; `startError` is the child's death before it
 * reads the pack.
 */
function receivedObjectsFsck(
  types: FsckMessageTypes,
  skip: ReadonlySet<string>,
  compatibility: "2.43" | "2.56",
  startError: string | undefined,
): ReceivedObjectsFsck {
  const gitmodulesFound = new Set<string>();
  const gitmodulesDone = new Set<string>();
  const gitattributesFound = new Set<string>();
  const gitattributesDone = new Set<string>();
  const reporter = (id: string, lines: string[]) => {
    const skipped = skip.has(id);
    return (msgId: FsckMsgId, message: string): number => {
      if (skipped) return 0;
      const severity = types.severity(msgId);
      if (severity === "ignore") return 0;
      lines.push(`${severity}: object ${id}: ${msgId}: ${message}`);
      return severity === "error" ? 1 : 0;
    };
  };
  const blobCheck = (id: string, content: Uint8Array, lines: string[]): number => {
    const gitmodules = gitmodulesFound.has(id);
    const gitattributes = gitattributesFound.has(id);
    if (!gitmodules && !gitattributes) return 0;
    if (gitmodules) gitmodulesDone.add(id);
    if (gitattributes) gitattributesDone.add(id);
    return fsckBlob(content, content.length, { gitmodules, gitattributes }, reporter(id, lines));
  };

  const fsck: ReceivedObjectsFsck = {
    ...(startError ? { startError } : {}),
    // index-pack's fsck of a blob looks at nothing but a .gitmodules or .gitattributes one
    // named by a tree already checked: any other is never read
    wantsBlob: (id: string) => gitmodulesFound.has(id) || gitattributesFound.has(id),
    checkObject(id: string, type: GitObjectTypeName, content: Uint8Array, lines: string[]) {
      const report = reporter(id, lines);
      switch (type) {
        case "commit":
          return !skip.has(id) && fsckCommit(content, report) !== 0;
        case "tag":
          return (
            !skip.has(id) && fsckTag(content, report, { gpgsig: compatibility !== "2.43" }) !== 0
          );
        case "tree": {
          const found = { gitmodules: [] as string[], gitattributes: [] as string[] };
          const r = fsckTree(
            content,
            types,
            report,
            (m) => {
              if (!skip.has(id)) lines.push(`error: ${m}`);
            },
            found,
          );
          for (const g of found.gitmodules) gitmodulesFound.add(g);
          for (const g of found.gitattributes) gitattributesFound.add(g);
          return r !== 0;
        }
        case "blob":
          return blobCheck(id, content, lines) !== 0;
      }
    },
    pendingBlobs() {
      return [
        ...[...gitmodulesFound].filter((id) => !gitmodulesDone.has(id)),
        ...[...gitattributesFound].filter(
          (id) => !gitattributesDone.has(id) && !gitmodulesFound.has(id),
        ),
      ];
    },
    checkPendingBlob(id, object, lines) {
      if (!object) return false;
      if (object.type === "blob") return blobCheck(id, object.content, lines) !== 0;
      let ret = 0;
      if (gitmodulesFound.has(id) && !gitmodulesDone.has(id)) {
        gitmodulesDone.add(id);
        ret |= reporter(id, lines)("gitmodulesBlob", "non-blob found at .gitmodules");
      }
      if (gitattributesFound.has(id) && !gitattributesDone.has(id)) {
        gitattributesDone.add(id);
        ret |= reporter(id, lines)("gitattributesBlob", "non-blob found at .gitattributes");
      }
      return ret !== 0;
    },
  };
  return fsck;
}

/**
 * oidset_parse_file over a skip list's bytes (undefined: it cannot be read), adding its ids to
 * `skip`: the line git dies with, or undefined.
 */
function parseSkipList(
  bytes: Uint8Array | undefined,
  shown: string,
  skip: Set<string>,
): string | undefined {
  if (!bytes) return `fatal: could not open object name list: ${shown}`;
  for (const raw of new TextDecoder().decode(bytes).split("\n")) {
    const hash = raw.indexOf("#");
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (line === "") continue;
    if (!/^[0-9a-fA-F]{40}$/.test(line)) return `fatal: invalid object name: ${line}`;
    skip.add(line.toLowerCase());
  }
  return undefined;
}

/** What {@link receiveFsckOf} reads: the receiving repository's configuration. */
export interface ReceiveFsckSource {
  /**
   * Every configuration entry in git's order, keys canonical (`receive.fsck.missingemail`), a
   * key written without `=` with a null value, and where it was read when known
   */
  entries(): Iterable<{ key: string; value: string | null; file?: string; line?: number }>;
  /** Whose messages to give where 2.43 and 2.5x differ (a tag's `gpgsig` header) */
  compatibility: "2.43" | "2.56";
  /** Reads a skip list (`receive.fsck.skipList`): its path as {@link baseDir} and `~/` make it */
  readFile?(path: string): Promise<Uint8Array | undefined>;
  /** The directory a relative skip list is read from (receive-pack's: the git directory) */
  baseDir?: string;
  /** `$HOME`, for a skip list path starting with `~/` */
  home?: string;
}

/** What git's receive-pack takes from `receive.fsck*` / `transfer.fsckObjects`. */
export interface ReceiveFsckSettings {
  /**
   * receive-pack's death reading its config (a value that is no boolean, a message type it
   * does not know, a `receive.fsck.*` key without a value): its lines
   */
  configError?: string;
  /** receive-pack's warnings reading its config (`warning: skipping unknown msg id '<id>'`) */
  warnings: string[];
  /** A new fsck for each push, absent when pushes are not checked */
  fsckObjects?: () => Promise<ReceivedObjectsFsck>;
}

/**
 * The fsck git's receive-pack has its unpack-objects or index-pack run over a push (`--strict`
 * with the `receive.fsck.*` settings) when `receive.fsckObjects` (else `transfer.fsckObjects`)
 * is true. receive-pack reads `receive.fsck.<msg-id>` and `receive.fsck.skipList` in config
 * order (never `fsck.*`): a message id it does not know is skipped with a warning, a message
 * type it does not know kills it (`fatal: Unknown fsck message type: '<type>'`), as does a key
 * without a value; the child then applies them in that order, dying at the first fatal message
 * demoted (`fatal: Cannot demote <id> to <type>`) or skip list it cannot read (`fatal: could not
 * open object name list: <path>`, `fatal: invalid object name: <line>`), relative paths read
 * from the git directory.
 *
 * @example
 * ```ts
 * const settings = receiveFsckOf({ entries: () => config.list(), compatibility: "2.56" });
 * const fsck = await settings.fsckObjects?.();
 * ```
 */
export function receiveFsckOf(source: ReceiveFsckSource): ReceiveFsckSettings {
  const warnings: string[] = [];
  let configError: string | undefined;
  let receiveFsck: boolean | undefined;
  let transferFsck: boolean | undefined;
  /** The `--strict=` list, in config order */
  const strict: Array<{ skipList: string } | { id: FsckMsgId; msgId: string; value: string }> = [];
  const die = (line: string) => {
    configError ??= line;
  };
  const nonBool = (entry: { key: string; file?: string; line?: number }) => {
    const error = `error: missing value for '${entry.key}'`;
    die(
      entry.file !== undefined && entry.line !== undefined
        ? `${error}\nfatal: bad config variable '${entry.key}' in file '${entry.file}' at line ${entry.line}`
        : error,
    );
  };
  const bool = (key: string, value: string | null): boolean | undefined => {
    if (value === null) return true;
    const parsed = parseGitBool(value);
    if (parsed === undefined) die(`fatal: bad boolean config value '${value}' for '${key}'`);
    return parsed;
  };
  for (const entry of source.entries()) {
    if (configError !== undefined) break;
    const key = entry.key.toLowerCase();
    const { value } = entry;
    if (key === "receive.fsck.skiplist") {
      // git_config_pathname: a key without a value is an error
      if (value === null) nonBool({ ...entry, key });
      else if (value !== "") strict.push({ skipList: value });
    } else if (key.startsWith("receive.fsck.")) {
      const msgId = key.slice("receive.fsck.".length);
      if (value === null) {
        nonBool({ ...entry, key });
        continue;
      }
      const id = parseFsckMsgId(msgId);
      if (!id) {
        warnings.push(`warning: skipping unknown msg id '${msgId}'`);
        continue;
      }
      if (value !== "error" && value !== "warn" && value !== "ignore") {
        die(`fatal: Unknown fsck message type: '${value}'`);
        continue;
      }
      strict.push({ id, msgId, value });
    } else if (key === "receive.fsckobjects") {
      receiveFsck = bool(key, value);
    } else if (key === "transfer.fsckobjects") {
      transferFsck = bool(key, value);
    }
  }
  if (configError !== undefined) return { configError, warnings };
  if (!(receiveFsck ?? transferFsck ?? false)) return { warnings };

  const fsckObjects = async (): Promise<ReceivedObjectsFsck> => {
    // the child's fsck_set_msg_types, in the order of its --strict list: it dies at the first
    // fatal message demoted or skip list it cannot read
    const types = new FsckMessageTypes({ strict: true });
    const skip = new Set<string>();
    let startError: string | undefined;
    for (const item of strict) {
      if ("skipList" in item) {
        const path = item.skipList;
        const shown =
          path.startsWith("~/") && source.home
            ? `${source.home.replace(/\/+$/, "")}/${path.slice(2)}`
            : path;
        const full =
          !shown.startsWith("/") && source.baseDir
            ? `${source.baseDir.replace(/\/+$/, "")}/${shown}`
            : shown;
        const bytes = await source.readFile?.(full).catch(() => undefined);
        startError = parseSkipList(bytes, shown, skip);
      } else if (item.value !== "error" && FSCK_MSG_IDS[item.id] === "fatal") {
        startError = `fatal: Cannot demote ${item.msgId} to ${item.value}`;
      } else {
        types.set(item.id, item.value as "error" | "warn" | "ignore");
      }
      if (startError !== undefined) break;
    }
    return receivedObjectsFsck(types, skip, source.compatibility, startError);
  };
  return { warnings, fsckObjects };
}
