import type { FilesApi, History } from "@statewalker/vcs-core";
import {
  FileRawStorage,
  parseExpiryDate,
  type RepackResult,
  repack as storeRepack,
} from "@statewalker/vcs-store-files";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";
import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { hostEnvironmentOf } from "./git-ident.js";

/** What `git repack` did. */
export interface RepackCommandResult {
  /** The store's repack (the new pack, the packs and loose objects removed), null when nothing was written. */
  repack: RepackResult | null;
  /** git's stdout: `Nothing new to pack.` when no pack was written (unless `--quiet`). */
  output: string[];
  /** git's warnings (`disabling bitmap writing, ...`), and the alternates' read errors. */
  warnings: string[];
}

/**
 * `git repack` (builtin/repack.c) over a files repository: the store's `repack` with git's
 * options and their defaults from the configuration (`repack.useDeltaIslands`,
 * `repack.updateServerInfo`, `repack.writeBitmaps`, `repack.packKeptObjects`, `pack.*`).
 *
 * Without `-a`/`-A`/`--cruft`/`--geometric` it packs the reachable loose objects into a new
 * pack (`-d` then removes those loose copies). The objects of a path whose `delta` attribute is
 * unset (`-delta` in `.gitattributes` or `info/attributes`) are never searched for a delta.
 *
 * @example
 * ```typescript
 * await git.repack().setAll(true).setDeleteRedundant(true).call(); // git repack -a -d
 * await git.repack().setGeometric(2).setDeleteRedundant(true).setWriteMidx(true).call();
 * ```
 */
export class RepackCommand extends GitCommand<RepackCommandResult> {
  /** git's repack reads the objects as stored, never through replace refs. */
  protected override readsReplacedObjects(): boolean {
    return false;
  }

  private _all = false;
  private _loosen = false;
  private _delete = false;
  private _cruft = false;
  private _cruftExpiration?: string;
  private _maxCruftSize?: number;
  private _local = false;
  private _keepUnreachable = false;
  private _unpackUnreachable?: string;
  private _reuseDeltas = true;
  private _reuseObjects = true;
  private _writeBitmaps?: boolean;
  private _writeMidx = false;
  private _geometric?: number;
  private _filter?: string;
  private _keepPacks: string[] = [];
  private _packKeptObjects?: boolean;
  private _updateServerInfo?: boolean;
  private _window?: number;
  private _depth?: number;
  private _deltaIslands?: boolean;
  private _quiet = false;

  /** `-a`: everything reachable into one pack (with `-d`, the other packs go). */
  setAll(all: boolean): this {
    this.checkCallable();
    this._all = all;
    return this;
  }

  /**
   * `-A`: as `-a`, and with `-d` the unreachable objects of the removed packs are written
   * loose (all of them, or those younger than `setUnpackUnreachable`'s date).
   */
  setLoosenUnreachable(loosen: boolean): this {
    this.checkCallable();
    this._loosen = loosen;
    return this;
  }

  /** `-d`: remove the packs the new one makes redundant, then the loose objects packed. */
  setDeleteRedundant(deleteRedundant: boolean): this {
    this.checkCallable();
    this._delete = deleteRedundant;
    return this;
  }

  /** `--cruft`: unreachable objects into a cruft pack (needs `-d` here). */
  setCruft(cruft: boolean): this {
    this.checkCallable();
    this._cruft = cruft;
    return this;
  }

  /** `--cruft-expiration=<approxidate>`: cruft objects older than this are dropped. */
  setCruftExpiration(expiration: string): this {
    this.checkCallable();
    this._cruftExpiration = expiration;
    return this;
  }

  /** `--max-cruft-size=<bytes>`. */
  setMaxCruftSize(bytes: number): this {
    this.checkCallable();
    this._maxCruftSize = bytes;
    return this;
  }

  /** `-l`: leave out what alternates hold. */
  setLocal(local: boolean): this {
    this.checkCallable();
    this._local = local;
    return this;
  }

  /**
   * `-k` (`--keep-unreachable`): with `-a -d`, the unreachable objects of the replaced packs
   * and the loose ones go into the new pack instead of being dropped.
   */
  setKeepUnreachable(keep: boolean): this {
    this.checkCallable();
    this._keepUnreachable = keep;
    return this;
  }

  /** `--unpack-unreachable=<approxidate>`: with `-A`, only objects newer than this are loosened. */
  setUnpackUnreachable(when: string): this {
    this.checkCallable();
    this._unpackUnreachable = when;
    return this;
  }

  /** `-f` (false): search every delta again instead of copying stored ones. */
  setReuseDeltas(reuse: boolean): this {
    this.checkCallable();
    this._reuseDeltas = reuse;
    return this;
  }

