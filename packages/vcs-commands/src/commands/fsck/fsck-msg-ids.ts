/**
 * git's fsck message ids (`fsck.h`, `Documentation/fsck-msgids.txt`) and their severities, as
 * `fsck.<msg-id>` config, `receive.fsck.<msg-id>` and `--strict` adjust them.
 *
 * Ids are written in git's camel case (`duplicateEntries`), the spelling git prints and the
 * documentation uses. Config keys match case-insensitively and without underscores, as git's
 * `parse_msg_id` matches them (`fsck.duplicateentries`, `fsck.DUPLICATE_ENTRIES` are not the
 * same: git lowercases the key and drops underscores, so both match `duplicateEntries`).
 *
 * @example
 * ```typescript
 * const types = new FsckMessageTypes({ strict: true });
 * types.severity("zeroPaddedFilemode"); // "error" (a warning, made an error by --strict)
 * types.set("zeroPaddedFilemode", "ignore");
 * types.severity("zeroPaddedFilemode"); // "ignore"
 * ```
 */

/** A severity in git's table: `fatal` and `info` are reported as `error` and `warning`. */
export type FsckMsgLevel = "fatal" | "error" | "warn" | "info" | "ignore";

/** What a message is reported as. */
export type FsckSeverity = "error" | "warning" | "ignore";

/**
 * Every object message id git knows, with its default level, in git's order. The ref ids git
 * 2.45+ added for `git refs verify` (`badRefContent`, ...) are not here: fsck's ref database
 * checks are not done.
 */
export const FSCK_MSG_IDS = {
  // fatal errors
  nulInHeader: "fatal",
  unterminatedHeader: "fatal",
  // errors
  badDate: "error",
  badDateOverflow: "error",
  badEmail: "error",
  badGpgsig: "error",
  badHeaderContinuation: "error",
  badName: "error",
  badObjectSha1: "error",
  badParentSha1: "error",
  badTimezone: "error",
  badTree: "error",
  badTreeSha1: "error",
  badType: "error",
  duplicateEntries: "error",
  missingAuthor: "error",
  missingCommitter: "error",
  missingEmail: "error",
  missingNameBeforeEmail: "error",
  missingObject: "error",
  missingSpaceBeforeDate: "error",
  missingSpaceBeforeEmail: "error",
  missingTag: "error",
  missingTagEntry: "error",
  missingTree: "error",
  missingType: "error",
  missingTypeEntry: "error",
  multipleAuthors: "error",
  treeNotSorted: "error",
  unknownType: "error",
  zeroPaddedDate: "error",
  gitmodulesMissing: "error",
  gitmodulesBlob: "error",
  gitmodulesLarge: "error",
  gitmodulesName: "error",
  gitmodulesSymlink: "error",
  gitmodulesUrl: "error",
  gitmodulesPath: "error",
  gitmodulesUpdate: "error",
  gitattributesMissing: "error",
  gitattributesLarge: "error",
  gitattributesLineLength: "error",
  gitattributesBlob: "error",
  // warnings
  emptyName: "warn",
  fullPathname: "warn",
  hasDot: "warn",
  hasDotdot: "warn",
  hasDotgit: "warn",
  nullSha1: "warn",
  zeroPaddedFilemode: "warn",
  nulInCommit: "warn",
  largePathname: "warn",
  // infos (reported as warnings)
  badFilemode: "info",
  gitmodulesParse: "info",
  gitignoreSymlink: "info",
  gitattributesSymlink: "info",
  mailmapSymlink: "info",
  badTagName: "info",
  missingTaggerEntry: "info",
  // ignored unless asked for
  extraHeaderEntry: "ignore",
} as const satisfies Record<string, FsckMsgLevel>;

/** A message id, in git's camel case. */
export type FsckMsgId = keyof typeof FSCK_MSG_IDS;

/** A message id given in config or on the command line was not one git knows. */
export class UnknownFsckMsgIdError extends Error {
  override name = "UnknownFsckMsgIdError";
}

const BY_DOWNCASED = new Map<string, FsckMsgId>(
  (Object.keys(FSCK_MSG_IDS) as FsckMsgId[]).map((id) => [id.toLowerCase(), id]),
);

/**
 * The message id a config key or argument names (git's `parse_msg_id`: lowercased, underscores
 * dropped), or undefined.
 */
export function parseFsckMsgId(text: string): FsckMsgId | undefined {
  return BY_DOWNCASED.get(text.replace(/_/g, "").toLowerCase());
}

/**
 * The severities of one fsck run: git's defaults, `--strict` (warnings become errors, and the
 * nonstandard mode `100664` a bad file mode), then overrides from `fsck.<msg-id>`.
 */
export class FsckMessageTypes {
  readonly strict: boolean;
  /** git's max_tree_entry_len, set with `fsck.largePathname=<type>:<length>` */
  maxTreeEntryLength = 4096;
  private readonly overrides = new Map<FsckMsgId, "error" | "warn" | "ignore">();

  constructor(options: { strict?: boolean } = {}) {
    this.strict = options.strict === true;
  }

  /**
   * Sets a message's type (`error`, `warn` or `ignore`), as `fsck.<msg-id>=<type>` does.
   * `largePathname` takes `<type>:<length>` too. A fatal message can only be set to `error`.
   */
  set(msgId: string, type: string): void {
    const id = parseFsckMsgId(msgId);
    if (!id) throw new UnknownFsckMsgIdError(`Unhandled message id: ${msgId}`);
    let value = type;
    if (id === "largePathname") {
      const colon = value.indexOf(":");
      if (colon >= 0) {
        const length = Number(value.slice(colon + 1));
        if (!Number.isInteger(length)) {
          throw new UnknownFsckMsgIdError(
            `unable to parse max tree entry len: ${value.slice(colon + 1)}`,
          );
        }
        this.maxTreeEntryLength = length;
        value = value.slice(0, colon);
      }
    }
    if (value !== "error" && value !== "warn" && value !== "ignore") {
      throw new UnknownFsckMsgIdError(`Unknown fsck message type: '${value}'`);
    }
    if (value !== "error" && FSCK_MSG_IDS[id] === "fatal") {
      throw new UnknownFsckMsgIdError(`Cannot demote ${msgId} to ${value}`);
    }
    this.overrides.set(id, value);
  }

  /** The level a message has in this run, before fatal/info are folded (git's `fsck_msg_type`). */
  level(id: FsckMsgId): FsckMsgLevel {
    const override = this.overrides.get(id);
    if (override) return override;
    const level: FsckMsgLevel = FSCK_MSG_IDS[id];
    return this.strict && level === "warn" ? "error" : level;
  }

  /** What a message is reported as: fatal ones as errors, infos as warnings. */
  severity(id: FsckMsgId): FsckSeverity {
    const level = this.level(id);
    if (level === "ignore") return "ignore";
    return level === "fatal" || level === "error" ? "error" : "warning";
  }
}
