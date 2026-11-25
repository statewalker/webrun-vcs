import type { FilesApi, History, ObjectId } from "@statewalker/vcs-core";
import {
  MissingRootError,
  parseExpiryDate,
  ReflogExpiryConfigError,
  prune as storePrune,
} from "@statewalker/vcs-store-files";
import { RefNotFoundError } from "../../errors/index.js";
import { hostEnvironmentOf } from "../git-ident.js";
import { PlumbingCommand, PlumbingError } from "../plumbing-command.js";
import { objectsDirectoryDisplay } from "./objects-directory.js";

/**
 * `git prune [-n] [-v] [--expire <time>] [--] [<head>...]` (builtin/prune.c) over a files
 * repository, without the rest of gc: the unreachable loose objects older than `--expire`
 * (every one without it) go, except what a younger unreachable object reaches (gc's recent
 * walk); then the loose objects a pack holds (`prune-packed`), stale `tmp_*` files and the
 * shallow commits nothing reaches. `-n`/`-v` print `<id> <type>` per pruned object (and
 * `-n` `rm -f <path>` per packed loose object, `Removing <id> from .git/shallow`).
 *
 * Lines within one fan-out directory come in name order (git's come in readdir order).
 *
 * @example
 * ```typescript
 * // git prune -n --expire=2.weeks.ago
 * const { stdout } = await git.prune().setDryRun(true).setExpire("2.weeks.ago").callOutput();
 * ```
 */
export class PruneCommand extends PlumbingCommand {
  /** git's prune reads objects as stored (`disable_replace_refs`). */
  protected override readsReplacedObjects(): boolean {
    return false;
  }

  private dryRun = false;
  private verbose = false;
  private expire?: string;
  private readonly heads: string[] = [];

  /** `-n` (`--dry-run`): print what would go, remove nothing. */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /** `-v`: print each object removed. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  /**
   * `--expire <time>`: only objects older than this go (`never` keeps them all, `now` none).
   * `undefined` is `--no-expire` (as `never`).
   */
  setExpire(expire: string | undefined): this {
    this.checkCallable();
    this.expire = expire ?? "never";
    return this;
  }

  /** `<head>`: a revision whose objects are kept as reachable. */
  addHead(revision: string): this {
    this.checkCallable();
    this.heads.push(revision);
    return this;
  }

  protected async run(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    let expire = Number.POSITIVE_INFINITY;
    if (this.expire !== undefined) {
      try {
        expire = parseExpiryDate(this.expire, now, "--expire");
      } catch (e) {
        if (!(e instanceof ReflogExpiryConfigError)) throw e;
        // parse_expiry_date's death (parse_opt_expiry_date_cb)
        throw new PlumbingError(`fatal: malformed expiration date '${this.expire}'`);
      }
    }
    const history = this.workingCopy.history as History | undefined;
    const objects = await this.hooks.commonGitFile("objects");
    if (!history?.objects || !objects)
      throw new PlumbingError("fatal: prune needs a files repository");
    const files: FilesApi = objects.files;
    const gitDir = objects.path.replace(/\/?objects$/, "");
    const heads: ObjectId[] = [];
    for (const name of this.heads) {
      let id: ObjectId | undefined;
      try {
        id = await this.resolveRevision(name);
      } catch (e) {
        if (!(e instanceof RefNotFoundError)) throw e;
      }
      if (id === undefined) throw new PlumbingError(`fatal: unrecognized argument: ${name}`);
      if (!(await history.objects.has(id))) throw new PlumbingError(`fatal: unable to read ${id}`);
      heads.push(id);
    }
    const environment = hostEnvironmentOf(this.workingCopy);
    let result: Awaited<ReturnType<typeof storePrune>>;
    try {
      result = await storePrune({
        history,
        files,
        gitDir,
        expire,
        dryRun: this.dryRun,
        verbose: this.verbose,
        heads,
        objectsDisplay: await objectsDirectoryDisplay(this.hooks, this.workingCopy),
        compatibility: this.hooks.compatibility,
        ...(environment ? { environment } : {}),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "UnsupportedRepositoryFormatError")
        throw new PlumbingError("fatal: cannot prune in a precious-objects repo");
      // mark_reachable's add_one_ref: parse_object_or_die (a ref with a bad name or naming a
      // missing object, under GIT_REF_PARANOIA's default)
      if (e instanceof MissingRootError && e.refName !== undefined && e.refName !== "HEAD")
        throw new PlumbingError(`fatal: unable to parse object: ${e.refName}`);
      throw e;
    }
    for (const line of result.errorOutput.split("\n")) if (line) this.warn(line);
    await this.write(result.output);
    return 0;
  }
}
