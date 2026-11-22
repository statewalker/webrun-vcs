import {
  badPackIntIdAt,
  type CommitGraph,
  commitGraphCompatible,
  type FilesApi,
  type GitObject,
  type GitObjects,
  type GraphCommitData,
  graftFileBaseDir,
  graftFileReader,
  isSymbolicRef,
  loadMultiPackIndex,
  objectsWithoutLazyFetch,
  openPack,
  type PackFile,
  type PackIndex,
  PromisorObjectReadError,
  parseGraftFile,
  parseGraphCommit,
  type Refs,
  readCommitGraph,
  readPackIndex,
  runSteps,
  type Steps,
  scanPackObjects,
  type Trees,
  verifyCommitGraph,
} from "@statewalker/vcs-core";
import { multiPackIndexVerify } from "@statewalker/vcs-store-files";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import { readFile } from "@statewalker/vcs-utils/files";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import {
  type CacheTree,
  IndexCorruptError,
  parseCacheTree,
  parseResolveUndo,
  type ResolveUndoRecord,
  readIndexFileEntries,
  type Staging,
} from "@statewalker/vcs-working-tree";
import { GitCommand } from "../../git-command.js";
import { RemoteConfigStore } from "../../remote-config/index.js";
import { hostEnvironmentOf } from "../git-ident.js";
import { configBool, configValue } from "../merge-config.js";
import { hasPromisorRemote } from "../promisor-remote.js";
import { DEFAULT_BIG_FILE_THRESHOLD, readLooseObject } from "./fsck-loose.js";
import { FSCK_MSG_IDS, FsckMessageTypes, type FsckMsgId } from "./fsck-msg-ids.js";
import {
  canonMode,
  fsckBlob,
  fsckCommit,
  fsckTag,
  fsckTree,
  hexIdAt,
  parseCommitLinks,
  parseTagBuffer,
  rawIdAt,
  scanTree,
  type TreeEntryTable,
} from "./fsck-object-checks.js";
import {
  HAS_OBJ,
  OBJ_BLOB,
  OBJ_COMMIT,
  OBJ_NONE,
  OBJ_TAG,
  OBJ_TREE,
  ObjectTable,
  type ObjType,
  PARSED,
  REACHABLE,
  SEEN,
  TYPE_NAME,
  typeOf,
  USED,
} from "./fsck-object-table.js";
import { checkPack, collect, objectIdOf } from "./fsck-pack.js";

/** Exit status bits, as `git fsck` returns them (git 2.43's builtin/fsck.c). */
export const FSCK_ERROR_OBJECT = 0o1;
export const FSCK_ERROR_REACHABLE = 0o2;
export const FSCK_ERROR_PACK = 0o4;
export const FSCK_ERROR_REFS = 0o10;
/** `git commit-graph verify` failed (git's ERROR_COMMIT_GRAPH). */
export const FSCK_ERROR_COMMIT_GRAPH = 0o20;
/** `git multi-pack-index verify` failed, in git 2.43 (its ERROR_MULTI_PACK_INDEX; 2.5x: object bit). */
export const FSCK_ERROR_MULTI_PACK_INDEX_243 = 0o40;
/** A bitmap file's checksum is wrong, in git 2.43 (its ERROR_BITMAP; 2.5x sets the object bit). */
export const FSCK_ERROR_BITMAP_243 = 0o200;

/** What one line of fsck's output reports. */
export type FsckFindingKind =
  /** a reachable object that is not stored (`missing <type> <id>`) */
  | "missing"
  /** an unreachable object nothing points to (`dangling <type> <id>`) */
  | "dangling"
  /** an unreachable object, with `--unreachable` */
  | "unreachable"
  /** a reachable object points to one that is not stored (`broken link from ...`) */
  | "broken-link"
  /** a message of git's object checks (`error in tree <id>: duplicateEntries: ...`) */
  | "object"
  /** `root <id>`, with `--root` */
  | "root"
  /** `tagged <type> <id> (<name>) in <id>`, with `--tags` */
  | "tagged"
  /** anything else git prints with `error()` (corrupt objects and packs, bad refs) */
  | "error"
  /** `notice: ...` and `bad sha1 file: ...` */
  | "notice"
  /** what `git commit-graph verify` prints (fsck runs it unless `core.commitGraph` is false) */
  | "commit-graph"
  /** what `git multi-pack-index verify` prints (unless `core.multiPackIndex` is false) */
  | "multi-pack-index";

/** One line of output, as git prints it, with what it is about. */
export interface FsckFinding {
  kind: FsckFindingKind;
  /** Where git prints it. */
  stream: "stdout" | "stderr";
  /** The line, without its newline. */
  text: string;
  objectId?: string;
  objectType?: string;
  /** The message id of an `object` finding. */
  msgId?: FsckMsgId;
  /** How an `object` finding was reported. */
  severity?: "error" | "warning";
}

/** Result of `git fsck`. */
export interface FsckResult {
  /** git's exit status: the `FSCK_ERROR_*` bits that apply (0 when nothing is wrong). */
  exitCode: number;
  /** Every line, in the order git prints them. */
  findings: FsckFinding[];
  /** What git prints on stdout. */
  output: string;
  /** What git prints on stderr. */
  errorOutput: string;
  /**
   * The work behind the result: objects read whole from the store (`objectsRead`; the
   * sequential pack checks of a full run are not counted) and, in `--connectivity-only` runs,
   * commits whose tree and parents came from the commit-graph instead (`commitsFromGraph`).
   * A `--connectivity-only` run unpacks the commits and trees of each pack in one read in
   * pack order first (`objectsScanned` of them); `objectsRead` counts the objects the walk
   * takes from that read as well, once each, as it counts those it reads from the store.
   * What is kept in memory from the reads in pack order is bounded (`setMemoryLimits`):
   * `linksKept` tree entries and commit links (the walk reads the others from the store) and
   * `graphCommitsKept` commits for the commit-graph verification (it reads the others).
   */
  statistics: {
    objectsRead: number;
    commitsFromGraph: number;
    objectsScanned: number;
    linksKept: number;
    graphCommitsKept: number;
  };
}

/** What a run keeps in memory from the reads in pack order (`FsckCommand.setMemoryLimits`). */
export interface FsckMemoryLimits {
  /**
   * Tree entries and commit links kept for the walk (4 bytes each), in all: those of the
   * pack-order scan and of the trees the walk records. 32 Mi by default; 0 keeps none.
   */
  links?: number;
  /** Commits kept for the commit-graph verification: 256 Ki by default. */
  graphCommits?: number;
}

const DEFAULT_LINKS_KEPT = 32 * 1024 * 1024;
const DEFAULT_GRAPH_COMMITS_KEPT = 256 * 1024;

/** The git version whose output `FsckCommand` reproduces where versions differ. */
export type FsckCompatibility = "2.43" | "2.56";

/** The files of a git repository, for the checks that read them (`setRepositoryFiles`). */
export interface FsckRepositoryFiles {
  files: FilesApi;
  /** Path of the `.git` directory within `files` (default ".git"). */
  gitDir?: string;
}

const ZERO_ID = "0000000000000000000000000000000000000000";
const OID = /^[0-9a-f]{40}$/;
const LOOSE_NAME = /^[0-9a-f]{38}$/;
const PACK_IDX = /^pack-[0-9a-f]{40}\.idx$/;
/** Refs one worktree has of its own (git's `is_per_worktree_ref`). */
const PER_WORKTREE = /^(?:refs\/(?:bisect|worktree|rewritten)\/|[A-Z_]+$)/;
const dec = new TextDecoder();
const EMPTY = new Uint8Array(0);

/** A config value git dies on (`bad numeric config value`), as `call` reports it. */
export class FsckConfigError extends Error {
  override name = "FsckConfigError";
}

/**
 * A git size setting as `git_config_ulong` parses it: `strtoumax` (leading blanks, an optional
 * `+`, decimal, `0x` hex or `0` octal) then an optional k, m or g. Undefined when unset; a value
 * git dies on throws `FsckConfigError` with git's message.
 */
function sizeValue(key: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const bad = (why: string) =>
    new FsckConfigError(`bad numeric config value '${value}' for '${key.toLowerCase()}': ${why}`);
  if (value.includes("-")) throw bad("invalid unit");
  const m = /^[ \t\n\v\f\r]*\+?(?:(0[xX])([0-9a-fA-F]+)|(0[0-7]*)|([1-9][0-9]*))(.*)$/s.exec(value);
  if (!m) throw bad("invalid unit");
  const digits = m[2] ?? m[3] ?? (m[4] as string);
  const n =
    m[2] !== undefined
      ? BigInt(`0x${digits}`)
      : m[3] !== undefined
        ? BigInt(`0o${digits}`)
        : BigInt(digits);
  const unit = ({ "": 1n, k: 1024n, m: 1024n ** 2n, g: 1024n ** 3n } as Record<string, bigint>)[
    (m[5] as string).toLowerCase()
  ];
  if (unit === undefined) throw bad("invalid unit");
  if (n * unit > 2n ** 64n - 1n) throw bad("out of range");
  return Number(n * unit);
}

/** A path within the repository's files, as git prints it (`.git/objects/ab/cd...`). */
const pathOf = (...parts: string[]) => parts.join("/");

/**
 * Whether git's parse_commit_buffer reads past a commit's tree line (to its grafts): the data
 * is longer than `tree <40 hex digits>\n`, starts with it, and the digits are hex.
 */
function treeLineSound(data: Uint8Array): boolean {
  if (data.length <= 46 || data[45] !== 0x0a) return false;
  for (let i = 0; i < 5; i++) if (data[i] !== "tree ".charCodeAt(i)) return false;
  for (let i = 5; i < 45; i++) {
    const c = data[i] as number;
    if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46)))
      return false;
  }
  return true;
}

/**
 * Verify the connectivity and validity of the objects in the repository.
 *
 * Equivalent to `git fsck --no-references`, after git's `builtin/fsck.c` and `fsck.c` (2.56 by
 * default, 2.43 with `setCompatibility`): every stored object is read and checked (git's
 * message ids, severities and texts, `fsck.<msg-id>` config and `--strict`), then everything reachable from the refs, the reflogs, the index (its
 * entries, cache-tree and resolve-undo), the HEADs of linked worktrees and the stash is
 * walked, and objects that are missing, dangling or (with `--unreachable`) unreachable are
 * listed in git's order.
 *
 * Over a files repository (`setRepositoryFiles`) loose objects are read from their files
 * (zlib streams, headers and hashes checked as git checks them) and packs are verified as
 * git's `verify_pack` does (idx and pack checksums, each entry's CRC-32 and hash); reflogs,
 * index files and linked worktrees are read from `.git`. Over any other store the objects of
 * `history.objects` are read and checked, the reflogs come from `refs.getReflog` and the index
 * from the staging area.
 *
 * Memory holds per object only its type, a few flags and a commit's tree and parents (as git
 * does), and for a tree checked in full the object numbers of its entries (so the connectivity
 * walk does not unpack it again); contents are read one object at a time. Packs are checked in
 * one sequential read each (see `fsck-pack.ts`); `--connectivity-only` inflates no blob (a
 * dangling one's type comes from its pack entry's header).
 *
 * Over a files repository the commit-graph is verified as git's fsck runs `git commit-graph
 * verify` (unless `core.commitGraph` is false): its messages follow the rest on stderr and a
 * failure sets exit bit 16 (`FSCK_ERROR_COMMIT_GRAPH`).
 *
 * In a partial clone (a promisor remote) the promisor objects are taken as git's fsck takes
 * them (`is_promisor_object`: the objects of promisor packs and the objects they name): marked
 * reachable without being walked further, never reported missing, valid as ref and reflog
 * values; nothing is fetched lazily while fsck runs.
 *
 * The multi-pack-index is verified as git runs `git multi-pack-index verify` for each source
 * (unless `core.multiPackIndex` is false): 2.5x after the source's packs (object bit), 2.43 last
 * (exit bit 040); a midx git refuses fatally on load ends fsck with status 128.
 *
 * Not done: the ref database checks of `git refs verify` (git 2.45+),
 * reverse-index verification, the commit-graphs
 * of alternates, `fsck.skipList`, and explicit `<object>` heads. The objects of alternates
 * (`history.objects.alternates`) are read and checked as git's default `--full` reads them
 * (their dangling objects listed too): 2.56 source by source, 2.43 every source's loose
 * objects, then every pack.
 *
 * @example
 * ```typescript
 * const result = await git.fsck().setRepositoryFiles({ files }).setUnreachable(true).call();
 * process.stdout.write(result.output);
 * process.stderr.write(result.errorOutput);
 * process.exitCode = result.exitCode;
 * ```
 */
export class FsckCommand extends GitCommand<FsckResult> {
  private _strict = false;

  /** git's fsck and gc read the objects as stored, never through replace refs. */
  protected override readsReplacedObjects(): boolean {
    return false;
  }
  private _connectivityOnly = false;
  private _dangling = true;
  private _unreachable = false;
  private _reflogs = true;
  private _nameObjects = false;
  private _root = false;
  private _tags = false;
  private _lostFound = false;
  private _compatibility: FsckCompatibility = "2.56";
  private _limits: FsckMemoryLimits = {};
  private _repository?: FsckRepositoryFiles;
  private readonly _messageTypes: [string, string][] = [];

  /** `--strict`: warnings are errors, and mode 100664 a bad file mode. */
  setStrict(strict: boolean): this {
    this.checkCallable();
    this._strict = strict;
    return this;
  }

  /** `--connectivity-only`: check only that reachable objects are there, not their contents. */
  setConnectivityOnly(connectivityOnly: boolean): this {
    this.checkCallable();
    this._connectivityOnly = connectivityOnly;
    return this;
  }

  /** `--[no-]dangling` (on by default): list unreachable objects nothing points to. */
  setDangling(dangling: boolean): this {
    this.checkCallable();
    this._dangling = dangling;
    return this;
  }

  /** `--unreachable`: list every unreachable object. */
  setUnreachable(unreachable: boolean): this {
    this.checkCallable();
    this._unreachable = unreachable;
    return this;
  }

  /** `--[no-]reflogs` (on by default): reflog entries are roots. */
  setReflogs(reflogs: boolean): this {
    this.checkCallable();
    this._reflogs = reflogs;
    return this;
  }

  /** `--name-objects`: name reachable objects by how they were reached (`HEAD~2:src/`). */
  setNameObjects(nameObjects: boolean): this {
    this.checkCallable();
    this._nameObjects = nameObjects;
    return this;
  }

  /** `--root`: report root commits. */
  setRoot(root: boolean): this {
    this.checkCallable();
    this._root = root;
    return this;
  }

  /** `--tags`: report tags. */
  setTags(tags: boolean): this {
    this.checkCallable();
    this._tags = tags;
    return this;
  }

  /**
   * `--lost-found`: write dangling objects to `.git/lost-found/commit/<id>` and
   * `.git/lost-found/other/<id>` (blobs with their content, others with their id). Needs
   * `setRepositoryFiles`; turns reflogs off, as git does.
   */
  setLostFound(lostFound: boolean): this {
    this.checkCallable();
    this._lostFound = lostFound;
    return this;
  }

  /**
   * Which git's output to reproduce where versions differ (default `2.56`):
   *  - `2.56` (the default) is `git fsck --no-references` of git 2.45+: the refs and worktree
   *    HEADs are read (and created in the object hash) before the objects, then their reflogs;
   *    HEAD itself is not checked (`HEAD points to an unborn branch`, `HEAD points to something
   *    strange`, `detached HEAD points at nothing` and `invalid HEAD` moved to git's
   *    `refs verify`, which is not implemented, and which plain `git fsck` runs first); an
   *    unparsable object is `<id>: object corrupt or missing`; a bad pack sets bit 1; a tag's
   *    `gpgsig` header after the tagger is not an extra header;
   *  - `2.43`: refs are read after the objects; HEAD and the HEADs of linked worktrees are
   *    checked (`notice: HEAD points to an unborn branch`, `HEAD points to something strange`,
   *    `detached HEAD points at nothing`, following symbolic refs to the end of the chain); an
   *    object that cannot be parsed is `<id>: object could not be parsed: <path>`; a bad pack
   *    sets exit bit 4 (`FSCK_ERROR_PACK`); a tag's `gpgsig` header is an `extraHeaderEntry`.
   */
  setCompatibility(version: FsckCompatibility): this {
    this.checkCallable();
    this._compatibility = version;
    return this;
  }

