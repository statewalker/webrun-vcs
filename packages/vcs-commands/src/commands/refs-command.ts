/**
 * `git refs` (builtin/refs.c, git 2.46+): `migrate`, `verify` and `exists` here; `list` is
 * `git for-each-ref` (`Git.refsList`, a `ForEachRefCommand`) and `optimize` is `git pack-refs`
 * (`Git.refsOptimize`, a `PackRefsCommand`), as git's subcommands call the same code.
 */

import type { FilesApi } from "@statewalker/vcs-core";
import {
  migrateRefStorage,
  RefMigrationError,
  type RefStorageFormat,
  type RefsVerifyWorktree,
  readReftableWriteOptions,
  readRepositoryFormat,
  verifyRefStorage,
} from "@statewalker/vcs-store-files";
import { RemoteConfigStore } from "../remote-config/index.js";
import { FsckMessageTypes, parseFsckMsgId, UnknownFsckMsgIdError } from "./fsck/fsck-msg-ids.js";
import { configValue } from "./merge-config.js";
import { PlumbingCommand, PlumbingError } from "./plumbing-command.js";
import { ShowRefCommand } from "./show-ref-command.js";

/** The repository's common git directory and the FilesApi it is in. */
async function commonGitDirOf(
  command: { commonGitFile(name: string): Promise<{ files: FilesApi; path: string } | undefined> },
  what: string,
): Promise<{ files: FilesApi; gitDir: string }> {
  const config = await command.commonGitFile("config");
  if (!config) throw new PlumbingError(`fatal: ${what} needs a repository on files`);
  const gitDir = config.path.replace(/\/?config$/, "");
  return { files: config.files, gitDir };
}

/** A path in the git directory as git prints it (relative to the FilesApi's root). */
const shown = (path: string) => path.replace(/^\/+/, "");

/** The migration directory as git prints it: below the git directory (`.` when bare). */
const shownIn = (gitDir: string, path: string) =>
  `${shown(gitDir) || "."}/${path.slice(path.lastIndexOf("/") + 1)}`;

/**
 * `git refs migrate --ref-format=<format> [--dry-run] [--no-reflog]`: the refs and reflogs
 * copied into the other ref storage (vcs-store-files `migrateRefStorage`: the new storage is
 * written beside the old one in `<git dir>/ref_migration.XXXXXX`, then swapped in; a dry run
 * leaves it there and says where). git's messages and exit statuses: `usage: missing
 * --ref-format=<format>` (129), `error: unknown ref storage format '<f>'`, `error: repository
 * already uses '<f>' format`, `error: migrating repositories with worktrees is not supported
 * yet` (255).
 *
 * The working copy this command ran on keeps the ref store of the old format: open the
 * repository again after a migration.
 *
 * @example
 * ```typescript
 * const { exitCode, stderr } = await git.refsMigrate().setRefFormat("reftable").call();
 * ```
 */
export class RefsMigrateCommand extends PlumbingCommand {
  private format?: string;
  private dryRun = false;
  private noReflog = false;
  private suffix?: () => string;

  /** `--ref-format=<format>`: `files` or `reftable` */
  setRefFormat(format: string): this {
    this.checkCallable();
    this.format = format;
    return this;
  }

  /** `--dry-run`: write the migrated refs into the migration directory only */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /** `--no-reflog`: drop the reflogs */
  setNoReflog(noReflog: boolean): this {
    this.checkCallable();
    this.noReflog = noReflog;
    return this;
  }

  /** The migration directory's suffix (mkdtemp's `XXXXXX`; random by default) */
  setDirectorySuffix(suffix: () => string): this {
    this.checkCallable();
    this.suffix = suffix;
    return this;
  }

  protected async run(): Promise<number> {
    if (this.format === undefined) {
      throw new PlumbingError("usage: missing --ref-format=<format>", 129);
    }
    if (this.format !== "files" && this.format !== "reftable") {
      this.warn(`error: unknown ref storage format '${this.format}'`);
      return 255;
    }
    const format: RefStorageFormat = this.format;
    const { files, gitDir } = await commonGitDirOf(this.hooks, "refs migrate");
    if ((await readRepositoryFormat(files, gitDir)).refStorage === format) {
      this.warn(`error: repository already uses '${format}' format`);
      return 255;
    }
    const config = { get: (key: string) => configValue(this.workingCopy, key) };
    let migrationDir: string;
    try {
      const result = await migrateRefStorage({
        files,
        gitDir,
        to: format,
        dryRun: this.dryRun,
        skipReflog: this.noReflog,
        reftable: readReftableWriteOptions(config),
        ...(this.suffix ? { suffix: this.suffix } : {}),
      });
      migrationDir = result.migrationDir;
      for (const warning of result.warnings) this.warn(`warning: ${warning}`);
    } catch (error) {
      if (!(error instanceof RefMigrationError)) throw error;
      this.warn(`error: ${error.message}`);
      return 255;
    }
    if (this.dryRun) {
      await this.write(
        `Finished dry-run migration of refs, the result can be found at '${shownIn(gitDir, migrationDir)}'\n`,
      );
    }
    return 0;
  }
}