  /** `-F` (false): recompress every object (no stored entry copied). */
  setReuseObjects(reuse: boolean): this {
    this.checkCallable();
    this._reuseObjects = reuse;
    return this;
  }

  /** `-b`/`--no-write-bitmap-index` (default `repack.writeBitmaps`, bare repositories with `-a`). */
  setWriteBitmaps(write: boolean): this {
    this.checkCallable();
    this._writeBitmaps = write;
    return this;
  }

  /** `-m` (`--write-midx`): a multi-pack-index over the packs that stay. */
  setWriteMidx(write: boolean): this {
    this.checkCallable();
    this._writeMidx = write;
    return this;
  }

  /** `--geometric=<factor>` (`-g`): roll small packs up into a geometric progression. */
  setGeometric(factor: number): this {
    this.checkCallable();
    this._geometric = factor;
    return this;
  }

  /** `--filter=<spec>` (with `-a`): filtered-out objects go into a pack of their own. */
  setFilter(spec: string): this {
    this.checkCallable();
    this._filter = spec;
    return this;
  }

  /** `--keep-pack=<name>`: packs treated as kept (repeatable). */
  addKeepPack(name: string): this {
    this.checkCallable();
    this._keepPacks.push(name);
    return this;
  }

  /** `--pack-kept-objects`: with `-a`, pack the objects of `.keep` packs too. */
  setPackKeptObjects(pack: boolean): this {
    this.checkCallable();
    this._packKeptObjects = pack;
    return this;
  }

  /** `-n` (false): do not run `update-server-info` (default `repack.updateServerInfo`, true). */
  setUpdateServerInfo(update: boolean): this {
    this.checkCallable();
    this._updateServerInfo = update;
    return this;
  }

  /** `--window=<n>`. */
  setWindow(window: number): this {
    this.checkCallable();
    this._window = window;
    return this;
  }

  /** `--depth=<n>`. */
  setDepth(depth: number): this {
    this.checkCallable();
    this._depth = depth;
    return this;
  }

  /** `-i` (`--delta-islands`, default `repack.useDeltaIslands`): `pack.island` restricts deltas. */
  setDeltaIslands(islands: boolean): this {
    this.checkCallable();
    this._deltaIslands = islands;
    return this;
  }