  /**
   * Bounds what the run keeps from its reads in pack order (the trees and commits a full run
   * checks, the commits and trees a `--connectivity-only` run unpacks first, the commits the
   * commit-graph verification compares): past them the objects are read from the store again
   * when needed. The output is the same whatever the limits.
   */
  setMemoryLimits(limits: FsckMemoryLimits): this {
    this.checkCallable();
    this._limits = { ...limits };
    return this;
  }

  /** `fsck.<msg-id>=<type>` for this run (`error`, `warn` or `ignore`), after the config's. */
  setMessageType(msgId: string, type: string): this {
    this.checkCallable();
    this._messageTypes.push([msgId, type]);
    return this;
  }

  /**
   * The repository's files: loose objects, packs, reflogs, index files and linked worktrees
   * are then read and checked as git reads them.
   */
  setRepositoryFiles(repository: FsckRepositoryFiles): this {
    this.checkCallable();
    this._repository = repository;
    return this;
  }

  async call(): Promise<FsckResult> {
    this.checkCallable();
    this.setCallable(false);
    const types = new FsckMessageTypes({ strict: this._strict });
    for (const id of Object.keys(FSCK_MSG_IDS)) {
      const value = configValue(this.workingCopy, `fsck.${id}`);
      if (value !== undefined) types.set(id, value);
    }
    for (const [id, type] of this._messageTypes) types.set(id, type);
    // git dies on a bad value when it reads the config, before it checks anything
    const bigFileThreshold =
      sizeValue("core.bigFileThreshold", configValue(this.workingCopy, "core.bigFileThreshold")) ??
      DEFAULT_BIG_FILE_THRESHOLD;
    const stored = this.workingCopy.history.objects;
    if (!stored) throw new Error("fsck needs the object store (history.objects)");
    // fsck knows how to handle missing promisor objects (fetch_if_missing = 0): in a partial
    // clone it reads through the store's view without lazy fetch
    const partial =
      stored.promisor !== undefined && hasPromisorRemote(RemoteConfigStore.from(this.workingCopy));
    const objects = partial ? objectsWithoutLazyFetch(stored) : stored;
    const stores: RunStores = {
      refs: this.refsStore,
      staging: () => this.staging,
      trees: () => this.storedTrees,
    };
    const promisor = objects.promisor;
    const loadPromised =
      promisor && partial
        ? (skipUnreadable?: boolean) => promisor.promisedObjects({ skipUnreadable })
        : undefined;
    const run = new FsckRun(stores, objects, types, {
      ...(loadPromised ? { loadPromised } : {}),
      connectivityOnly: this._connectivityOnly,
      dangling: this._dangling,
      unreachable: this._unreachable,
      reflogs: this._reflogs && !this._lostFound,
      nameObjects: this._nameObjects,
      root: this._root,
      tags: this._tags,
      lostFound: this._lostFound,
      compatibility: this._compatibility,
      repository: this._repository,
      // git's fsck reads every source (`--full`, the default): the alternates' objects too
      alternateDirs: this._repository
        ? ((await objects.alternates?.list()) ?? []).map((a) => a.objectsDir)
        : [],
      bigFileThreshold,
      linksKept: Math.max(0, this._limits.links ?? DEFAULT_LINKS_KEPT),
      graphCommitsKept: Math.max(0, this._limits.graphCommits ?? DEFAULT_GRAPH_COMMITS_KEPT),
      graftsAdvice: configBool(this.workingCopy, "advice.graftFileDeprecated", true),
      readGraftFile: graftFileReader(
        hostEnvironmentOf(this.workingCopy),
        this._repository
          ? {
              files: this._repository.files,
              dir: graftFileBaseDir(
                this._repository.gitDir ?? ".git",
                configBool(this.workingCopy, "core.bare", false) || undefined,
              ),
            }
          : this.graftFileBase(),
      ),
      multiPackIndex: configBool(this.workingCopy, "core.multiPackIndex", true),
      commitGraph: {
        enabled: configBool(this.workingCopy, "core.commitGraph", true),
        generationVersion:
          intValue(configValue(this.workingCopy, "commitGraph.generationVersion")) ?? 2,
        changedPathsVersion:
          intValue(configValue(this.workingCopy, "commitGraph.changedPathsVersion")) ??
          (configBool(this.workingCopy, "commitGraph.readChangedPaths", true) ? -1 : 0),
      },
    });
    const result = await run.run();
    // git prints the alternates' error lines when it first reads an object: first on stderr
    // (once here; git repeats them in its child processes)
    const alternates = this.alternatesErrors();
    if (alternates.length === 0) return result;
    return {
      ...result,
      findings: [
        ...alternates.map((text): FsckFinding => ({ kind: "error", stream: "stderr", text })),
        ...result.findings,
      ],
      errorOutput: `${alternates.map((l) => `${l}\n`).join("")}${result.errorOutput}`,
    };
  }
}

/** The stores a run reads besides the objects. */
interface RunStores {
  refs: Refs;
  /** The trees as stored (a sparse index expands from them) */
  trees: () => Pick<Trees, "load" | "store">;
  /** The staging area (throws when the working copy has none). */
  staging: () => Staging;
}

interface RunOptions {
  /**
   * A partial clone's promisor objects (git's `is_promisor_object`): reachable without being
   * walked, never missing, valid ref and reflog values; absent outside a partial clone
   */
  promised?: ReadonlySet<string>;
  /**
   * Reads {@link promised} when the walk first asks (git's `is_promisor_object` builds the
   * set on its first call): an object of a promisor pack that cannot be read is git's death
   * there (2.5x asks for every reachable object; 2.43 only for a missing one, so ours reads
   * no set then)
   */
  loadPromised?: (skipUnreadable?: boolean) => Promise<ReadonlySet<string>>;
  connectivityOnly: boolean;
  dangling: boolean;
  unreachable: boolean;
  reflogs: boolean;
  nameObjects: boolean;
  root: boolean;
  tags: boolean;
  lostFound: boolean;
  compatibility: FsckCompatibility;
  repository?: FsckRepositoryFiles;
  /** `core.bigFileThreshold`: larger loose blobs are streamed */
  bigFileThreshold: number;
  /** `advice.graftFileDeprecated` (on by default) */
  graftsAdvice: boolean;
  /**
   * The grafts file's text, read in place of `info/grafts` (git's `GIT_GRAFT_FILE`);
   * undefined when that file does not exist. Unset: `info/grafts` is read.
   */
  readGraftFile?: () => Promise<string | undefined>;
  /** Tree entries and commit links kept from the reads in pack order, at most */
  linksKept: number;
  /** Commits kept for the commit-graph verification, at most */
  graphCommitsKept: number;
  /** `core.commitGraph` and the graph read settings, for `git commit-graph verify` */
  commitGraph: { enabled: boolean; generationVersion: number; changedPathsVersion: number };
  /** `core.multiPackIndex`: fsck runs `git multi-pack-index verify` for each source */
  multiPackIndex?: boolean;
  /** The alternates' objects directories in `repository.files`, in git's order */
  alternateDirs?: readonly string[];
}

/** A git integer setting (decimal), undefined when unset or not a number. */
function intValue(value: string | undefined): number | undefined {
  if (value === undefined || !/^\s*[-+]?\d+\s*$/.test(value)) return undefined;
  return Number.parseInt(value, 10);
}

/** A pack of the repository, with its idx read (for `has_object_pack`). */
interface RepoPack {
  packPath: string;
  idxPath: string;
  idx: PackIndex;
  /** The idx file, read once for the listing, the checks and the open */
  idxBytes: Uint8Array;
  /** The object directory it is in: 0 the repository's, then its alternates' */
  source: number;
}

/** An object read whole. */
interface Whole {
  type: string;
  content: Uint8Array;
}

/** The reflog of one ref: its name as git prints it and its entries, oldest first. */
interface Reflog {
  name: string;
  /** The file it was read from, as git prints it (none when read through the refs store) */
  path?: string;
  entries: { oldId: string; newId: string; timestamp: number }[];
}

/** One worktree's state: its HEAD, its reflogs and its index. */
interface WorktreeState {
  /** `HEAD`, or `worktrees/<id>/HEAD` */
  headName: string;
  /** Where the worktree's files are (the `.git` dir or `.git/worktrees/<id>`) */
  dir?: string;
  current: boolean;
}

/** One `git fsck` run (builtin/fsck.c's globals). */
class FsckRun {
  private readonly t = new ObjectTable();
  private readonly findings: FsckFinding[] = [];
  private errorsFound = 0;
  private readonly pending: number[] = [];
  private readonly names?: Map<string, string>;
  private defaultRefs = 0;
  private showUnreachable: boolean;
  private readonly gitmodulesFound = new Set<string>();
  private readonly gitmodulesDone = new Set<string>();
  private readonly gitattributesFound = new Set<string>();
  private readonly gitattributesDone = new Set<string>();
  private shallow = new Set<string>();
  /** A partial clone's promisor objects, once read (see `RunOptions.loadPromised`) */
  private promised?: ReadonlySet<string>;
  /** git 2.43's death when the walk first asks about a promisor object (see `run`) */
  private promisorDeathAt?: { at: number; error: PromisorObjectReadError };
  /** the first midx entry whose pack-int-id is out of range (git dies when it reads it) */
  private midxBadEntry?: { id: string; line: string };
  /**
   * The commit grafts of `info/grafts` (git's parse_commit_buffer gives a grafted commit those
   * parents, its own not looked up), and what reading them reported, printed when the first
   * commit is parsed
   */
  private grafts?: Map<string, string[]>;
  private graftErrors: string[] = [];
  /** The grafts file's errors, as every process that reads the file prints them */
  private graftErrorLines: string[] = [];
  /** Whether there is a grafts file (`info/grafts`, or the one `GIT_GRAFT_FILE` names) */
  private graftFileExists = false;
  private packs: RepoPack[] = [];
  /**
   * Trees checked in full, as their entries' objects: object number -> start in `kids`, where
   * the entry count comes first, then `(object << 1) | isTree` per entry (gitlinks left out).
   * Only for trees whose entries all resolved, in full runs without `--name-objects`, so the
   * connectivity walk need not read them again (git reads them again: a few bytes per entry
   * here against unpacking every tree twice). Indexed by object number, holding start + 1 (0 for
   * a tree not recorded).
   */
  private treeStart = new Int32Array(0);
  /** The table `walkUsed` decodes each tree into (one tree at a time). */
  private readonly usedTable: TreeEntryTable = { count: 0, fields: new Int32Array(0) };
  /** The table the connectivity walk decodes each tree into. */
  private readonly walkTable: TreeEntryTable = { count: 0, fields: new Int32Array(0) };
  private kids = new Int32Array(0);
  private kidsLength = 0;
  /** The tree `walkUsed` decoded last, for `fsckTree` to check without decoding it again. */
  private lastTree?: { content: Uint8Array; table: TreeEntryTable };
  /** Whether `walkUsed` records the trees it walks (`treeEntries`). */
  private readonly recordTrees: boolean;
  /**
   * Objects with a copy that failed a check: the connectivity walk reads these from the store
   * (which may read that copy), never from `treeEntries`.
   */
  private readonly badCopy = new Set<string>();
  /** Where an id parsed from hex is written for a lookup. */
  private readonly idScratch = new Uint8Array(20);
  /**
   * The object `parseObject` read last: the connectivity walk of a tree it parsed walks these
   * bytes instead of reading the tree again (git's parse_tree reads it once).
   */
  private lastRead?: { id: string; obj: Whole };
  /**
   * The commit-graph (connectivity-only runs): git's repo_parse_commit takes a commit's tree
   * and parents from it (parse_commit_in_graph) instead of reading the commit.
   */
  private graph?: CommitGraph;
  /** Commits parsed from the graph: commits not read from the object store */
  private graphParsed = 0;
  /** Objects read whole from the store (`readWhole`) */
  private objectsRead = 0;
  /** Objects the pack-order scan of a connectivity-only run unpacked. */
  private objectsScanned = 0;
  /**
   * What the pack-order scan (`scanPacks`) found of each commit and tree it unpacked: object
   * number -> start + 1 in `scanKids` (0 for an object not scanned). At the start
   * `(count << 2) | type`, then a tree's entries as `(object << 1) | isTree` (gitlinks left
   * out), or a commit's tree and parents. Only objects whose every link names an object the
   * table holds, so the walk replays the lookups git makes on them in its own order.
   */
  private scanAt = new Int32Array(0);
  /**
   * Commits as `git commit-graph verify` compares them with the graph, by id, kept from the
   * reads in pack order (the object pass of a full run, the scan of a connectivity-only one)
   * when the repository has a commit-graph: the verification then reads only the others.
   */
  private graphCommits?: Map<string, GraphCommitData | null>;
  /** Commits `graphCommits` holds (its `null`s left out). */
  private graphCommitsKept = 0;
  private scanKids = new Int32Array(0);
  private scanKidsLength = 0;
  private readonly files?: FilesApi;
  private readonly gitDir: string;

  constructor(
    private readonly stores: RunStores,
    private readonly objects: GitObjects,
    private readonly types: FsckMessageTypes,
    private readonly o: RunOptions,
  ) {
    if (o.nameObjects) this.names = new Map();
    this.showUnreachable = o.unreachable;
    this.recordTrees = !o.connectivityOnly && !o.nameObjects;
    this.files = o.repository?.files;
    this.gitDir = (o.repository?.gitDir ?? ".git").replace(/\/+$/, "");
  }

