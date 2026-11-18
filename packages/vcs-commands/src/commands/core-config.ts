/**
 * The `core.*` settings that decide how the worktree is read and written.
 *
 * Read from the working copy's own configuration: this repository has no chain of
 * global and system configuration files, so a `core.symlinks` set only in `~/.gitconfig`
 * is not seen (native git would honour it).
 */

import {
  autoAbbrevLength,
  DEFAULT_ABBREV_LENGTH,
  findAbbrevLengths,
  type GitObjects,
  type ObjectId,
  parseCoreAbbrev,
} from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { WorkingCopy, Worktree, WorktreeModeTrust } from "@statewalker/vcs-working-tree";

import { RemoteConfigStore } from "../remote-config/index.js";

/**
 * A git boolean (`git_config_bool`: a key with no `=` is true, an empty value false), else
 * `fallback`.
 */
export function coreBool(workingCopy: WorkingCopy, name: string, fallback: boolean): boolean {
  return parseGitBool(RemoteConfigStore.from(workingCopy).value(`core.${name}`)) ?? fallback;
}

/**
 * Whether the worktree's executable bits and symbolic links are real: the worktree can
 * represent them and `core.filemode` / `core.symlinks` are not false.
 */
export function worktreeModeTrust(workingCopy: WorkingCopy, worktree: Worktree): WorktreeModeTrust {
  const minimal =
    RemoteConfigStore.from(workingCopy).value("core.checkStat")?.trim().toLowerCase() === "minimal";
  return {
    // inode, owner and group compared unless core.checkStat is minimal
    fullStat: !minimal,
    executable:
      worktree.capabilities?.executable !== false && coreBool(workingCopy, "filemode", true),
    symlinks: worktree.capabilities?.symlinks !== false && coreBool(workingCopy, "symlinks", true),
    // git compares ctime unless core.trustctime is false or core.checkStat is minimal
    ctime:
      coreBool(workingCopy, "trustctime", true) &&
      RemoteConfigStore.from(workingCopy).value("core.checkStat")?.trim().toLowerCase() !==
        "minimal",
  };
}

/** The values git's `core.disambiguate` takes (`set_disambiguate_hint_config`). */
export const DISAMBIGUATE_HINTS: readonly string[] = [
  "none",
  "commit",
  "committish",
  "tree",
  "treeish",
  "blob",
];

/**
 * What git dies with on loading its configuration (`git_default_core_config`, which every
 * command runs before it does anything, `status` included), else undefined: a
 * `core.disambiguate` it does not know, the first bad value in the configuration's order
 * (`error: unknown hint type for 'core.disambiguate': foo`, or for a variable without `=`
 * `error: missing value for 'core.disambiguate'`, then `fatal: bad config variable
 * 'core.disambiguate' in file '<file>' at line <n>`). A value with no file (set in memory)
 * fails as git's command-line config does.
 *
 * @example
 * ```typescript
 * const message = configLoadError(workingCopy);
 * if (message) throw new InvalidConfigError("core.disambiguate", message);
 * ```
 */
export function configLoadError(
  workingCopy: WorkingCopy,
): { key: string; message: string } | undefined {
  const key = "core.disambiguate";
  for (const { text, file, line } of RemoteConfigStore.from(workingCopy).valuesWithOrigin(key)) {
    if (text !== undefined && DISAMBIGUATE_HINTS.includes(text.toLowerCase())) continue;
    const error =
      text === undefined
        ? `error: missing value for '${key}'`
        : `error: unknown hint type for '${key}': ${text}`;
    const fatal =
      file !== undefined && line !== undefined
        ? `fatal: bad config variable '${key}' in file '${file}' at line ${line}`
        : `fatal: unable to parse '${key}' from command-line config`;
    return { key, message: `${error}\n${fatal}` };
  }
  return undefined;
}