  /** `-q`: no `Nothing new to pack.` line. */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this._quiet = quiet;
    return this;
  }

  /** The repository's files backend: its FilesApi, common git directory and history. */
  private async filesRepository(): Promise<
    { files: FilesApi; gitDir: string; history: History } | undefined
  > {
    const history = this.workingCopy.history as History | undefined;
    if (!history?.objects || !history.packs) return undefined;
    const objects = await this.hooks.commonGitFile("objects");
    if (!objects) return undefined;
    return { files: objects.files, gitDir: objects.path.replace(/\/?objects$/, ""), history };
  }

  /** A boolean of the configuration, `fallback` when unset. */
  private configBool(key: string, fallback: boolean): boolean {
    const value = RemoteConfigStore.from(this.workingCopy).value(key);
    return value === undefined ? fallback : (parseGitBool(value) ?? fallback);
  }

  /** The `delta` attribute's check (git's `no_try_delta`), when the repository has a worktree. */
  private noDeltaCheck(): ((path: string) => Promise<boolean>) | undefined {
    const worktree = "worktree" in this.workingCopy ? this.worktreeAccess : undefined;
    const filter = worktree?.contentFilter as
      | {
          attributes?: (
            path: string,
            names?: readonly string[],
            direction?: "checkin",
          ) => Promise<Map<string, true | false | string | undefined>>;
        }
      | undefined;
    const attributes = filter?.attributes?.bind(filter);
    if (!attributes) return undefined;
    return async (path) => (await attributes(path, ["delta"], "checkin")).get("delta") === false;
  }

  /**
   * Run the repack.
   *
   * @throws GitApiError for git's refusals (`--geometric` with `-a`, `-k` with `-A`, `--cruft`)
   */
  async call(): Promise<RepackCommandResult> {
    this.checkCallable();
    this.setCallable(false);
    // die_for_incompatible_opt3: --unpack-unreachable counts as -A there
    const loosenAsked = this._loosen || this._unpackUnreachable !== undefined;
    const incompatible = [
      ...(loosenAsked ? ["-A"] : []),
      ...(this._keepUnreachable ? ["-k/--keep-unreachable"] : []),
      ...(this._cruft ? ["--cruft"] : []),
    ];
    // 2.43 checks the pairs one by one, in its own words
    if (this.hooks.compatibility === "2.43") {
      const pair = (x: string, y: string) =>
        new GitApiError(`fatal: options '${x}' and '${y}' cannot be used together`);
      if (this._keepUnreachable && loosenAsked) throw pair("--keep-unreachable", "-A");
      if (this._cruft && loosenAsked) throw pair("--cruft", "-A");
      if (this._cruft && this._keepUnreachable) throw pair("--cruft", "-k");
    }
    if (incompatible.length === 3)
      throw new GitApiError(
        "fatal: options '-A', '-k/--keep-unreachable', and '--cruft' cannot be used together",
      );
    if (incompatible.length === 2)
      throw new GitApiError(
        `fatal: options '${incompatible[0]}' and '${incompatible[1]}' cannot be used together`,
      );
    const all = this._all || this._loosen || this._cruft;
    // git's split_factor 0 is no geometric repack
    const geometric = this._geometric ? this._geometric : undefined;
    if (geometric !== undefined && all)
      throw new GitApiError("fatal: options '--geometric' and '-A/-a' cannot be used together");
    if (this._filter !== undefined && !all)
      throw new GitApiError("repack --filter without -a is not supported");
    if (this._cruft && !this._delete)
      throw new GitApiError("repack --cruft without -d is not supported");

    const repository = await this.filesRepository();
    if (!repository) throw new GitApiError("repack needs a files repository");
    const { files, gitDir, history } = repository;
    const environment = hostEnvironmentOf(this.workingCopy);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const deltaSearch =
      this._window !== undefined || this._depth !== undefined
        ? {
            ...(this._window !== undefined ? { window: this._window } : {}),
            ...(this._depth !== undefined ? { depth: this._depth } : {}),
          }
        : undefined;
    const noDelta = this.noDeltaCheck();
    const unpackExpireMs = (() => {
      if (this._unpackUnreachable === undefined) return Number.POSITIVE_INFINITY;
      const cutoff = parseExpiryDate(this._unpackUnreachable, nowSeconds, "--unpack-unreachable");
      if (cutoff === 0) return Number.POSITIVE_INFINITY;
      return Math.max(0, Date.now() - cutoff * 1000);
    })();
    const cruftExpiration =
      this._cruftExpiration === undefined
        ? undefined
        : parseExpiryDate(this._cruftExpiration, nowSeconds, "--cruft-expiration");

    const worktree = "worktree" in this.workingCopy ? this.worktreeAccess : undefined;
    // one worktree batch: the attribute files the delta attribute reads are read once
    const run = () =>
      storeRepack({
        history,
        objects: history.objects as NonNullable<History["objects"]>,
        packs: history.packs as NonNullable<History["packs"]>,
        looseStorage: new FileRawStorage(files, `${gitDir}/objects`),
        files,
        gitDir,
        ...(environment ? { environment } : {}),
        compatibility: this.hooks.compatibility,
        all,
        deleteRedundant: this._delete,
        local: this._local,
        reuseDeltas: this._reuseDeltas,
        reuseObjects: this._reuseObjects,
        ...(deltaSearch ? { deltaSearch } : {}),
        // inside an all-into-one repack with -d, --unpack-unreachable=<date> loosens as -A does
        ...(this._loosen || (all && this._unpackUnreachable !== undefined)
          ? { unpackUnreachable: true, unpackUnreachableExpireMs: unpackExpireMs }
          : {}),
        ...(this._keepUnreachable ? { keepUnreachable: true } : {}),
        ...(this._cruft
          ? {
              cruft: true,
              ...(cruftExpiration !== undefined && cruftExpiration > 0 ? { cruftExpiration } : {}),
              ...(this._maxCruftSize !== undefined ? { maxCruftSize: this._maxCruftSize } : {}),
            }
          : {}),
        ...(this._writeBitmaps !== undefined ? { writeBitmaps: this._writeBitmaps } : {}),
        ...(this._writeMidx ? { writeMidx: true } : {}),
        ...(geometric !== undefined ? { geometric } : {}),
        ...(this._filter !== undefined ? { filter: this._filter } : {}),
        ...(this._keepPacks.length ? { keepPacks: this._keepPacks } : {}),
        ...(this._packKeptObjects !== undefined ? { packKeptObjects: this._packKeptObjects } : {}),
        updateServerInfo:
          this._updateServerInfo ?? this.configBool("repack.updateServerInfo", true),
        deltaIslands: this._deltaIslands ?? this.configBool("repack.useDeltaIslands", false),
        ...(noDelta ? { noDelta } : {}),
      });
    const result = noDelta && worktree?.batch ? await worktree.batch(run) : await run();
    const output: string[] = [];
    if (!result && !this._quiet) output.push("Nothing new to pack.");
    return {
      repack: result,
      output,
      warnings: [
        ...this.alternatesErrors(),
        ...(result?.warnings ?? []),
        ...(result?.errors ?? []).filter((l) => !this.alternatesErrors().includes(l)),
      ],
    };
  }
}