  async run(): Promise<FsckResult> {
    // git loads the midx when it first reads a packed object and dies on one it refuses
    // fatally (a wrong signature or version, a required chunk missing; 2.5x: a fan-out out of
    // order too)
    if (this.files && this.o.multiPackIndex !== false) {
      const loaded = await loadMultiPackIndex(this.files, pathOf(this.looseDir(), "pack"), {
        compatibility: this.o.compatibility,
      });
      if (loaded.fatal) return this.death(loaded.errors);
      const bad = loaded.midx && badPackIntIdAt(loaded.midx);
      if (bad && loaded.midx)
        this.midxBadEntry = { id: loaded.midx.idAt(bad.pos), line: `fatal: ${bad.message}` };
    }
    this.graftFileExists = (await this.graftFileText()) !== undefined;
    this.graftsFile = this.graftFileExists && this.o.graftsAdvice;
    this.graftsHint = this.graftsFile;
    if (this.files && this.o.commitGraph.enabled && (await this.hasCommitGraphFile())) {
      this.graphCommits = new Map();
    }
    const refs = this.stores.refs;
    this.shallow = new Set((await refs.getShallow?.()) ?? []);
    await this.readGrafts();
    if (this.files) this.packs = await this.listPacks();
    // git 2.45+: the refs are snapshotted before the objects are read
    const snapshot = this.o.compatibility === "2.56" ? await this.snapshotRefs() : undefined;
    // 2.5x parses each ref's object at the snapshot, through the midx: a tip whose pack-int-id
    // is out of range dies there
    const badMidx = this.midxBadEntry;
    if (snapshot && badMidx && snapshot.some((r) => r.id === badMidx.id))
      return this.death([badMidx.line]);

    /** connectivity-only: each pack's objects by idx position, and the loose ones */
    let packed: Int32Array[] | undefined;
    let loose: number[] | undefined;
    if (this.o.connectivityOnly) {
      const t = this.t;
      const scan = this.files !== undefined && !this.names && this.packs.length > 0;
      if (scan) {
        packed = this.packs.map((p) => new Int32Array(p.idx.objectCount));
        loose = [];
      }
      await this.forEachStored((raw, at, pack, pos) => {
        // git's lookup_unknown_object
        let n = t.lookupRaw(raw, at);
        if (n < 0) n = t.createRaw(raw, at, OBJ_NONE);
        t.addFlags(n, HAS_OBJ);
        if (packed) {
          if (pack < 0) loose?.push(n);
          else (packed[pack] as Int32Array)[pos] = n;
        }
      });
    } else {
      if (this.files) {
        for (const step of this.sourceSteps()) {
          if ("loose" in step) await this.fsckLooseObjects(step.loose);
          else {
            const packs = step.packs.map((k) => this.packs[k] as RepoPack);
            await this.fsckPacks(packs);
            // 2.5x's verify_bitmap_files, after the source's packs (2.43: at the end)
            if (
              this.o.compatibility === "2.56" &&
              (await this.verifyBitmapFiles(packs, step.dir ?? this.looseDir()))
            )
              this.errorsFound |= FSCK_ERROR_OBJECT;
            // then 2.5x's verify_midx: `git multi-pack-index verify --object-dir <source>`
            if (this.o.compatibility === "2.56" && (await this.verifyMultiPackIndex(step.dir)))
              this.errorsFound |= FSCK_ERROR_OBJECT;
          }
        }
      } else {
        await this.fsckStoredObjects();
      }
      if (await this.fsckFinish()) this.errorsFound |= FSCK_ERROR_OBJECT;
    }

    // is_promisor_object's set, built when the walk from the refs first asks
    this.promised = this.o.promised;
    if (this.o.loadPromised) {
      try {
        const loaded = await this.o.loadPromised();
        this.promised = loaded.size > 0 ? loaded : undefined;
      } catch (error) {
        if (!(error instanceof PromisorObjectReadError)) throw error;
        if (this.o.compatibility === "2.56") {
          for (const pack of this.opened.values()) pack?.close();
          return this.promisorDeath(error);
        }
        // 2.43 asks only for an object that is missing: it dies there, at the first question
        const loaded = await this.o.loadPromised(true);
        const findings = this.findings;
        const run = this;
        this.promised = {
          has(id: string) {
            run.promisorDeathAt ??= { at: findings.length, error };
            return loaded.has(id);
          },
        } as ReadonlySet<string>;
      }
    }
    const walkAt = this.findings.length;
    if (snapshot) await this.processSnapshot(snapshot);
    else await this.processRefs();
    const indexDeath = await this.processIndexes();
    if (indexDeath) {
      for (const pack of this.opened.values()) pack?.close();
      return this.death(indexDeath);
    }
    if (this.o.connectivityOnly) this.graph = await this.loadCommitGraph();
    if (packed) await this.scanPacks(packed, loose ?? []);
    try {
      await this.checkConnectivity();
      // the walk reads through the midx what it parses again (every object but blobs when
      // connectivity only, else the trees, whose buffers git frees once checked): an object of
      // a pack-int-id out of range dies there, after the lines printed before the walk
      if (badMidx) {
        const n = this.t.lookup(badMidx.id);
        if (
          n >= 0 &&
          this.t.flags(n) & REACHABLE &&
          (this.o.connectivityOnly ? this.t.type(n) !== OBJ_BLOB : this.t.type(n) === OBJ_TREE)
        ) {
          this.findings.length = walkAt;
          return this.death([badMidx.line]);
        }
      }
      await this.verifyCommitGraph();
      // 2.43 checks every pack's bitmap last, --connectivity-only too (ERROR_BITMAP, 0200)
      if (
        this.files &&
        this.o.compatibility === "2.43" &&
        (await this.verifyBitmapFiles(this.packs))
      )
        this.errorsFound |= FSCK_ERROR_BITMAP_243;
      // 2.43 runs `git multi-pack-index verify` for every source last (ERROR_MULTI_PACK_INDEX)
      if (this.files && this.o.compatibility === "2.43") {
        for (const dir of this.sourceDirs())
          if (await this.verifyMultiPackIndex(dir))
            this.errorsFound |= FSCK_ERROR_MULTI_PACK_INDEX_243;
      }
    } finally {
      for (const pack of this.opened.values()) pack?.close();
    }

    if (this.promisorDeathAt) {
      this.findings.length = this.promisorDeathAt.at;
      return this.promisorDeath(this.promisorDeathAt.error);
    }
    const out = this.findings.filter((f) => f.stream === "stdout").map((f) => `${f.text}\n`);
    const err = this.findings.filter((f) => f.stream === "stderr").map((f) => `${f.text}\n`);
    return {
      exitCode: this.errorsFound,
      findings: this.findings,
      output: out.join(""),
      errorOutput: err.join(""),
      statistics: {
        objectsRead: this.objectsRead,
        commitsFromGraph: this.graphParsed,
        objectsScanned: this.objectsScanned,
        linksKept: this.kidsLength + this.scanKidsLength,
        graphCommitsKept: this.graphCommitsKept,
      },
    };
  }

  /**
   * One `git multi-pack-index verify --object-dir <objectsDir>` child of fsck: its stderr
   * follows; true when it failed. Nothing without `core.multiPackIndex` or a FilesApi.
   */
  private async verifyMultiPackIndex(objectsDir: string | undefined): Promise<boolean> {
    if (!this.files || objectsDir === undefined || this.o.multiPackIndex === false) return false;
    const result = await multiPackIndexVerify({
      files: this.files,
      objectsDir,
      compatibility: this.o.compatibility,
    });
    for (const text of result.stderr)
      this.emit({ kind: "multi-pack-index", stream: "stderr", text });
    return result.exitCode !== 0;
  }

  /** A death with git's lines on stderr: exit 128. */
  private death(lines: readonly string[]): FsckResult {
    for (const text of lines) this.emit({ kind: "error", stream: "stderr", text });
    const err = this.findings.filter((f) => f.stream === "stderr").map((f) => `${f.text}\n`);
    const out = this.findings.filter((f) => f.stream === "stdout").map((f) => `${f.text}\n`);
    return {
      exitCode: 128,
      findings: this.findings,
      output: out.join(""),
      errorOutput: err.join(""),
      statistics: {
        objectsRead: this.objectsRead,
        commitsFromGraph: this.graphParsed,
        objectsScanned: this.objectsScanned,
        linksKept: this.kidsLength + this.scanKidsLength,
        graphCommitsKept: this.graphCommitsKept,
      },
    };
  }

  /** add_promisor_object's death on a promisor pack's unreadable object: exit 128. */
  private promisorDeath(error: PromisorObjectReadError): FsckResult {
    const pack = this.packs.find((p) => p.idx.has(error.objectId));
    const where = pack ? pack.packPath : `pack-${error.packId}.pack`;
    this.emit({
      kind: "error",
      stream: "stderr",
      text: `fatal: packed object ${error.objectId} (stored in ${where}) is corrupt`,
    });
    const out = this.findings.filter((f) => f.stream === "stdout").map((f) => `${f.text}\n`);
    const err = this.findings.filter((f) => f.stream === "stderr").map((f) => `${f.text}\n`);
    return {
      exitCode: 128,
      findings: this.findings,
      output: out.join(""),
      errorOutput: err.join(""),
      statistics: {
        objectsRead: this.objectsRead,
        commitsFromGraph: this.graphParsed,
        objectsScanned: this.objectsScanned,
        linksKept: this.kidsLength + this.scanKidsLength,
        graphCommitsKept: this.graphCommitsKept,
      },
    };
  }

  /**
   * git's fsck runs `git commit-graph verify --object-dir <objects>` for every object
   * directory (the repository's, then each alternate's) when `core.commitGraph` is on: their
   * stderr follows, and a failure sets ERROR_COMMIT_GRAPH.
   */
  private async verifyCommitGraph(): Promise<void> {
    const settings = this.o.commitGraph;
    if (!this.files || !settings.enabled) return;
    // fsck itself loads the graph when it parses the commit of a ref (parse_object looks it
    // up there first; fsck disables replace refs): what loading prints comes once from fsck,
    // for each directory read until one has a graph (prepare_commit_graph)
    if (
      (await this.hasRefs()) &&
      (await commitGraphCompatible({
        files: this.files,
        gitDir: this.gitDir,
        useReplaceRefs: false,
        readGraftFile: () => this.graftFileText(),
      }))
    ) {
      for (const dir of this.sourceDirs()) {
        const read = await readCommitGraph(this.files, dir, settings, this.sourceDirs());
        for (const d of read.diagnostics) {
          this.emit({ kind: "commit-graph", stream: "stderr", text: `${d.level}: ${d.message}` });
        }
        if (read.graph) break;
      }
    }
    for (const dir of this.sourceDirs()) await this.verifySourceCommitGraph(dir);
  }

  /** One `git commit-graph verify --object-dir <objectsDir>` child of fsck. */
  private async verifySourceCommitGraph(objectsDir: string): Promise<void> {
    const settings = this.o.commitGraph;
    if (!this.files) return;
    // git's `git commit-graph verify` reads each commit (in the graph's order) from the first
    // pack of its most-recently-used list that has it: a commit in several packs is read from
    // the one the commit before it came from, when that one has it too
    const packs = this.packs;
    const mru = [...packs];
    const packOf = (id: string): RepoPack | undefined => {
      for (let i = 0; i < mru.length; i++) {
        const p = mru[i] as RepoPack;
        if (!p.idx.has(id)) continue;
        if (i > 0) {
          mru.splice(i, 1);
          mru.unshift(p);
        }
        return p;
      }
      return undefined;
    };
    // The verification is a process of its own, which reads the grafts file again (and gives
    // its hint again) when it parses its first commit: parse_commit_buffer looks the commit's
    // grafts up once the tree line is read, so not for a commit that is missing, of another
    // type, or without a sound tree line.
    // Once read, a grafted commit reads with its grafted parents, and the commits it grafts
    // lose the parents they were given from the graph (register_commit_graft unparses them):
    // their graph parent lists read as empty.
    let childGrafts = this.graftFileExists;
    let graftsRead = false;
    const reachGrafts = (note: (line: string) => void, data?: Uint8Array) => {
      if (!childGrafts || (data && !treeLineSound(data))) return;
      childGrafts = false;
      graftsRead = true;
      if (this.graftsFile) for (const line of this.graftsHintLines()) note(line);
      for (const line of this.graftErrorLines) note(line);
    };
    const grafted = (data: GraphCommitData | undefined, id: string) => {
      const parents = graftsRead && data ? this.graftedParents(id) : undefined;
      return parents && data ? { ...data, parents } : data;
    };
    const result = await verifyCommitGraph(
      this.files,
      objectsDir,
      (id, note) => {
        const read = this.readVerifiedCommit(id, note, packs, packOf, reachGrafts);
        return read instanceof Promise ? read.then((d) => grafted(d, id)) : grafted(read, id);
      },
      {
        settings,
        // the child's layers come from every object directory of the repository
        objectDirs: this.sourceDirs(),
        ...(this.grafts
          ? {
              ungraphedParents: (id: string) => graftsRead && this.graftedParents(id) !== undefined,
            }
          : {}),
      },
    );
    for (const text of result.messages) this.emit({ kind: "commit-graph", stream: "stderr", text });
    if (result.exitCode !== 0) this.errorsFound |= FSCK_ERROR_COMMIT_GRAPH;
  }