/**
 * `git refs verify [--strict] [--verbose]` (git 2.47+): the ref database's consistency, for
 * the main worktree and each linked one (vcs-store-files `verifyRefStorage`: loose refs by
 * name and content, root refs, packed-refs, or each reftable's name and refs). Findings go
 * to stderr as `error: <path>: <msg-id>: <message>` or `warning: ...` by their severity
 * (`fsck.<msg-id>`, `--strict`); the exit status is 255 when an error was reported.
 *
 * @example
 * ```typescript
 * const { exitCode, stderr } = await git.refsVerify().setStrict(true).call();
 * ```
 */
export class RefsVerifyCommand extends PlumbingCommand {
  private strict = false;
  private verbose = false;

  /** `--strict`: warnings count as errors */
  setStrict(strict: boolean): this {
    this.checkCallable();
    this.strict = strict;
    return this;
  }

  /** `--verbose`: git's `Checking ...` lines */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  protected async run(): Promise<number> {
    const { files, gitDir } = await commonGitDirOf(this.hooks, "refs verify");
    // git_fsck_config: fsck.<msg-id>=<type> (an unknown id or type is git's death)
    const types = new FsckMessageTypes({ strict: this.strict });
    for (const [key, value] of this.fsckConfig()) {
      const name = key.slice("fsck.".length);
      if (name.toLowerCase() === "skiplist") continue;
      try {
        types.set(name, value);
      } catch (error) {
        if (!(error instanceof UnknownFsckMsgIdError)) throw error;
        throw new PlumbingError(`fatal: ${error.message}`);
      }
    }
    const format = await readRepositoryFormat(files, gitDir);
    const worktrees: RefsVerifyWorktree[] = [{}];
    for (const id of await linkedWorktreeIds(files, gitDir)) worktrees.push({ id });
    const failed = await verifyRefStorage({
      files,
      gitDir,
      displayGitDir: shown(gitDir) || ".",
      refStorage: format.refStorage,
      objectFormat: format.objectFormat,
      worktrees,
      report: (r) => {
        const id = parseFsckMsgId(r.msgId);
        const severity = id ? types.severity(id) : "error";
        if (severity === "ignore") return false;
        const line = `${r.path}: ${r.msgId}: ${r.message}`;
        if (severity === "warning") {
          this.warn(`warning: ${line}`);
          return false;
        }
        this.warn(`error: ${line}`);
        return true;
      },
      ...(this.verbose ? { verbose: (line: string) => this.warn(line) } : {}),
      error: (line) => this.warn(line),
    });
    return failed ? 255 : 0;
  }

  /** The `fsck.*` settings in config order (git_fsck_config), keys as git spells them. */
  private fsckConfig(): [string, string][] {
    const entries = RemoteConfigStore.from(this.workingCopy).entriesWithPrefix("fsck.") ?? [];
    return entries.flatMap((e) => (e.value === undefined ? [] : [[e.key, e.value]]));
  }
}

/** git's get_worktrees_without_reading_head: the linked worktrees whose `gitdir` file reads. */
async function linkedWorktreeIds(files: FilesApi, gitDir: string): Promise<string[]> {
  const dir = `${gitDir}/worktrees`;
  if ((await files.stats(dir))?.kind !== "directory") return [];
  const ids: string[] = [];
  for await (const entry of files.list(dir)) {
    if ((await files.stats(`${dir}/${entry.name}/gitdir`))?.kind === "file") ids.push(entry.name);
  }
  return ids.sort();
}

/**
 * `git refs exists <ref>` (git 2.52+): whether the ref exists, a symbolic one not followed
 * (`show-ref --exists`): exit 0, 2 with `error: reference does not exist`, 1 when it cannot be
 * read (`error: failed to look up reference: ...`).
 *
 * @example
 * ```typescript
 * const { exitCode } = await git.refsExists().setRef("refs/heads/main").call();
 * ```
 */
export class RefsExistsCommand extends PlumbingCommand {
  private refs: string[] = [];

  /** The ref to look up (git takes exactly one) */
  setRef(ref: string): this {
    this.checkCallable();
    this.refs = [ref];
    return this;
  }

  /** Adds an argument (more than one is git's death) */
  addArgument(arg: string): this {
    this.checkCallable();
    this.refs.push(arg);
    return this;
  }

  protected async run(): Promise<number> {
    if (this.refs.length !== 1) {
      throw new PlumbingError("fatal: 'git refs exists' requires a reference");
    }
    const show = new ShowRefCommand(this.workingCopy)
      .setCompatibility("2.56")
      .setExists(true)
      .addPattern(this.refs[0] as string);
    const result = await show.call();
    for (const line of result.stderr.split("\n")) if (line) this.warn(line);
    return result.exitCode;
  }
}