/**
 * `id` abbreviated as git prints it (`repo_find_unique_abbrev(id, DEFAULT_ABBREV)`): to
 * `core.abbrev` digits (auto: from the approximate object count, at least 7), lengthened until
 * no other stored object shares them. Each call counts the objects again for the automatic
 * length; a command that abbreviates several ids uses one {@link createIdAbbreviator} (the
 * command's `abbreviateObjectId`) instead.
 *
 * @example
 * ```typescript
 * output.push(`Created autostash: ${await abbreviateId(workingCopy, stashId)}`);
 * ```
 */
export async function abbreviateId(workingCopy: WorkingCopy, id: ObjectId): Promise<string> {
  return createIdAbbreviator(workingCopy).abbreviate(id);
}

/**
 * The lengths git abbreviates `ids` to (`repo_find_unique_abbrev` with `DEFAULT_ABBREV`):
 * from `minLength`, else `core.abbrev` (auto: from the approximate object count), lengthened
 * until unique among the stored objects. Without an object store, the start length (7 for
 * auto).
 */
export async function abbrevLengths(
  workingCopy: WorkingCopy,
  ids: Iterable<ObjectId>,
  minLength?: number,
): Promise<Map<ObjectId, number>> {
  return createIdAbbreviator(workingCopy).lengths(ids, minLength);
}

/** Abbreviates ids for one command or operation; see {@link createIdAbbreviator}. */
export interface IdAbbreviator {
  /** `id` abbreviated as git prints it (see {@link abbreviateId}) */
  abbreviate(id: ObjectId): Promise<string>;
  /** The lengths of `ids` (see {@link abbrevLengths}) */
  lengths(ids: Iterable<ObjectId>, minLength?: number): Promise<Map<ObjectId, number>>;
}

/**
 * An abbreviator that counts the objects once, for the automatic length (`core.abbrev`
 * unset or "auto"), however many ids it abbreviates: git computes its approximate object
 * count once per process and keeps it (`approximate_object_count_valid`), and so does this
 * for its lifetime. Counting lists every object on stores without a cheap count (key-value,
 * SQL, memory), so a command abbreviating several ids (merge's `Updating a..b`, rebase's
 * todo backup) pays for one scan, not one per id. Objects written meanwhile are not
 * counted again, as in git; prefix uniqueness is still checked against the store each time.
 *
 * @example
 * ```typescript
 * const abbrev = createIdAbbreviator(workingCopy);
 * output.push(`Updating ${await abbrev.abbreviate(head)}..${await abbrev.abbreviate(src)}`);
 * ```
 */
export function createIdAbbreviator(workingCopy: WorkingCopy): IdAbbreviator {
  let autoLength: Promise<number> | undefined;
  const lengths = async (
    ids: Iterable<ObjectId>,
    minLength?: number,
  ): Promise<Map<ObjectId, number>> => {
    let start =
      minLength ?? parseCoreAbbrev(RemoteConfigStore.from(workingCopy).value("core.abbrev")) ?? -1;
    const objects = workingCopy.history?.objects;
    if (objects) {
      if (start < 0) {
        autoLength ??= countObjects(objects).then(autoAbbrevLength);
        start = await autoLength;
      }
      return findAbbrevLengths(objects, ids, start);
    }
    const fixed = start < 0 ? DEFAULT_ABBREV_LENGTH : start === 0 ? 40 : Math.min(start, 40);
    return new Map([...ids].map((id) => [id, fixed]));
  };
  return {
    lengths,
    async abbreviate(id) {
      const length = (await lengths([id])).get(id) ?? DEFAULT_ABBREV_LENGTH;
      return id.slice(0, length);
    },
  };
}

/** The approximate object count (`approximateCount`), else every object listed. */
async function countObjects(objects: GitObjects): Promise<number> {
  if (objects.approximateCount) return objects.approximateCount();
  let count = 0;
  for await (const _ of objects.list()) count++;
  return count;
}