  /** Commit `id` as `git commit-graph verify` reads it from the object database. */
  private readVerifiedCommit(
    id: string,
    note: (line: string) => void,
    packs: RepoPack[],
    packOf: (id: string) => RepoPack | undefined,
    reachGrafts: (note: (line: string) => void, data?: Uint8Array) => void,
  ): GraphCommitData | undefined | Promise<GraphCommitData | undefined> {
    const objects = this.objects;
    const from = packs.length > 1 ? packOf(id) : undefined;
    if (from && from !== packs.find((p) => p.idx.has(id))) {
      // not the copy kept (the newest pack's): that pack's own
      return this.readPackedCommit(from, id, (data) => reachGrafts(note, data));
    }
    const kept = this.graphCommits?.get(id);
    if (kept) {
      reachGrafts(note);
      return kept;
    }
    const parse = (o: GitObject | undefined, data: Uint8Array) => {
      if (o?.type !== "commit") return undefined;
      reachGrafts(note, data);
      return parseGraphCommit(data, id);
    };
    const slow = async (o: GitObject | undefined | Promise<GitObject | undefined>) => {
      try {
        const obj = await o;
        if (!obj) return undefined;
        return parse(obj, obj.bytes ?? (await collect(obj)));
      } catch {
        return undefined;
      }
    };
    try {
      // without a promise when the store has the commit in memory
      const o = objects.getNow ? objects.getNow(id) : objects.get(id);
      if (o instanceof Promise || (o && !o.bytes)) return slow(o);
      return o ? parse(o, o.bytes as Uint8Array) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Commit `id` as pack `p` holds it, unchecked, for the commit-graph verification; `parsing`
   * sees its data before it is parsed.
   */
  private async readPackedCommit(
    p: RepoPack,
    id: string,
    parsing: (data: Uint8Array) => void,
  ): Promise<GraphCommitData | undefined> {
    try {
      const pack = await this.openRepoPack(p);
      const obj = await pack?.get(id);
      if (obj?.type !== "commit") return undefined;
      const data = await collect(obj);
      parsing(data);
      return parseGraphCommit(data, id);
    } catch {
      return undefined;
    }
  }

  /** Whether the objects directory has a commit-graph file or chain. */
  private async hasCommitGraphFile(): Promise<boolean> {
    const files = this.files as FilesApi;
    const info = pathOf(this.gitDir, "objects", "info");
    try {
      if ((await files.stats(pathOf(info, "commit-graph")))?.kind === "file") return true;
      return (await files.stats(pathOf(info, "commit-graphs")))?.kind === "directory";
    } catch {
      return false;
    }
  }

  /**
   * A commit read in pack order, kept for the commit-graph verification (`graphCommits`), when
   * this is the copy the verification reads (git's repo_read_object_file: the first pack in
   * pack order that has it, unchecked): the callers pass each pack's copies in that order and
   * `skipGraphCommit` for a copy they could not unpack. At most `graphCommitsKept` of them.
   */
  private keepGraphCommit(id: string, content: Uint8Array): void {
    const map = this.graphCommits;
    if (!map || this.graphCommitsKept >= this.o.graphCommitsKept || map.has(id)) return;
    try {
      map.set(id, parseGraphCommit(content, id));
      this.graphCommitsKept++;
    } catch {
      // read again (and failed again) by the verification
      map.set(id, null);
    }
  }

  /** A copy `keepGraphCommit` cannot take: the verification reads the object from the store. */
  private skipGraphCommit(id: string): void {
    const map = this.graphCommits;
    if (map && !map.has(id)) map.set(id, null);
  }

  /**
   * The graph git's repo_parse_commit reads commits from: `core.commitGraph` on, a repository
   * the graph is valid for (no grafts, not shallow; fsck disables replace refs), a graph that
   * loads. Undefined otherwise: commits are read from the object store.
   */
  private async loadCommitGraph(): Promise<CommitGraph | undefined> {
    const settings = this.o.commitGraph;
    if (!this.files || !settings.enabled) return undefined;
    try {
      if (
        !(await commitGraphCompatible({
          files: this.files,
          gitDir: this.gitDir,
          useReplaceRefs: false,
          readGraftFile: () => this.graftFileText(),
        }))
      ) {
        return undefined;
      }
      // the first graph among the object directories (prepare_commit_graph)
      for (const dir of this.sourceDirs()) {
        const graph = (await readCommitGraph(this.files, dir, settings, this.sourceDirs())).graph;
        if (graph) return graph;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * git's parse_commit_in_graph for object `n`, a commit not parsed yet: its parents (looked up
   * first, as fill_commit_in_graph inserts them) and its tree from the graph. False when the
   * graph does not have it (or names something of another type): the commit is read then.
   */
  private parseCommitInGraph(n: number, id: string): boolean {
    const g = this.graph as CommitGraph;
    const t = this.t;
    const pos = g.positionOfBytes(t.idBytes(n));
    if (pos < 0) return false;
    const parents: number[] = [];
    if (!this.shallow.has(id)) {
      for (const pp of g.parentPositionsAt(pos)) {
        const [layer, local] = g.locate(pp);
        const parent = t.lookupTypedRaw(
          layer.bytes,
          layer.oidLookup.offset + 20 * local,
          OBJ_COMMIT,
        );
        if (typeof parent !== "number") return false;
        parents.push(parent);
      }
    }
    const [layer, local] = g.locate(pos);
    const tree = t.lookupTypedRaw(layer.bytes, layer.dataOffset(local), OBJ_TREE);
    if (typeof tree !== "number") return false;
    t.links.set(n, { tree, parents });
    t.addFlags(n, PARSED);
    this.graphParsed++;
    return true;
  }

  /**
   * git's prepare_commit_graft for fsck: the grafts file read (`info/grafts`, or the file
   * `GIT_GRAFT_FILE` names; fsck applies grafts, as every parse_commit does; replace refs it
   * turns off), its bad lines kept to be reported.
   */
  private async readGrafts(): Promise<void> {
    const text = await this.graftFileText();
    if (text === undefined) return;
    const { grafts, messages } = parseGraftFile(text);
    if (grafts.size > 0) this.grafts = grafts;
    this.graftErrors = messages;
    this.graftErrorLines = messages;
  }

  /**
   * The grafts file's text (git's repo_get_graft_file: `GIT_GRAFT_FILE`, else
   * `<GIT_DIR>/info/grafts`), read once; undefined when there is none or it cannot be read
   * (git warns and goes on).
   */
  private graftFileText(): Promise<string | undefined> {
    if (!this.graftText) {
      const read = this.o.readGraftFile;
      const files = this.files;
      const path = pathOf(this.gitDir, "info", "grafts");
      this.graftText = (async () => {
        if (read) return read();
        if (!files || (await files.stats(path))?.kind !== "file") return undefined;
        return new TextDecoder().decode(await readFile(files, path));
      })().catch(() => undefined);
    }
    return this.graftText;
  }

  /** The grafts file's text once read (see graftFileText). */
  private graftText?: Promise<string | undefined>;

  /** The grafted parents of commit `id`; undefined when not grafted (or shallow). */
  private graftedParents(id: string): string[] | undefined {
    if (!this.grafts || this.shallow.has(id)) return undefined;
    return this.grafts.get(id);
  }

  /** The grafts file's errors (`error: bad graft data: <line>`), once. */
  private reportGraftErrors(): void {
    const errors = this.graftErrors;
    this.graftErrors = [];
    for (const text of errors) this.emit({ kind: "error", stream: "stderr", text });
  }

  /** Whether HEAD or any ref names an object. */
  private async hasRefs(): Promise<boolean> {
    const refs = this.stores.refs;
    for await (const ref of refs.list("refs/")) if (!isSymbolicRef(ref)) return true;
    return (await refs.resolve("HEAD").catch(() => undefined))?.objectId !== undefined;
  }

  // ------------------------------------------------------------------------------------------
  // Output

  private emit(finding: FsckFinding): void {
    this.findings.push(finding);
  }

  /** Whether the grafts file's deprecation hint is still to be printed (`adviseGrafts`). */
  private graftsHint = false;
  /** Whether `<GIT_DIR>/info/grafts` is a file and `advice.graftFileDeprecated` is on. */
  private graftsFile = false;

  /**
   * git's read_graft_file, when the first commit is parsed (prepare_commit_graft): the hint
   * that `<GIT_DIR>/info/grafts` is deprecated, once, as each version words it.
   */
  private adviseGrafts(): void {
    if (!this.graftsHint) return;
    this.graftsHint = false;
    for (const text of this.graftsHintLines())
      this.emit({ kind: "notice", stream: "stderr", text });
  }

  /** The grafts file's deprecation hint, as each version words it. */
  private graftsHintLines(): string[] {
    const v243 = this.o.compatibility === "2.43";
    const blank = v243 ? "hint: " : "hint:";
    const lines = [
      "hint: Support for <GIT_DIR>/info/grafts is deprecated",
      "hint: and will be removed in a future Git version.",
      blank,
      'hint: Please use "git replace --convert-graft-file"',
      "hint: to convert the grafts into replace refs.",
      blank,
      "hint: Turn this message off by running",
      v243
        ? 'hint: "git config advice.graftFileDeprecated false"'
        : 'hint: "git config set advice.graftFileDeprecated false"',
    ];
    return lines;
  }

  /** git's `error()`: `error: <message>` on stderr. */
  private error(message: string, objectId?: string): void {
    this.emit({ kind: "error", stream: "stderr", text: `error: ${message}`, objectId });
  }

  private describe(id: string): string {
    const name = this.names?.get(id);
    return name === undefined ? id : `${id} (${name})`;
  }

  private putName(id: string, name: string): void {
    if (this.names && !this.names.has(id)) this.names.set(id, name);
  }

  /** git's `printable_type`: the object's type, read from the store when not known yet. */
  private async printableType(n: number): Promise<string> {
    const type = this.t.type(n);
    if (type !== OBJ_NONE) return TYPE_NAME[type];
    const stored = await this.storeType(this.t.id(n));
    return stored ?? "unknown";
  }

  /** git's `objerror`. */
  private async objerror(n: number, message: string): Promise<void> {
    this.errorsFound |= FSCK_ERROR_OBJECT;
    const id = this.t.id(n);
    const type = await this.printableType(n);
    this.emit({
      kind: "error",
      stream: "stderr",
      text: `error in ${type} ${this.describe(id)}: ${message}`,
      objectId: id,
      objectType: type,
    });
  }

  /** The report function of git's object checks for one object. */
  private reporter(id: string, type: string) {
    return (msgId: FsckMsgId, message: string): number => {
      const severity = this.types.severity(msgId);
      if (severity === "ignore") return 0;
      const label = severity === "error" ? "error" : "warning";
      this.emit({
        kind: "object",
        stream: "stderr",
        text: `${label} in ${type} ${this.describe(id)}: ${msgId}: ${message}`,
        objectId: id,
        objectType: type,
        msgId,
        severity,
      });
      return severity === "error" ? 1 : 0;
    };
  }

  // ------------------------------------------------------------------------------------------
  // The object store

  /** The zlib error of the last failed read, as git's `git_inflate` prints it. */
  private lastZlibError?: string;

  private async readObject(id: string): Promise<GitObject | undefined> {
    this.lastZlibError = undefined;
    try {
      return await this.objects.get(id);
    } catch (e) {
      this.noteReadError(e);
      return undefined;
    }
  }

  private noteReadError(e: unknown): void {
    const inflate = /inflate failed: (.*)$/.exec(e instanceof Error ? e.message : "")?.[1];
    if (inflate) this.lastZlibError = `inflate: data stream error (${inflate})`;
  }

  /**
   * The whole object from the store, without a promise when the store holds it in memory (a
   * packed object in a loaded window or the base cache: `getNow`).
   */
  private readWhole(id: string): Whole | undefined | Promise<Whole | undefined> {
    this.lastZlibError = undefined;
    this.objectsRead++;
    let obj: GitObject | undefined | Promise<GitObject | undefined>;
    try {
      obj = this.objects.getNow ? this.objects.getNow(id) : this.objects.get(id);
    } catch (e) {
      this.noteReadError(e);
      return undefined;
    }
    if (obj instanceof Promise) {
      return obj.then(
        (o) => this.wholeOf(o),
        (e) => {
          this.noteReadError(e);
          return undefined;
        },
      );
    }
    return this.wholeOf(obj);
  }

  private wholeOf(obj: GitObject | undefined): Whole | undefined | Promise<Whole | undefined> {
    if (!obj) return undefined;
    // in memory already (the buffer is ours, and `content` needs no release)
    if (obj.bytes) return { type: obj.type, content: obj.bytes };
    return collect(obj).then(
      (content) => ({ type: obj.type, content }),
      (e) => {
        this.noteReadError(e);
        return undefined;
      },
    );
  }

  private async storeType(id: string): Promise<string | undefined> {
    if (this.o.connectivityOnly) {
      const type = await this.packedType(id);
      if (type) return type;
    }
    const obj = await this.readObject(id);
    if (!obj) return undefined;
    await obj.content[Symbol.asyncIterator]().return?.();
    return obj.type;
  }

  /** The repository's packs, opened to read entry headers (`packedType`). */
  private readonly opened = new Map<RepoPack, PackFile | undefined>();

  /** Pack `p`, opened once (undefined when it cannot be). */
  private async openRepoPack(p: RepoPack): Promise<PackFile | undefined> {
    if (!this.opened.has(p)) {
      const pack = await openPack(this.files as FilesApi, p.packPath, p.idxPath, {
        idxBytes: p.idxBytes,
      }).catch(() => undefined);
      this.opened.set(p, pack);
    }
    return this.opened.get(p);
  }

  /**
   * The type of a packed object from its entry header, following a delta's bases through
   * theirs, as git's `packed_object_info`: nothing is inflated (connectivity-only runs read no
   * blob). Undefined when the headers do not tell (the object is not packed, a base is
   * elsewhere, a header is corrupt): the store reads the object then.
   */
  private async packedType(id: string): Promise<string | undefined> {
    const p = this.packs.find((x) => x.idx.has(id));
    if (!p) return undefined;
    const pack = await this.openRepoPack(p);
    if (!pack || p.idx.version < 2) return undefined;
    try {
      let at = id;
      for (let depth = 0; depth <= 4096; depth++) {
        const e = await pack.entry(at);
        if (!e) return undefined;
        if (e.kind <= 4) return TYPE_NAME[e.kind as ObjType];
        if (!e.baseId || !pack.has(e.baseId)) return undefined;
        at = e.baseId;
      }
    } catch {
      // a corrupt entry: read through the store
    }
    return undefined;
  }

  /** git's `has_object`. */
  private async hasObject(id: string): Promise<boolean> {
    try {
      return await this.objects.has(id);
    } catch {
      return false;
    }
  }

  /** git's `has_object_pack`. */
  private inPack(id: string): boolean {
    return this.packs.some((p) => p.idx.has(id));
  }

  private looseDir(): string {
    return pathOf(this.gitDir, "objects");
  }

  /** The object directories: the repository's, then its alternates' (git's odb sources). */
  private sourceDirs(): string[] {
    return [this.looseDir(), ...(this.o.alternateDirs ?? [])];
  }

  /**
   * Every pack of every source, in the order git lists them: 2.56 source by source (each
   * source's packs newest first), 2.43 the repository's packs, then all of its alternates'
   * (get_all_packs' sort_pack: local first, then the most recently modified).
   */
  private async listPacks(): Promise<RepoPack[]> {
    const dirs = this.sourceDirs();
    const all: (RepoPack & { mtime: number })[] = [];
    for (let i = 0; i < dirs.length; i++)
      all.push(...(await this.listSourcePacks(dirs[i] as string, i)));
    if (this.o.compatibility === "2.43") {
      all.sort(
        (a, b) =>
          Number(a.source !== 0) - Number(b.source !== 0) ||
          b.mtime - a.mtime ||
          (a.packPath < b.packPath ? -1 : 1),
      );
    }
    return all;
  }

  private async listSourcePacks(
    objectsDir: string,
    source: number,
  ): Promise<(RepoPack & { mtime: number })[]> {
    const files = this.files as FilesApi;
    const dir = pathOf(objectsDir, "pack");
    if ((await files.stats(dir))?.kind !== "directory") return [];
    const found: (RepoPack & { mtime: number })[] = [];
    for await (const e of files.list(dir)) {
      if (e.kind !== "file" || !PACK_IDX.test(e.name)) continue;
      const idxPath = pathOf(dir, e.name);
      const packPath = `${idxPath.slice(0, -4)}.pack`;
      const stats = await files.stats(packPath);
      if (stats?.kind !== "file") continue;
      try {
        const idxBytes = await readAll(files, idxPath);
        const idx = readPackIndex(idxBytes);
        found.push({ packPath, idxPath, idx, idxBytes, source, mtime: stats.lastModified ?? 0 });
      } catch {
        // git does not list a pack whose idx cannot be opened
      }
    }
    // git's sort_pack: the most recently modified first
    found.sort((a, b) => b.mtime - a.mtime || (a.packPath < b.packPath ? -1 : 1));
    return found;
  }

  /**
   * The loose object files of each fan-out directory of `objectsDir` (default the
   * repository's), in directory order, and its other entries.
   */
  private async *looseEntries(
    objectsDir = this.looseDir(),
  ): AsyncIterable<{ id?: string; path: string; name: string }> {
    const files = this.files as FilesApi;
    for (let i = 0; i < 256; i++) {
      const sub = i.toString(16).padStart(2, "0");
      const dir = pathOf(objectsDir, sub);
      if ((await files.stats(dir))?.kind !== "directory") continue;
      const entries: { name: string; path: string }[] = [];
      for await (const e of files.list(dir)) entries.push({ name: e.name, path: e.path });
      // in the order the files list them, as git's readdir loop: it decides hash collisions
      for (const e of entries) {
        const path = pathOf(dir, e.name);
        yield LOOSE_NAME.test(e.name)
          ? { id: sub + e.name, path, name: e.name }
          : { path, name: e.name };
      }
    }
  }

  /**
   * The order git reads the sources in: 2.56 one source at a time (its loose objects, then its
   * packs: odb_fsck / odb_for_each_object), 2.43 the loose objects of every source, then every
   * pack. Each step names a source's loose objects (`loose`) or the packs to read (`packs`,
   * indexes into `this.packs`).
   */
  private sourceSteps(): ({ loose: string } | { packs: number[]; dir?: string })[] {
    const dirs = this.sourceDirs();
    const all = this.packs.map((_, k) => k);
    if (this.o.compatibility === "2.43") {
      return [...dirs.map((loose) => ({ loose })), { packs: all }];
    }
    return dirs.flatMap((loose, i) => [
      { loose },
      { packs: all.filter((k) => (this.packs[k] as RepoPack).source === i), dir: loose },
    ]);
  }

  /**
   * Every stored id, as its 20 bytes at `at` in `raw` (valid during the call): loose ones, then
   * each pack's in idx order (git's for_each_*_object). A pack's ids are read from its idx.
   */
  private async forEachStored(
    visit: (raw: Uint8Array, at: number, pack: number, pos: number) => void | Promise<void>,
  ): Promise<void> {
    const scratch = new Uint8Array(20);
    // ids listed here are 40 lowercase hex digits
    const nibble = (c: number) => (c <= 0x39 ? c - 0x30 : c - 0x57);
    const parsed = (id: string) => {
      for (let i = 0; i < 20; i++)
        scratch[i] = (nibble(id.charCodeAt(2 * i)) << 4) | nibble(id.charCodeAt(2 * i + 1));
      return scratch;
    };
    if (!this.files) {
      const ids: string[] = [];
      for await (const id of this.objects.list()) ids.push(id);
      ids.sort();
      for (const id of ids) {
        const r = visit(parsed(id), 0, -1, -1);
        if (r) await r;
      }
      return;
    }
    for (const step of this.sourceSteps()) {
      if ("loose" in step) {
        for await (const e of this.looseEntries(step.loose)) {
          if (!e.id) continue;
          const r = visit(parsed(e.id), 0, -1, -1);
          if (r) await r;
        }
        continue;
      }
      for (const k of step.packs) {
        const p = this.packs[k] as RepoPack;
        const v2 = p.idx.version > 1;
        const idsAt = v2 ? 8 + 1024 : 1024 + 4;
        const stride = v2 ? 20 : 24;
        for (let i = 0, n = p.idx.objectCount; i < n; i++) {
          const r = visit(p.idxBytes, idsAt + i * stride, k, i);
          if (r) await r;
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Reading and checking every object

  /**
   * git's `parse_object_buffer`: the object, or undefined (git's errors printed). `raw` holds
   * the id's 20 bytes at `rawAt`, when the caller has them (an idx).
   */
  private parseObjectBuffer(
    id: string,
    type: ObjType,
    content: Uint8Array,
    raw?: Uint8Array,
    rawAt = 0,
  ): number | undefined {
    const t = this.t;
    const self = raw ? t.lookupTypedRaw(raw, rawAt, type) : t.lookupTyped(id, type);
    if (typeof self !== "number") {
      this.error(self.error, id);
      return undefined;
    }
    const n = self;
    if (type === OBJ_BLOB || type === OBJ_TREE) {
      t.addFlags(n, PARSED);
      return n;
    }
    if (t.flags(n) & PARSED) return n;
    if (type === OBJ_COMMIT) {
      if (this.graftsHint) this.adviseGrafts();
      if (this.graftErrors.length > 0) this.reportGraftErrors();
      const parsed = parseCommitLinks(content, id);
      if ("error" in parsed) {
        this.error(parsed.error, id);
        return undefined;
      }
      const raw = this.idScratch;
      const tree = t.lookupTypedRaw(rawIdAt(content, parsed.tree, raw), 0, OBJ_TREE);
      if (typeof tree !== "number") {
        this.error(tree.error);
        this.error(`bad tree pointer ${hexIdAt(content, parsed.tree)} in commit ${id}`, id);
        return undefined;
      }
      const parents: number[] = [];
      const grafted = this.graftedParents(id);
      if (grafted) {
        for (const p of grafted) {
          const parent = t.lookupTyped(p, OBJ_COMMIT);
          if (typeof parent !== "number") {
            this.error(parent.error);
            this.error(`bad graft parent ${p} in commit ${id}`, id);
            return undefined;
          }
          parents.push(parent);
        }
      } else if (!this.shallow.has(id)) {
        for (const at of parsed.parents) {
          const parent = t.lookupTypedRaw(rawIdAt(content, at, raw), 0, OBJ_COMMIT);
          if (typeof parent !== "number") {
            this.error(parent.error);
            this.error(`bad parent ${hexIdAt(content, at)} in commit ${id}`, id);
            return undefined;
          }
          parents.push(parent);
        }
      }
      t.links.set(n, { tree, parents });
      t.addFlags(n, PARSED);
      return n;
    }
    // tag
    const parsed = parseTagBuffer(content, id);
    if ("error" in parsed) {
      if (parsed.error) this.error(parsed.error, id);
      return undefined;
    }
    const tagged = t.lookupTyped(parsed.object, typeOf(parsed.type));
    if (typeof tagged !== "number") {
      this.error(tagged.error);
      this.error(`bad tag pointer to ${parsed.object} in ${id}`, id);
      return undefined;
    }
    if (parsed.tag === undefined) return undefined;
    t.links.set(n, { tagged, tag: parsed.tag });
    t.addFlags(n, PARSED);
    return n;
  }

  /**
   * git's `parse_object`: an object already parsed, or read from the store with its hash
   * checked (`hash mismatch <id>`, and undefined, when its bytes hash to another id: the copy
   * the store reads first, packed before loose, as git's) and parsed. The roots (refs, the
   * cache-tree, resolve-undo) and the objects the walk meets untyped (reflog entries in
   * connectivity-only runs) are parsed this way, trees again each time; the walk reads typed objects unchecked
   * (`parseAs`, git's repo_parse_commit, parse_tree and parse_tag).
   */
  private parseObject(id: string): number | undefined | Promise<number | undefined> {
    const known = this.t.lookup(id);
    // a tree is read again: git frees each tree's buffer once checked or walked (parsed = 0)
    if (known >= 0 && this.t.flags(known) & PARSED && this.t.type(known) !== OBJ_TREE) {
      return known;
    }
    const obj = this.readWhole(id);
    if (obj instanceof Promise) return obj.then((o) => this.parseVerified(id, o));
    return this.parseVerified(id, obj);
  }

  /**
   * `parseRead` once the bytes hash to `id` (git's check_object_signature). Hashed here, not by
   * the store: a verified read would mark the copy bad there, and git reads it again as it is.
   */
  private parseVerified(id: string, obj: Whole | undefined): number | undefined {
    if (obj && objectIdOf(obj.type, obj.content) !== id) {
      this.error(`hash mismatch ${id}`, id);
      return undefined;
    }
    return this.parseRead(id, obj);
  }

  /**
   * git's repo_parse_commit and parse_tag of object `n`, a commit or a tag not parsed yet: read
   * without a hash check, `Could not read <id>` when that fails and `Object <id> not a <type>`
   * when the store holds another type.
   */
  private parseAs(n: number, id: string): void | Promise<void> {
    const obj = this.readWhole(id);
    if (obj instanceof Promise) return obj.then((o) => this.parseAsRead(n, id, o));
    this.parseAsRead(n, id, obj);
  }

  private parseAsRead(n: number, id: string, obj: Whole | undefined): void {
    const want = this.t.type(n);
    if (!obj) {
      if (this.lastZlibError) this.error(this.lastZlibError);
      this.error(`Could not read ${id}`);
      return;
    }
    if (typeOf(obj.type) !== want) {
      this.error(`Object ${id} not a ${TYPE_NAME[want]}`);
      return;
    }
    this.lastRead = { id, obj };
    this.parseObjectBuffer(id, want, obj.content);
  }

  private parseRead(id: string, obj: Whole | undefined): number | undefined {
    if (!obj) {
      if (this.lastZlibError) this.error(this.lastZlibError);
      return undefined;
    }
    this.lastRead = { id, obj };
    return this.parseObjectBuffer(id, typeOf(obj.type), obj.content);
  }

  /**
   * git's `fsck_obj_buffer` / the end of `fsck_loose`: parses the object, marks it stored and
   * checks it. Returns nonzero when the object is bad.
   */
  private fsckObjBuffer(
    id: string,
    type: ObjType,
    content: Uint8Array | undefined,
    unparsable: string,
    size = content?.length ?? 0,
    raw?: Uint8Array,
    rawAt = 0,
  ): number | Promise<number> {
    // no content: a blob streamed past core.bigFileThreshold (git's NULL buffer)
    const n = this.parseObjectBuffer(id, type, content ?? EMPTY, raw, rawAt);
    if (n === undefined) {
      this.errorsFound |= FSCK_ERROR_OBJECT;
      this.error(unparsable, id);
      return -1;
    }
    this.t.clearFlags(n, REACHABLE | SEEN);
    this.t.addFlags(n, HAS_OBJ);
    return this.fsckObj(n, id, content, size);
  }

  /** git's `fsck_obj`: without a promise unless it reports through the store. */
  private fsckObj(
    n: number,
    id: string,
    content: Uint8Array | undefined,
    size: number,
  ): number | Promise<number> {
    const t = this.t;
    if (t.flags(n) & SEEN) return 0;
    t.addFlags(n, SEEN);
    if (this.walkUsed(n, content ?? EMPTY, this.recordTrees)) {
      return this.objerror(n, "broken links").then(() => this.fsckObjChecks(n, id, content, size));
    }
    return this.fsckObjChecks(n, id, content, size);
  }

  /** The rest of `fsck_obj`: the object checks, `--root` and `--tags`. */
  private fsckObjChecks(
    n: number,
    id: string,
    content: Uint8Array | undefined,
    size: number,
  ): number | Promise<number> {
    const t = this.t;
    const type = t.type(n);
    const err = this.fsckBuffer(id, type, content, size);
    if (err) return err;
    if (type === OBJ_COMMIT && this.o.root && t.links.get(n)?.parents?.length === 0) {
      this.emit({
        kind: "root",
        stream: "stdout",
        text: `root ${this.describe(id)}`,
        objectId: id,
      });
    }
    if (type === OBJ_TAG && this.o.tags) {
      const links = t.links.get(n);
      if (links?.tagged !== undefined) {
        const target = links.tagged;
        return this.printableType(target).then((printable) => {
          this.emit({
            kind: "tagged",
            stream: "stdout",
            text: `tagged ${printable} ${this.describe(t.id(target))} (${links.tag}) in ${this.describe(id)}`,
            objectId: id,
          });
          return 0;
        });
      }
    }
    return 0;
  }

  /** Records that tree `n`'s entries start at `start` in `kids` (`treeStart` holds start + 1). */
  private setTreeStart(n: number, start: number): void {
    if (n >= this.treeStart.length) {
      const grown = new Int32Array(Math.max(1024, this.t.size * 2, n + 1));
      grown.set(this.treeStart);
      this.treeStart = grown;
    }
    this.treeStart[n] = start + 1;
  }

  /**
   * Room in `kids` for `more` values past `kidsLength`, within what `linksKept` leaves after
   * `scanKids` (the limit is the two together); false past it. The array grows by doubling up
   * to that limit, never past it.
   */
  private reserveKids(more: number): boolean {
    const need = this.kidsLength + more;
    const limit = this.o.linksKept - this.scanKidsLength;
    if (need > limit) return false;
    if (need <= this.kids.length) return true;
    let size = Math.max(this.kids.length * 2, 1 << 12);
    while (size < need) size *= 2;
    const kids = new Int32Array(Math.min(size, limit));
    kids.set(this.kids.subarray(0, this.kidsLength));
    this.kids = kids;
    return true;
  }

  /**
   * git's `fsck_walk` with `mark_used`: marks what the object points to as used. With `record`,
   * a tree whose entries all resolve is remembered as its entries' objects (`treeEntries`).
   */
  private walkUsed(n: number, content: Uint8Array, record = false): number {
    const t = this.t;
    const type = t.type(n);
    if (type === OBJ_TREE) {
      const walk = scanTree(content, this.usedTable);
      this.lastTree = { content, table: walk };
      if (walk.initError) {
        this.error(walk.initError);
        return -1;
      }
      let res = 0;
      const start = this.kidsLength;
      // past the limit the walk reads the tree again
      if (record && !this.reserveKids(1 + walk.count)) record = false;
      let at = start + 1;
      const f = walk.fields;
      for (let i = 0; i < walk.count; i++) {
        const mode = canonMode(f[3 * i] as number);
        if (mode === 0o160000) continue;
        const isTree = mode === 0o040000;
        const child = t.lookupTypedRaw(
          content,
          f[3 * i + 2] as number,
          isTree ? OBJ_TREE : OBJ_BLOB,
        );
        if (typeof child !== "number") {
          this.error(child.error);
          res ||= 1;
          continue;
        }
        t.addFlags(child, USED);
        if (record) this.kids[at++] = (child << 1) | (isTree ? 1 : 0);
      }
      if (walk.error) this.error(walk.error);
      if (record && res === 0 && !walk.error) {
        this.kids[start] = at - start - 1;
        this.kidsLength = at;
        this.setTreeStart(n, start);
      }
      return res;
    }
    const links = t.links.get(n);
    if (type === OBJ_COMMIT && links) {
      if (links.tree !== undefined) t.addFlags(links.tree, USED);
      for (const p of links.parents ?? []) t.addFlags(p, USED);
    } else if (type === OBJ_TAG && links?.tagged !== undefined) {
      t.addFlags(links.tagged, USED);
    }
    return 0;
  }

  /** git's `fsck_buffer`: the object checks of `fsck.c`. */
  private fsckBuffer(
    id: string,
    type: ObjType,
    buffer: Uint8Array | undefined,
    size: number,
  ): number {
    const report = this.reporter(id, TYPE_NAME[type]);
    if (type === OBJ_BLOB) return this.fsckBlobOf(id, buffer, size, report);
    const content = buffer ?? EMPTY;
    switch (type) {
      case OBJ_TREE: {
        const found = { gitmodules: [] as string[], gitattributes: [] as string[] };
        // the walk just before decoded this tree already
        const last = this.lastTree;
        this.lastTree = undefined;
        const r = fsckTree(
          content,
          this.types,
          report,
          (m) => this.error(m),
          found,
          last?.content === content ? last.table : undefined,
        );
        for (const g of found.gitmodules) this.gitmodulesFound.add(g);
        for (const g of found.gitattributes) this.gitattributesFound.add(g);
        return r;
      }
      case OBJ_COMMIT:
        return fsckCommit(content, report);
      case OBJ_TAG:
        return fsckTag(content, report, { gpgsig: this.o.compatibility !== "2.43" });
      default:
        return report("unknownType", `unknown type '${type}' (internal fsck error)`);
    }
  }

  private fsckBlobOf(
    id: string,
    content: Uint8Array | undefined,
    size: number,
    report: ReturnType<FsckRun["reporter"]>,
  ): number {
    const gitmodules = this.gitmodulesFound.has(id);
    const gitattributes = this.gitattributesFound.has(id);
    if (!gitmodules && !gitattributes) return 0;
    if (gitmodules) this.gitmodulesDone.add(id);
    if (gitattributes) this.gitattributesDone.add(id);
    if (gitmodules && content && content.length < size) {
      // a loose blob whose stream ended early: git parses its zeros too (`.gitattributes` is
      // read up to the first NUL, the same with them or without)
      const padded = new Uint8Array(size);
      padded.set(content);
      content = padded;
    }
    return fsckBlob(content, size, { gitmodules, gitattributes }, report);
  }

  /** git's `fsck_finish`: `.gitmodules` and `.gitattributes` blobs not checked yet. */
  private async fsckFinish(): Promise<number> {
    let ret = 0;
    const pass = async (
      found: Set<string>,
      done: Set<string>,
      missing: FsckMsgId,
      nonBlob: FsckMsgId,
      name: string,
    ) => {
      for (const id of found) {
        if (done.has(id)) continue;
        const obj = await this.readWhole(id);
        if (!obj) {
          ret |= this.reporter(id, "blob")(missing, `unable to read ${name} blob`);
          continue;
        }
        if (obj.type === "blob") {
          ret |= this.fsckBlobOf(id, obj.content, obj.content.length, this.reporter(id, "blob"));
        } else {
          ret |= this.reporter(id, obj.type)(nonBlob, `non-blob found at ${name}`);
        }
      }
    };
    await pass(
      this.gitmodulesFound,
      this.gitmodulesDone,
      "gitmodulesMissing",
      "gitmodulesBlob",
      ".gitmodules",
    );
    await pass(
      this.gitattributesFound,
      this.gitattributesDone,
      "gitattributesMissing",
      "gitattributesBlob",
      ".gitattributes",
    );
    return ret;
  }

  /** Blobs whose content a check needs (`.gitmodules`, `.gitattributes`). */
  private keepBlob = (id: string): boolean =>
    this.gitmodulesFound.has(id) || this.gitattributesFound.has(id);

  /** git's `fsck_object_dir`: every loose object file of `objectsDir`. */
  private async fsckLooseObjects(objectsDir: string): Promise<void> {
    const files = this.files as FilesApi;
    for await (const e of this.looseEntries(objectsDir)) {
      if (!e.id) {
        if (!e.name.startsWith("tmp_obj_")) {
          this.emit({ kind: "notice", stream: "stderr", text: `bad sha1 file: ${e.path}` });
        }
        continue;
      }
      const read = await readLooseObject(files, e.path, e.id, {
        bigFileThreshold: this.o.bigFileThreshold,
      });
      for (const m of read.errors) this.error(m, e.id);
      if (read.errors.length > 0) this.badCopy.add(e.id);
      if (!read.object) {
        this.badCopy.add(e.id);
        if (read.realId)
          this.error(`${read.realId}: hash-path mismatch, found at: ${e.path}`, e.id);
        else this.error(`${e.id}: object corrupt or missing: ${e.path}`, e.id);
        this.errorsFound |= FSCK_ERROR_OBJECT;
        continue;
      }
      const r = await this.fsckObjBuffer(
        e.id,
        typeOf(read.object.type),
        read.object.content,
        this.o.compatibility === "2.56"
          ? `${e.id}: object corrupt or missing`
          : `${e.id}: object could not be parsed: ${e.path}`,
        read.object.size,
      );
      if (r > 0) this.errorsFound |= FSCK_ERROR_OBJECT;
    }
  }

  /**
   * git's `verify_bitmap_files`: the trailing SHA-1 of each pack's `.bitmap` (a missing file
   * is fine). True if one is wrong.
   */
  private async verifyBitmapFiles(
    packs: readonly RepoPack[],
    objectsDir: string = this.looseDir(),
  ): Promise<boolean> {
    const files = this.files as FilesApi;
    let bad = false;
    // the multi-pack-index's bitmap first (its name carries the midx checksum)
    const paths: string[] = [];
    if (this.o.multiPackIndex !== false) {
      const loaded = await loadMultiPackIndex(files, pathOf(objectsDir, "pack"), {
        compatibility: this.o.compatibility,
      });
      if (loaded.midx)
        paths.push(pathOf(objectsDir, "pack", `multi-pack-index-${loaded.midx.checksum}.bitmap`));
    }
    for (const p of packs) paths.push(`${p.packPath.replace(/\.pack$/, "")}.bitmap`);
    for (const path of paths) {
      const st = await files.stats(path).catch(() => undefined);
      if (st?.kind !== "file") continue;
      const size = st.size ?? 0;
      let valid = size >= 20;
      if (valid) {
        const hasher = createSha1();
        for await (const c of files.read(path, { start: 0, length: size - 20 })) hasher.update(c);
        const sum = hasher.digest();
        const tail: number[] = [];
        for await (const c of files.read(path, { start: size - 20, length: 20 })) tail.push(...c);
        valid = tail.length === 20 && sum.every((b, i) => b === tail[i]);
      }
      if (!valid) {
        this.error(`bitmap file '${path}' has invalid checksum`);
        bad = true;
      }
    }
    return bad;
  }

  /** git's `verify_pack` for each of `packs`, with `fsck_obj_buffer` for each object. */
  private async fsckPacks(packs: readonly RepoPack[]): Promise<void> {
    const files = this.files as FilesApi;
    for (const p of packs) {
      let err = 0;
      // git prints the pack checksum errors before any entry's output
      let checksumAt = 0;
      const result = await checkPack(
        files,
        p.packPath,
        p.idxPath,
        {
          error: (m) => this.error(m),
          opened: () => {
            checksumAt = this.findings.length;
          },
          checksumError: (m) => {
            this.findings.splice(checksumAt++, 0, {
              kind: "error",
              stream: "stderr",
              text: `error: ${m}`,
              objectId: undefined,
            });
          },
          entry: (entry, unpacked) => {
            if (p.idx.version > 1 && !entry.crcOk) {
              this.error(
                `index CRC mismatch for object ${entry.id} from ${p.packPath} at offset ${entry.offset}`,
                entry.id,
              );
              err = 1;
            }
            if ("error" in unpacked) {
              if (unpacked.zlib) this.error(unpacked.zlib);
              if (unpacked.base) this.error(unpacked.base);
              this.error(unpacked.error, entry.id);
              this.badCopy.add(entry.id);
              // the verification reads this copy (git does not check its hash there)
              this.skipGraphCommit(entry.id);
              err = 1;
              return;
            }
            if (unpacked.type === "commit") this.keepGraphCommit(entry.id, unpacked.content);
            const r = this.fsckObjBuffer(
              entry.id,
              typeOf(unpacked.type),
              unpacked.content,
              `${entry.id}: object corrupt or missing`,
              unpacked.content.length,
              entry.ids,
              entry.idAt,
            );
            if (r instanceof Promise) {
              return r.then((x) => {
                if (x !== 0) err = 1;
              });
            }
            if (r !== 0) err = 1;
          },
        },
        {
          externalBase: (id) => this.readObject(id),
          read: { bytes: p.idxBytes, idx: p.idx },
          keepBlob: this.keepBlob,
        },
      );
      if (result.failed) err = 1;
      if (err) {
        this.errorsFound |= this.o.compatibility === "2.56" ? FSCK_ERROR_OBJECT : FSCK_ERROR_PACK;
      }
    }
  }

  /** Every object of a store without files: read, hash-checked and checked. */
  private async fsckStoredObjects(): Promise<void> {
    const ids: string[] = [];
    for await (const id of this.objects.list()) ids.push(id);
    ids.sort();
    for (const id of ids) {
      let read: { type: string; content: Uint8Array } | undefined;
      try {
        const obj = await this.objects.get(id, { verify: true });
        if (obj) {
          if (obj.type === "blob" && !this.keepBlob(id)) {
            for await (const _ of obj.content) {
              // hashed as it streams
            }
            read = { type: obj.type, content: new Uint8Array(0) };
          } else {
            read = { type: obj.type, content: await collect(obj) };
          }
        }
      } catch {
        read = undefined;
      }
      if (!read) {
        this.error(`${id}: object corrupt or missing`, id);
        this.errorsFound |= FSCK_ERROR_OBJECT;
        continue;
      }
      const r = await this.fsckObjBuffer(
        id,
        typeOf(read.type),
        read.content,
        `${id}: object corrupt or missing`,
      );
      if (r > 0) this.errorsFound |= FSCK_ERROR_OBJECT;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Roots: refs, HEADs, reflogs, index files

  /**
   * `markObject` where it needs no await: an object of the expected type that is reachable
   * already, or stored (then queued). False, with nothing done, otherwise.
   */
  private markReachable(n: number | undefined, type: ObjType): boolean {
    const t = this.t;
    if (n === undefined || t.type(n) !== type) return false;
    const flags = t.flags(n);
    if (flags & REACHABLE) return true;
    if (this.promised?.has(t.id(n))) {
      // a promisor object: reachable, not walked further (mark_object)
      t.addFlags(n, REACHABLE);
      return true;
    }
    if (!(flags & HAS_OBJ)) return false;
    t.addFlags(n, REACHABLE);
    this.pending.push(n);
    return true;
  }

  /** git's `mark_object`: without a promise when it reports nothing. */
  private markObject(
    n: number | undefined,
    type: ObjType | "any",
    parent: number | undefined,
  ): number | Promise<number> {
    const t = this.t;
    if (n !== undefined && (type === "any" || parent === undefined || t.type(n) === type)) {
      const flags = t.flags(n);
      if (flags & REACHABLE) return 0;
      if (this.promised?.has(t.id(n))) {
        t.addFlags(n, REACHABLE);
        return 0;
      }
      if (flags & HAS_OBJ) {
        t.addFlags(n, REACHABLE);
        this.pending.push(n);
        return 0;
      }
    }
    return this.markObjectReporting(n, type, parent);
  }

  /** `markObject` where it may report: a broken link, a wrong type, an object not stored. */
  private async markObjectReporting(
    n: number | undefined,
    type: ObjType | "any",
    parent: number | undefined,
  ): Promise<number> {
    const t = this.t;
    if (n === undefined) {
      const p = parent as number;
      this.emit({
        kind: "broken-link",
        stream: "stdout",
        text: `broken link from ${(await this.printableType(p)).padStart(7)} ${this.describe(t.id(p))}`,
        objectId: t.id(p),
      });
      this.emit({
        kind: "broken-link",
        stream: "stdout",
        text: `broken link from ${(type === "any" ? "unknown" : TYPE_NAME[type]).padStart(7)} unknown`,
      });
      this.errorsFound |= FSCK_ERROR_REACHABLE;
      return 1;
    }
    if (type !== "any" && t.type(n) !== type && parent !== undefined) {
      await this.objerror(parent, "wrong object type in link");
    }
    if (t.flags(n) & REACHABLE) return 0;
    t.addFlags(n, REACHABLE);
    // a promisor object needs no further recursion (it is not missing: it will be fetched);
    // 2.43 asks only for an object it does not have
    if (
      (this.o.compatibility === "2.56" || !(t.flags(n) & HAS_OBJ)) &&
      this.promised?.has(t.id(n))
    ) {
      return 0;
    }
    if (!(t.flags(n) & HAS_OBJ)) {
      const id = t.id(n);
      if (parent !== undefined && !(await this.hasObject(id))) {
        const pid = t.id(parent);
        this.emit({
          kind: "broken-link",
          stream: "stdout",
          text: `broken link from ${(await this.printableType(parent)).padStart(7)} ${this.describe(pid)}`,
          objectId: pid,
        });
        this.emit({
          kind: "broken-link",
          stream: "stdout",
          text: `              to ${(await this.printableType(n)).padStart(7)} ${this.describe(id)}`,
          objectId: id,
        });
        this.errorsFound |= FSCK_ERROR_REACHABLE;
      }
      return 1;
    }
    this.pending.push(n);
    return 0;
  }

  /** git's `fsck_handle_ref`. */
  private async handleRef(name: string, id: string): Promise<void> {
    const n = await this.parseObject(id);
    if (n === undefined) {
      // a promisor object: a valid ref
      if (this.promised?.has(id)) {
        this.defaultRefs++;
        return;
      }
      this.error(`${name}: invalid sha1 pointer ${id}`, id);
      this.errorsFound |= FSCK_ERROR_REACHABLE;
      return;
    }
    if (this.t.type(n) !== OBJ_COMMIT && name.startsWith("refs/heads/")) {
      this.error(`${name}: not a commit`, id);
      this.errorsFound |= FSCK_ERROR_REFS;
    }
    this.defaultRefs++;
    this.t.addFlags(n, USED);
    this.putName(id, name);
    await this.markObject(n, "any", undefined);
  }

  /** git's `fsck_handle_reflog_oid`. */
  private async handleReflogOid(refname: string, id: string, timestamp: number): Promise<void> {
    if (id === ZERO_ID) return;
    const n = this.t.lookup(id);
    if (n >= 0 && this.t.flags(n) & HAS_OBJ) {
      if (timestamp) this.putName(id, `${refname}@{${timestamp}}`);
      this.t.addFlags(n, USED);
      await this.markObject(n, "any", undefined);
    } else if (!this.promised?.has(id)) {
      this.error(`${refname}: invalid reflog entry ${id}`, id);
      this.errorsFound |= FSCK_ERROR_REACHABLE;
    }
  }

  /**
   * What a listed ref resolves to, or the null id when it does not resolve (a dangling symbolic
   * ref, or one deeper than git's 5 reads: git's `for_each_rawref` passes those with a null id).
   */
  private async resolvedId(name: string): Promise<string> {
    try {
      return (await this.followChain(name, 0))?.id || ZERO_ID;
    } catch {
      return ZERO_ID;
    }
  }

  /** git's `get_default_heads`. */
  private async processRefs(): Promise<void> {
    const refs = this.stores.refs;
    const listed: string[] = [];
    for await (const ref of refs.list("refs/")) listed.push(ref.name);
    listed.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of [...new Set(listed)]) {
      // a symbolic ref that resolves to nothing is the null id to git (`invalid sha1 pointer`)
      await this.handleRef(name, await this.resolvedId(name));
    }

    for (const wt of await this.worktrees()) {
      await this.headLink(wt);
      if (this.o.reflogs) await this.processReflogs(wt);
    }

    if (!this.defaultRefs) {
      this.emit({ kind: "notice", stream: "stderr", text: "notice: No default references" });
      this.showUnreachable = false;
    }
  }

  /** git 2.45+'s `snapshot_refs`: every ref, then each worktree's HEAD, parsed before the objects. */
  private async snapshotRefs(): Promise<{ name: string; id: string }[]> {
    const refs = this.stores.refs;
    const snapshot: { name: string; id: string }[] = [];
    const snapshotRef = async (name: string, id: string) => {
      const n = await this.parseObject(id);
      if (n === undefined) {
        if (this.promised?.has(id)) {
          this.defaultRefs++;
          return;
        }
        this.error(`${name}: invalid sha1 pointer ${id}`, id);
        this.errorsFound |= FSCK_ERROR_REACHABLE;
        return;
      }
      if (this.t.type(n) !== OBJ_COMMIT && name.startsWith("refs/heads/")) {
        this.error(`${name}: not a commit`, id);
        this.errorsFound |= FSCK_ERROR_REFS;
      }
      this.defaultRefs++;
      snapshot.push({ name, id });
    };
    const listed: string[] = [];
    for await (const ref of refs.list("refs/")) listed.push(ref.name);
    listed.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of [...new Set(listed)]) await snapshotRef(name, await this.resolvedId(name));
    for (const wt of await this.worktrees()) {
      const id = await this.headId(wt);
      if (id && id !== ZERO_ID) await snapshotRef(wt.headName, id);
    }
    return snapshot;
  }

  /** git 2.45+'s `process_refs`: the snapshotted refs, then every worktree's reflogs. */
  private async processSnapshot(snapshot: { name: string; id: string }[]): Promise<void> {
    for (const { name, id } of snapshot) {
      const n = await this.parseObject(id);
      if (n === undefined) continue;
      this.t.addFlags(n, USED);
      this.putName(id, name);
      await this.markObject(n, "any", undefined);
    }
    if (this.o.reflogs) {
      for (const wt of await this.worktrees()) await this.processReflogs(wt);
    }
    if (!this.defaultRefs) {
      this.emit({ kind: "notice", stream: "stderr", text: "notice: No default references" });
      this.showUnreachable = false;
    }
  }

  private async processReflogs(wt: WorktreeState): Promise<void> {
    for (const log of await this.reflogs(wt)) {
      // git 2.43's reflog iterator resolves each ref first and skips one deeper than 5 reads
      if (this.o.compatibility === "2.43" && log.path && (await this.tooDeep(wt, log.name))) {
        this.error(`bad ref for ${log.path}`);
        continue;
      }
      for (const e of log.entries) {
        await this.handleReflogOid(log.name, e.oldId, 0);
        await this.handleReflogOid(log.name, e.newId, e.timestamp);
      }
    }
  }

  /** What a worktree's HEAD resolves to, if anything (within git's 5 reads, HEAD's included). */
  private async headId(wt: WorktreeState): Promise<string | undefined> {
    if (wt.current) {
      const head = await this.stores.refs.get("HEAD");
      if (!head) return undefined;
      if (!isSymbolicRef(head)) return head.objectId;
      return (await this.followChain(head.target, 1))?.id;
    }
    const text = (await readText(this.files as FilesApi, pathOf(wt.dir as string, "HEAD")))?.trim();
    if (!text) return undefined;
    if (text.startsWith("ref:")) return (await this.followChain(text.slice(4).trim(), 1))?.id;
    return OID.test(text.slice(0, 40)) ? text.slice(0, 40) : undefined;
  }

  /**
   * Whether the ref of the reflog `logName` is a symbolic ref chain deeper than git's 5 reads
   * (`resolve_ref_unsafe` fails: git 2.43 prints `bad ref for <log>`; a missing ref is fine).
   */
  private async tooDeep(wt: WorktreeState, logName: string): Promise<boolean> {
    try {
      if (logName === "HEAD" && wt.current) {
        const head = await this.stores.refs.get("HEAD");
        return !!head && isSymbolicRef(head) && !(await this.followChain(head.target, 1));
      }
      if (logName.startsWith("worktrees/")) {
        if (!wt.dir || !logName.endsWith("/HEAD") || logName.split("/").length !== 3) return false;
        const text = (await readText(this.files as FilesApi, pathOf(wt.dir, "HEAD")))?.trim();
        return !!text?.startsWith("ref:") && !(await this.followChain(text.slice(4).trim(), 1));
      }
      return !(await this.followChain(logName, 0));
    } catch {
      return false;
    }
  }

  /** The main worktree, then the linked ones (`.git/worktrees/<id>`). */
  private async worktrees(): Promise<WorktreeState[]> {
    const list: WorktreeState[] = [{ headName: "HEAD", dir: this.gitDir, current: true }];
    const files = this.files;
    if (!files) return list;
    const dir = pathOf(this.gitDir, "worktrees");
    if ((await files.stats(dir))?.kind !== "directory") return list;
    const names: string[] = [];
    for await (const e of files.list(dir)) {
      if (e.kind === "directory" && (await files.stats(pathOf(e.path, "HEAD")))?.kind === "file") {
        names.push(e.name);
      }
    }
    names.sort();
    for (const name of names) {
      list.push({ headName: `worktrees/${name}/HEAD`, dir: pathOf(dir, name), current: false });
    }
    return list;
  }

  /**
   * Where the symbolic ref chain from `target` ends, as git's `resolve_ref_unsafe` follows it:
   * the last name and its id (none when that ref does not exist), or undefined when the chain
   * takes more than git's SYMREF_MAXDEPTH (5) reads in all. `reads` is how many were made
   * before `target` (1 when HEAD, read first, points at it).
   */
  private async followChain(
    target: string,
    reads: number,
  ): Promise<{ name: string; id?: string } | undefined> {
    let name = target;
    for (let read = reads + 1; ; read++) {
      const value = await this.stores.refs.get(name);
      if (!value) return { name };
      if (!isSymbolicRef(value)) return { name, id: value.objectId };
      if (read >= 5) return undefined;
      name = value.target;
    }
  }

  /** git's `fsck_head_link` and the HEAD of a worktree as a root. */
  private async headLink(wt: WorktreeState): Promise<void> {
    const name = wt.headName;
    let target: string | undefined;
    let id: string | undefined;
    const invalid = () => {
      this.errorsFound |= FSCK_ERROR_REFS;
      this.error(`invalid ${name}`);
    };
    let symref: string | undefined;
    if (wt.current) {
      const head = await this.stores.refs.get("HEAD");
      if (!head) return invalid();
      if (isSymbolicRef(head)) symref = head.target;
      else id = head.objectId;
    } else {
      const text = (
        await readText(this.files as FilesApi, pathOf(wt.dir as string, "HEAD"))
      )?.trim();
      if (!text) return invalid();
      if (text.startsWith("ref:")) symref = text.slice(4).trim();
      else if (OID.test(text.slice(0, 40))) id = text.slice(0, 40);
      else return invalid();
    }
    if (symref !== undefined) {
      // the whole chain: HEAD -> refs/heads/alias -> refs/remotes/origin/x points at the last
      // HEAD itself was the first of git's 5 reads
      const end = await this.followChain(symref, 1);
      if (!end) return invalid();
      target = end.name;
      id = end.id;
    }
    if (target !== undefined && !target.startsWith("refs/heads/")) {
      this.errorsFound |= FSCK_ERROR_REFS;
      this.error(`${name} points to something strange (${target})`);
      // git still takes what HEAD resolves to as a root
      if (id && id !== ZERO_ID) await this.handleRef(name, id);
      return;
    }
    if (!id || id === ZERO_ID) {
      if (target === undefined) {
        this.errorsFound |= FSCK_ERROR_REFS;
        this.error(`${name}: detached HEAD points at nothing`);
        return;
      }
      this.emit({
        kind: "notice",
        stream: "stderr",
        text: `notice: ${name} points to an unborn branch (${target.slice(11)})`,
      });
      return;
    }
    await this.handleRef(name, id);
  }

  /** The reflogs of one worktree, in git's order (sorted by name, as git 2.45+ lists them). */
  private async reflogs(wt: WorktreeState): Promise<Reflog[]> {
    const files = this.files;
    if (!files) return wt.current ? this.storeReflogs() : [];
    const logs: Reflog[] = [];
    const collectDir = async (base: string, keep: (name: string) => boolean, prefix: string) => {
      const found: { name: string; path: string }[] = [];
      const walk = async (dir: string, rel: string) => {
        if ((await files.stats(dir))?.kind !== "directory") return;
        const entries: { name: string; path: string; kind: string }[] = [];
        for await (const e of files.list(dir)) entries.push(e);
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of entries) {
          const name = rel ? `${rel}/${e.name}` : e.name;
          if (e.kind === "directory") await walk(e.path, name);
          else if (keep(name)) found.push({ name, path: e.path });
        }
      };
      await walk(base, "");
      for (const f of found) {
        logs.push({
          name: prefix + f.name,
          path: pathOf(base, f.name),
          entries: parseReflog(await readText(files, f.path)),
        });
      }
    };
    if (wt.current) {
      await collectDir(pathOf(this.gitDir, "logs"), () => true, "");
    } else {
      const dir = wt.dir as string;
      const id = dir.slice(dir.lastIndexOf("/") + 1);
      await collectDir(pathOf(dir, "logs"), (n) => PER_WORKTREE.test(n), `worktrees/${id}/`);
      await collectDir(pathOf(this.gitDir, "logs"), (n) => !PER_WORKTREE.test(n), "");
      logs.sort((a, b) => {
        const x = a.name.replace(/^worktrees\/[^/]+\//, "");
        const y = b.name.replace(/^worktrees\/[^/]+\//, "");
        return x < y ? -1 : x > y ? 1 : 0;
      });
    }
    return logs;
  }

  /** Reflogs through the refs store (a store without files): HEAD and every ref. */
  private async storeReflogs(): Promise<Reflog[]> {
    const refs = this.stores.refs;
    if (!refs.getReflog) return [];
    const names = ["HEAD"];
    for await (const ref of refs.list("refs/")) names.push(ref.name);
    const sorted = [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const logs: Reflog[] = [];
    for (const name of sorted) {
      const reader = await refs.getReflog(name);
      if (!reader) continue;
      const entries = (await reader.getReverseEntries()).reverse();
      if (entries.length === 0) continue;
      logs.push({
        name,
        entries: entries.map((e) => ({
          oldId: e.oldId,
          newId: e.newId,
          timestamp: e.who.timestamp,
        })),
      });
    }
    return logs;
  }

  /**
   * git's index pass: every worktree's index (`fsck_index`). Returns git's lines when it dies
   * reading one (`read_index_from` with `verify_index_checksum`: a wrong trailer, of the index
   * or its shared index, is `error: bad index file sha1 signature` then `fatal: index file
   * corrupt`, exit 128).
   */
  private async processIndexes(): Promise<readonly string[] | undefined> {
    const files = this.files;
    if (!files) {
      await this.storeIndex();
      return undefined;
    }
    for (const wt of await this.worktrees()) {
      const indexPath = pathOf(wt.dir as string, "index");
      if ((await files.stats(indexPath))?.kind !== "file") continue;
      // a split index merged with its shared index, a sparse index expanded (repo_read_index)
      let read: Awaited<ReturnType<typeof readIndexFileEntries>>;
      try {
        // fsck alone checks the index's trailing hash (verify_index_checksum)
        read = await readIndexFileEntries(files, indexPath, {
          gitDir: wt.dir as string,
          trees: this.stores.trees(),
          verifyChecksum: true,
        });
      } catch (error) {
        if (error instanceof IndexCorruptError) return error.lines;
        // a sparse directory whose tree is missing: its own entry stands for it (the index
        // and its shared index were hashed before the expansion failed)
        try {
          read = await readIndexFileEntries(files, indexPath, { gitDir: wt.dir as string });
        } catch (again) {
          if (again instanceof IndexCorruptError) return again.lines;
          throw again;
        }
      }
      if (!read) continue;
      const parsed = { entries: read.entries, extensionData: read.extensions };
      const prefix = wt.current ? "" : indexPath;
      const entries = parsed.entries.map((e) => ({
        path: e.path,
        mode: e.mode,
        objectId: e.objectId,
      }));
      let cacheTree: CacheTree | undefined;
      let resolveUndo: ResolveUndoRecord[] = [];
      for (const ext of parsed.extensionData) {
        if (ext.signature === "TREE") cacheTree = parseCacheTree(ext.data);
        else if (ext.signature === "REUC") resolveUndo = parseResolveUndo(ext.data);
      }
      await this.fsckIndex(entries, cacheTree, resolveUndo, indexPath, prefix);
    }
    return undefined;
  }

  /** The staging area of a store without files, as the current worktree's index. */
  private async storeIndex(): Promise<void> {
    let staging: Staging;
    try {
      staging = this.stores.staging();
    } catch {
      return;
    }
    const entries: { path: string; mode: number; objectId: string }[] = [];
    for await (const e of staging.entries()) {
      entries.push({ path: e.path, mode: e.mode, objectId: e.objectId });
    }
    await this.fsckIndex(entries, staging.getCacheTree?.(), [], `${this.gitDir}/index`, "");
  }

  /** git's `fsck_index`. */
  private async fsckIndex(
    entries: { path: string; mode: number; objectId: string }[],
    cacheTree: CacheTree | undefined,
    resolveUndo: ResolveUndoRecord[],
    indexPath: string,
    prefix: string,
  ): Promise<void> {
    for (const e of entries) {
      if ((e.mode & 0o170000) === 0o160000) continue;
      const blob = this.t.lookupTyped(e.objectId, OBJ_BLOB);
      if (typeof blob !== "number") {
        this.error(blob.error);
        continue;
      }
      this.t.addFlags(blob, USED);
      this.putName(e.objectId, `${prefix}:${e.path}`);
      await this.markObject(blob, "any", undefined);
    }
    if (cacheTree) await this.fsckCacheTree(cacheTree, indexPath);
    // resolve-undo: git keeps it as a string list sorted by path
    const sorted = [...resolveUndo].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    for (const record of sorted) {
      for (let i = 0; i < 3; i++) {
        const mode = record.modes[i] ?? 0;
        const id = record.objectIds[i];
        if (!mode || (mode & 0o170000) !== 0o100000 || !id) continue;
        const n = await this.parseObject(id);
        if (n === undefined) {
          this.error(`${id}: invalid sha1 pointer in resolve-undo of ${indexPath}`, id);
          this.errorsFound |= FSCK_ERROR_REFS;
          continue;
        }
        this.t.addFlags(n, USED);
        this.putName(id, `:(${i}):${record.path}`);
        await this.markObject(n, "any", undefined);
      }
    }
  }

  /** git's `fsck_cache_tree`. */
  private async fsckCacheTree(node: CacheTree, indexPath: string): Promise<void> {
    if (node.entryCount >= 0 && node.id) {
      const n = await this.parseObject(node.id);
      if (n === undefined) {
        this.error(`${node.id}: invalid sha1 pointer in cache-tree of ${indexPath}`, node.id);
        this.errorsFound |= FSCK_ERROR_REFS;
        return;
      }
      this.t.addFlags(n, USED);
      this.putName(node.id, ":");
      await this.markObject(n, "any", undefined);
      if (this.t.type(n) !== OBJ_TREE) await this.objerror(n, "non-tree in cache-tree");
    }
    for (const sub of node.subtrees) await this.fsckCacheTree(sub.tree, indexPath);
  }

  // ------------------------------------------------------------------------------------------
  // Connectivity

  /**
   * The pack-order scan of a connectivity-only run (`scanPackObjects`): the commits (unless a
   * commit-graph gives them) and trees of each pack, unpacked in one read and kept as the
   * objects they link to (`scanAt`). An object is taken from the first pack that holds it,
   * as the store reads it, and never when it is loose too (the store may read that copy); a
   * pack that cannot be read leaves its objects to the walk's reads. At most `linksKept`
   * links are kept: the scan stops there, and the walk reads the rest from the store.
   */
  private async scanPacks(packed: Int32Array[], loose: number[]): Promise<void> {
    const files = this.files as FilesApi;
    const t = this.t;
    const claimed = new Uint8Array(t.size);
    for (const n of loose) claimed[n] = 1;
    this.scanAt = new Int32Array(t.size);
    this.scanKids = new Int32Array(
      Math.max(0, Math.min(1 << 16, this.o.linksKept - this.kidsLength)),
    );
    const withCommits = !this.graph;
    const keepCommits = this.graphCommits !== undefined;
    /** objects whose copy the commit-graph verification reads is decided (an earlier pack's) */
    const decided = keepCommits ? new Uint8Array(t.size) : undefined;
    let full = false;
    for (let k = 0; k < this.packs.length && !full; k++) {
      const p = this.packs[k] as RepoPack;
      const ns = packed[k] as Int32Array;
      try {
        this.objectsScanned += await scanPackObjects(
          files,
          p.packPath,
          p.idxBytes,
          p.idx,
          (type) => type === OBJ_TREE || (type === OBJ_COMMIT && (withCommits || keepCommits)),
          (pos, type, content) => {
            const n = ns[pos] as number;
            if (type === OBJ_COMMIT && decided && !decided[n]) {
              decided[n] = 1;
              const at = p.idx.version > 1 ? 8 + 1024 + pos * 20 : 1024 + 4 + pos * 24;
              this.keepGraphCommit(bytesToHex(p.idxBytes.subarray(at, at + 20)), content);
            }
            if (type === OBJ_COMMIT && !withCommits) return;
            if (claimed[n]) return;
            claimed[n] = 1;
            if (!this.recordScanned(n, type, content)) {
              full = true;
              return false;
            }
          },
        );
      } catch {
        // the walk reads what this pack holds through the store
      }
      for (let i = 0; i < ns.length; i++) {
        claimed[ns[i] as number] = 1;
        if (decided) decided[ns[i] as number] = 1;
      }
    }
  }

  /**
   * `scanAt` for object `n`, a commit or a tree, from its content. False when it does not fit
   * in `linksKept` (nothing recorded).
   */
  private recordScanned(n: number, type: number, content: Uint8Array): boolean {
    const t = this.t;
    const start = this.scanKidsLength;
    let at = start + 1;
    if (type === OBJ_TREE) {
      // the entries as `scanTree` decodes them, for a tree it decodes without an error (any
      // other is left to the walk, which reports it)
      const len = content.length;
      if (len > 0 && (len < 23 || content[len - 21] !== 0)) return true;
      if (!this.reserveScanKids(1 + Math.floor(len / 23))) return false;
      const kids = this.scanKids;
      let p = 0;
      while (p < len) {
        if (len - p < 23 || content[p] === 0x20) return true;
        let mode = 0;
        for (;;) {
          const c = content[p++] as number;
          if (c === 0x20) break;
          if (c < 0x30 || c > 0x37) return true;
          mode = (mode * 8 + (c - 0x30)) & 0xffff;
        }
        if (content[p] === 0) return true;
        while (p < len && content[p] !== 0) p++;
        if (p + 21 > len) return true;
        const idAt = p + 1;
        p = idAt + 20;
        const format = mode & 0o170000;
        // gitlinks are not walked (canon_mode makes every other format one)
        if (format !== 0o100000 && format !== 0o120000 && format !== 0o040000) continue;
        const c = t.peekRaw(content, idAt);
        if (c < 0) return true;
        kids[at++] = (c << 1) | (format === 0o040000 ? 1 : 0);
      }
    } else {
      const parsed = parseCommitLinks(content, "");
      if ("error" in parsed) return true;
      if (!this.reserveScanKids(2 + parsed.parents.length)) return false;
      const kids = this.scanKids;
      const raw = this.idScratch;
      const tree = t.peekRaw(rawIdAt(content, parsed.tree, raw), 0);
      if (tree < 0) return true;
      kids[at++] = tree;
      for (const p of parsed.parents) {
        const c = t.peekRaw(rawIdAt(content, p, raw), 0);
        if (c < 0) return true;
        kids[at++] = c;
      }
    }
    this.scanKids[start] = ((at - start - 1) << 2) | type;
    this.scanKidsLength = at;
    this.scanAt[n] = start + 1;
    return true;
  }

  /**
   * Room in `scanKids` for `more` values, within what `linksKept` leaves after `kids` (the
   * limit is the two together); false past it.
   */
  private reserveScanKids(more: number): boolean {
    const need = this.scanKidsLength + more;
    const limit = this.o.linksKept - this.kidsLength;
    if (need > limit) return false;
    if (need <= this.scanKids.length) return true;
    let size = Math.max(this.scanKids.length * 2, 16);
    while (size < need) size *= 2;
    const kids = new Int32Array(Math.min(size, limit));
    kids.set(this.scanKids.subarray(0, this.scanKidsLength));
    this.scanKids = kids;
    return true;
  }

  /**
   * git's parse of commit `n` from what the scan kept (`scanAt` start `s`): the lookups
   * `parse_commit_buffer` makes, in its order. False, with nothing done, when one of them would
   * fail (an object of another type): the walk then reads the commit as it reads any other.
   */
  private parseScannedCommit(n: number, s: number): boolean {
    const t = this.t;
    const kids = this.scanKids;
    const count = (kids[s] as number) >> 2;
    const tree = kids[s + 1] as number;
    const have = t.type(tree);
    if (have !== OBJ_NONE && have !== OBJ_TREE) return false;
    // a grafted commit is read as any other (its parents are not the ones scanned)
    if (this.grafts?.has(t.id(n))) return false;
    const shallow = this.shallow.size > 0 && this.shallow.has(t.id(n));
    if (!shallow) {
      for (let i = s + 2; i <= s + count; i++) {
        const p = kids[i] as number;
        const pt = t.type(p);
        if (p === tree || (pt !== OBJ_NONE && pt !== OBJ_COMMIT)) return false;
      }
    }
    if (this.graftsHint) this.adviseGrafts();
    if (this.graftErrors.length > 0) this.reportGraftErrors();
    // parse_object's lookup, then parse_object_buffer's
    t.touch(n);
    t.setType(n, OBJ_COMMIT);
    this.objectsRead++;
    t.lookupTypedN(tree, OBJ_TREE);
    const parents: number[] = [];
    if (!shallow) {
      for (let i = s + 2; i <= s + count; i++) {
        const p = kids[i] as number;
        t.lookupTypedN(p, OBJ_COMMIT);
        parents.push(p);
      }
    }
    t.links.set(n, { tree, parents });
    t.addFlags(n, PARSED);
    return true;
  }

  /**
   * git's `fsck_walk` with `mark_object` (`traverse_one_object`), for `runSteps`: it yields only
   * the promises it waits for, so an object whose reads are in memory is walked synchronously.
   */
  private *traverseOne(n: number): Steps<void> {
    const t = this.t;
    // fsck_walk returns at once for a blob (no id to build, nothing to read)
    if (t.type(n) === OBJ_BLOB) return;
    if (t.type(n) === OBJ_TREE && t.flags(n) & PARSED) {
      const start = n < this.treeStart.length ? (this.treeStart[n] as number) - 1 : -1;
      if (start >= 0) {
        if (this.badCopy.size === 0 || !this.badCopy.has(t.id(n))) {
          // checked in full already: its entries again, as they resolved then
          const kids = this.kids;
          for (let i = start + 1, end = start + 1 + (kids[start] as number); i < end; i++) {
            const v = kids[i] as number;
            const c = v >> 1;
            const type = v & 1 ? OBJ_TREE : OBJ_BLOB;
            t.touch(c); // the lookup git makes moves it in the hash
            if (!this.markReachable(c, type)) {
              const r = this.markObject(c, type, n);
              if (r instanceof Promise) yield r;
            }
          }
          return;
        }
      }
    }
    // what the pack-order scan kept of it, when it holds an object of the type the walk expects
    // (an object met untyped is parse_object's, which checks its hash: read from the store)
    const s = n < this.scanAt.length ? (this.scanAt[n] as number) - 1 : -1;
    let scanned = false;
    if (s >= 0 && !(t.flags(n) & PARSED)) {
      const kids = this.scanKids;
      const head = kids[s] as number;
      const have = t.type(n);
      if ((head & 3) === OBJ_TREE && have === OBJ_TREE) {
        const rest = this.walkScannedTree(n, s);
        if (rest) yield* rest;
        return;
      }
      if ((head & 3) === OBJ_COMMIT && have === OBJ_COMMIT) {
        scanned = this.parseScannedCommit(n, s);
      }
    }
    const id = t.id(n);
    this.lastRead = undefined;
    if (t.type(n) === OBJ_NONE) {
      // fsck_walk's parse_object, hash-checked
      const r = this.parseObject(id);
      if (r instanceof Promise) yield r;
    } else if (
      !scanned &&
      (t.type(n) === OBJ_COMMIT || t.type(n) === OBJ_TAG) &&
      !(t.flags(n) & PARSED)
    ) {
      // repo_parse_commit (from the commit-graph when it has the commit) / parse_tag
      if (!(t.type(n) === OBJ_COMMIT && this.graph && this.parseCommitInGraph(n, id))) {
        const r = this.parseAs(n, id);
        if (r instanceof Promise) yield r;
      }
    }
    const name = this.names?.get(id);
    switch (t.type(n)) {
      case OBJ_BLOB:
        return;
      case OBJ_TREE: {
        // the tree just parsed, or read now
        const last = this.lastRead as { id: string; obj: Whole } | undefined;
        let obj: Whole | undefined | Promise<Whole | undefined> =
          last !== undefined && last.id === id ? last.obj : this.readWhole(id);
        this.lastRead = undefined;
        if (obj instanceof Promise) obj = (yield obj) as Whole | undefined;
        // git's parse_tree
        if (!obj) {
          if (this.lastZlibError) this.error(this.lastZlibError);
          this.error(`Could not read ${id}`);
          return;
        }
        if (obj.type !== "tree") {
          this.error(`Object ${id} not a tree`);
          return;
        }
        t.addFlags(n, PARSED);
        const walk = scanTree(obj.content, this.walkTable);
        if (walk.initError) {
          this.error(walk.initError);
          return;
        }
        const content = obj.content;
        const f = walk.fields;
        for (let i = 0; i < walk.count; i++) {
          const mode = canonMode(f[3 * i] as number);
          if (mode === 0o160000) continue;
          const isTree = mode === 0o040000;
          const idAt = f[3 * i + 2] as number;
          const child = t.lookupTypedRaw(content, idAt, isTree ? OBJ_TREE : OBJ_BLOB);
          let c: number | undefined;
          if (typeof child === "number") c = child;
          else this.error(child.error);
          if (name !== undefined && c !== undefined) {
            const entryName = content.subarray(f[3 * i + 1] as number, idAt - 1);
            this.putName(t.id(c), `${name}${decodeGitPath(entryName)}${isTree ? "/" : ""}`);
          }
          if (!this.markReachable(c, isTree ? OBJ_TREE : OBJ_BLOB)) {
            const r = this.markObject(c, isTree ? OBJ_TREE : OBJ_BLOB, n);
            if (r instanceof Promise) yield r;
          }
        }
        if (walk.error) this.error(walk.error);
        return;
      }
      case OBJ_COMMIT: {
        // the parse reported why it failed
        if (!(t.flags(n) & PARSED)) return;
        const links = t.links.get(n);
        if (!links || links.tree === undefined) return;
        if (name !== undefined) this.putName(t.id(links.tree), `${name}:`);
        const marked = this.markObject(links.tree, OBJ_TREE, n);
        if (marked instanceof Promise) yield marked;
        const parents = links.parents ?? [];
        let generation = 0;
        let prefixLength = 0;
        if (name !== undefined && parents.length > 0) {
          if (name.endsWith("^")) {
            generation = 1;
            prefixLength = name.length - 1;
          } else {
            const m = /~(\d+)$/.exec(name);
            if (m && (m[1] as string).length > 0) {
              generation = Number(m[1]);
              prefixLength = name.length - (m[1] as string).length - 1;
            } else {
              generation = 0;
              prefixLength = name.length;
            }
          }
        }
        let counter = 0;
        for (const p of parents) {
          if (name !== undefined) {
            const pid = t.id(p);
            if (counter++) this.putName(pid, `${name}^${counter}`);
            else if (generation > 0)
              this.putName(pid, `${name.slice(0, prefixLength)}~${generation + 1}`);
            else this.putName(pid, `${name}^`);
          }
          const r = this.markObject(p, OBJ_COMMIT, n);
          if (r instanceof Promise) yield r;
        }
        return;
      }
      case OBJ_TAG: {
        const links = t.links.get(n);
        if (!(t.flags(n) & PARSED)) return;
        if (links?.tagged === undefined) return;
        if (name !== undefined) this.putName(t.id(links.tagged), name);
        const marked = this.markObject(links.tagged, "any", n);
        if (marked instanceof Promise) yield marked;
        return;
      }
      default:
        this.error(`Unknown object type for ${this.describe(id)}`);
    }
  }

  /**
   * The walk of tree `n` from what the scan kept (`scanAt` start `s`): parse_object's lookup
   * and parse, then the tree's entries, looked up in order and marked. Synchronous while every
   * entry is marked without a report; the steps for the rest otherwise.
   */
  private walkScannedTree(n: number, s: number): Steps<void> | undefined {
    const t = this.t;
    const kids = this.scanKids;
    t.touch(n);
    t.setType(n, OBJ_TREE);
    t.addFlags(n, PARSED);
    this.objectsRead++;
    for (let i = s + 1, end = s + 1 + ((kids[s] as number) >> 2); i < end; i++) {
      const v = kids[i] as number;
      const type = v & 1 ? OBJ_TREE : OBJ_BLOB;
      const child = t.lookupTypedN(v >> 1, type);
      if (typeof child === "number" && this.markReachable(child, type)) continue;
      return this.walkScannedRest(n, s, i, child);
    }
    return undefined;
  }

  /** `walkScannedTree` from entry `i` on, whose lookup gave `child`. */
  private *walkScannedRest(
    n: number,
    s: number,
    i: number,
    child: number | { error: string },
  ): Steps<void> {
    const t = this.t;
    const kids = this.scanKids;
    for (const end = s + 1 + ((kids[s] as number) >> 2); ; ) {
      const type = (kids[i] as number) & 1 ? OBJ_TREE : OBJ_BLOB;
      let c: number | undefined;
      if (typeof child === "number") c = child;
      else this.error(child.error);
      if (!this.markReachable(c, type)) {
        const r = this.markObject(c, type, n);
        if (r instanceof Promise) yield r;
      }
      if (++i >= end) return;
      const v = kids[i] as number;
      child = t.lookupTypedN(v >> 1, v & 1 ? OBJ_TREE : OBJ_BLOB);
    }
  }

  /** git's `mark_unreachable_referents` (connectivity-only runs). */
  private markUnreachableReferents(raw: Uint8Array, at: number): void | Promise<void> {
    const t = this.t;
    const n = t.lookupRaw(raw, at);
    if (n < 0 || !(t.flags(n) & HAS_OBJ) || t.flags(n) & REACHABLE) return;
    return this.markReferents(n);
  }

  private async markReferents(n: number): Promise<void> {
    const t = this.t;
    const id = t.id(n);
    if (t.type(n) === OBJ_NONE) {
      const type = typeOf((await this.storeType(id)) ?? "");
      if (type !== OBJ_NONE) t.setType(n, type);
    }
    const type = t.type(n);
    if (type === OBJ_TREE) {
      const obj = await this.readWhole(id);
      if (!obj) return;
      if (obj.type !== "tree") {
        // git's parse_tree
        this.error(`Object ${id} not a tree`);
        return;
      }
      this.walkUsed(n, obj.content);
    } else if (type === OBJ_COMMIT || type === OBJ_TAG) {
      // repo_parse_commit / parse_tag: no hash check
      if (!(t.flags(n) & PARSED)) await this.parseAs(n, id);
      if (t.flags(n) & PARSED) this.walkUsed(n, new Uint8Array(0));
    }
  }

  /** git's `check_connectivity`. */
  private async checkConnectivity(): Promise<void> {
    const t = this.t;
    const pending = this.pending;
    const scanAt = this.scanAt;
    while (pending.length > 0) {
      const n = pending.pop() as number;
      // fsck_walk returns at once for a blob
      if (t.type(n) === OBJ_BLOB) continue;
      // a tree the scan kept, walked without steps while it needs no await
      const s = n < scanAt.length ? (scanAt[n] as number) - 1 : -1;
      if (
        s >= 0 &&
        ((this.scanKids[s] as number) & 3) === OBJ_TREE &&
        !(t.flags(n) & PARSED) &&
        t.type(n) === OBJ_TREE
      ) {
        const rest = this.walkScannedTree(n, s);
        if (rest) {
          const r = runSteps(rest);
          if (r instanceof Promise) await r;
        }
        continue;
      }
      const r = runSteps(this.traverseOne(n));
      if (r instanceof Promise) await r;
    }
    if (this.o.connectivityOnly && (this.o.dangling || this.o.lostFound)) {
      await this.forEachStored((raw, at) => this.markUnreachableReferents(raw, at));
    }
    for (const n of [...t.inSlotOrder()]) {
      const id = t.id(n);
      const flags = t.flags(n);
      if (flags & REACHABLE) {
        if (this.promised?.has(id) || flags & HAS_OBJ || this.inPack(id)) continue;
        const type = await this.printableType(n);
        this.emit({
          kind: "missing",
          stream: "stdout",
          text: `missing ${type} ${this.describe(id)}`,
          objectId: id,
          objectType: type,
        });
        this.errorsFound |= FSCK_ERROR_REACHABLE;
        continue;
      }
      if (!(flags & HAS_OBJ)) continue;
      if (this.showUnreachable) {
        const type = await this.printableType(n);
        this.emit({
          kind: "unreachable",
          stream: "stdout",
          text: `unreachable ${type} ${this.describe(id)}`,
          objectId: id,
          objectType: type,
        });
        continue;
      }
      if (!(flags & USED)) {
        const type = await this.printableType(n);
        if (this.o.dangling) {
          this.emit({
            kind: "dangling",
            stream: "stdout",
            text: `dangling ${type} ${this.describe(id)}`,
            objectId: id,
            objectType: type,
          });
        }
        if (this.o.lostFound) await this.writeLostFound(id, type);
      }
    }
  }

  /** `--lost-found`: a dangling object into `.git/lost-found/{commit,other}/<id>`. */
  private async writeLostFound(id: string, type: string): Promise<void> {
    const files = this.files;
    if (!files) return;
    const dir = pathOf(this.gitDir, "lost-found", type === "commit" ? "commit" : "other");
    await files.mkdir(dir);
    const path = pathOf(dir, id);
    if (type === "blob") {
      const obj = await this.readObject(id);
      if (obj) await files.write(path, obj.content);
    } else {
      await files.write(path, [new TextEncoder().encode(`${id}\n`)]);
    }
  }
}

async function readAll(files: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of files.read(path)) {
    parts.push(c);
    n += c.length;
  }
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function readText(files: FilesApi, path: string): Promise<string | undefined> {
  if ((await files.stats(path))?.kind !== "file") return undefined;
  return dec.decode(await readAll(files, path));
}

/** The entries of a reflog file, oldest first: old id, new id and the entry's timestamp. */
function parseReflog(text: string | undefined): Reflog["entries"] {
  const entries: Reflog["entries"] = [];
  for (const line of text?.split("\n") ?? []) {
    const oldId = line.slice(0, 40);
    const newId = line.slice(41, 81);
    if (!OID.test(oldId) || !OID.test(newId)) continue;
    const tab = line.indexOf("\t");
    const ident = tab < 0 ? line.slice(82) : line.slice(82, tab);
    const m = /> (\d+) [+-]\d{4}$/.exec(ident);
    entries.push({ oldId, newId, timestamp: m ? Number(m[1]) : 0 });
  }
  return entries;
}
