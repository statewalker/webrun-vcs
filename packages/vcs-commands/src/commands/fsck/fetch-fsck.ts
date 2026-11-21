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
import { FSCK_MSG_IDS, FsckMessageTypes, type FsckMsgId } from "./fsck-msg-ids.js";
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
}

/**
 * The fsck of received objects git's fetch runs, or undefined when neither `fetch.fsckObjects`
 * nor (when that is unset) `transfer.fsckObjects` is true (`enabled` decides over both).
 *
 * A `fetch.fsck.<msg-id>` whose value is not `error`, `warn` or `ignore` throws git's `fatal:
 * Unknown fsck message type: '<value>'` (fetch-pack dies reading its settings, checked or not);
 * one demoting a fatal message makes index-pack die (`Cannot demote <id> to <type>`). Message
 * ids git does not know are not read (git skips them with a warning).
 */
export async function fetchFsckOf(
  source: FetchFsckSource,
  enabled?: boolean,
): Promise<ReceivedObjectsFsck | undefined> {
  const bool = (key: string) => {
    const v = source.value(key);
    return v === undefined ? undefined : parseGitBool(v);
  };
  const on = enabled ?? bool("fetch.fsckObjects") ?? bool("transfer.fsckObjects") ?? false;
  const types = new FsckMessageTypes({ strict: true });
  let startError: string | undefined;
  for (const id of Object.keys(FSCK_MSG_IDS) as FsckMsgId[]) {
    const value = source.value(`fetch.fsck.${id}`);
    if (value === undefined) continue;
    // fetch_pack_fsck_config: is_valid_msg_type's parse_msg_type dies on any other value
    if (value !== "error" && value !== "warn" && value !== "ignore") {
      throw new TransportError(`fatal: Unknown fsck message type: '${value}'`);
    }
    // index-pack's fsck_set_msg_type
    if (value !== "error" && FSCK_MSG_IDS[id] === "fatal") {
      startError ??= `fatal: Cannot demote ${id.toLowerCase()} to ${value}`;
      continue;
    }
    types.set(id, value);
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
    if (startError) {
      // index-pack died on the message types already
    } else if (!bytes) {
      startError = `fatal: could not open object name list: ${shown}`;
    } else {
      for (const raw of new TextDecoder().decode(bytes).split("\n")) {
        const hash = raw.indexOf("#");
        const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
        if (line === "") continue;
        if (!/^[0-9a-fA-F]{40}$/.test(line)) {
          startError = `fatal: invalid object name: ${line}`;
          break;
        }
        skip.add(line.toLowerCase());
      }
    }
  }

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
    checkObject(id: string, type: GitObjectTypeName, content: Uint8Array, lines: string[]) {
      const report = reporter(id, lines);
      switch (type) {
        case "commit":
          return !skip.has(id) && fsckCommit(content, report) !== 0;
        case "tag":
          return (
            !skip.has(id) &&
            fsckTag(content, report, { gpgsig: source.compatibility !== "2.43" }) !== 0
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
