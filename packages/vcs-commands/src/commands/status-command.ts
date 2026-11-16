import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import {
  compareWithWorktree,
  findUntrackedFiles,
  getStageState,
  type IndexStatUpdate,
  modeFromWorktree,
  refreshIndexStats,
  type StageStateValue,
  statUpdateOf,
  trackedUnder,
  type WorkingCopy,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import {
  DEFAULT_RENAME_LIMIT,
  detectRenames,
  type RenameCandidate,
  scorePercent,
} from "../rename/index.js";
import {
  type Status,
  type StatusCode,
  type StatusFileEntry,
  StatusImpl,
  type StatusSide,
  submoduleToken,
} from "../results/status-result.js";
import { worktreeModeTrust } from "./core-config.js";
import {
  type GitmodulesEntry,
  isSubmoduleIgnoreMode,
  parseGitmodules,
  type SubmoduleIgnoreFlags,
  type SubmoduleIgnoreMode,
  submoduleIgnoreFlags,
} from "./submodule-config.js";

export type { SubmoduleIgnoreMode } from "./submodule-config.js";

/** The porcelain `XY` of an unmerged path, by which of stages 1-3 it has. */
const UNMERGED_CODES: Record<number, [StatusCode, StatusCode]> = {
  1: ["D", "D"],
  2: ["A", "U"],
  3: ["U", "D"],
  4: ["U", "A"],
  5: ["D", "U"],
  6: ["A", "A"],
  7: ["U", "U"],
};

const S_IFMT = 0o170000;
const typeOf = (mode: number) => mode & S_IFMT;
const isGitlink = (mode: number | undefined) => mode === FileMode.GITLINK;

/** A git boolean, `copies`/`copy` (rename detection on) or undefined when not one. */
function renamesValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "copies" || v === "copy") return true;
  if (["true", "yes", "on"].includes(v)) return true;
  if (["false", "no", "off"].includes(v)) return false;
  const n = Number(v);
  return Number.isInteger(n) ? n !== 0 : undefined;
}

/** A git integer (`1000`, `2k`), or undefined when not one. */
function intValue(value: string | undefined): number | undefined {
  const m = value?.trim().match(/^(-?\d+)([kmg]?)$/i);
  if (!m) return undefined;
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()] ?? 1;
  return Number(m[1]) * unit;
}

async function concat(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    size += chunk.length;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** What a submodule's own worktree holds (git's `DIRTY_SUBMODULE_*`). */
interface SubmoduleDirt {
  modified?: boolean;
  untracked?: boolean;
}

/**
 * Shows the working tree status, as `git status`: the index against HEAD (staged changes),
 * the worktree against the index (unstaged changes: modified, deleted, type changed),
 * unmerged entries, untracked files and, on request, ignored ones.
 *
 * Worktree files are compared with the index through the stat it recorded: a file whose
 * size and modification time still match is not read, unless its entry is racily clean
 * (modified at or after the index was written), which is re-hashed as git does. Links are
 * compared as links (mode 120000), the executable bit only where `core.filemode` trusts it,
 * and the ignore rules are read afresh for each status. Untracked files are listed one by
 * one (`--untracked-files=all`).
 *
 * Renames are detected as git's default `status.renames=true` does: a path deleted from the
 * index paired with one added to it (`R  old -> new`), and a path deleted from the worktree
 * paired with an intent-to-add file (` R old -> new`); untracked files are never paired.
 * `status.renames` (else `diff.renames`), `status.renameLimit` (else `diff.renameLimit`) and
 * {@link setRenames} control it.
 *
 * A populated submodule's own state is read as git does: a commit other than the index's
 * (`SC..`), tracked changes inside it (`S.M.`) and untracked files inside it (`S..U`) all
 * show as ` M sub`; `diff.ignoreSubmodules`, `submodule.<name>.ignore` (config, then
 * `.gitmodules`) and {@link setIgnoreSubmodules} limit what is looked at.
 *
 * Without a worktree only the index is compared with HEAD.
 *
 * Based on JGit's StatusCommand.
 *
 * @example
 * ```typescript
 * const status = await git.status().call();
 * if (status.isClean()) console.log("nothing to commit, working tree clean");
 * console.log("Staged:", status.added, status.changed, status.removed, status.renamed);
 * console.log("Unstaged:", status.modified, status.missing);
 * console.log("Untracked:", status.untracked);
 * // the lines of `git status --porcelain`
 * console.log(formatStatusPorcelain(status));
 * ```
 */
export class StatusCommand extends GitCommand<Status> {
  private paths: string[] = [];
  private showIgnored = false;
  private showUntracked = true;
  private renames?: boolean;
  private renameLimit?: number;
  private ignoreSubmodules?: SubmoduleIgnoreMode;
  private gitmodules?: Promise<GitmodulesEntry[]>;

  /**
   * Add a path filter.
   *
   * Only status for paths starting with this prefix will be returned.
   *
   * @param path Path prefix to filter by
   */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /**
   * Whether to report the ignored files the index does not track (`--ignored`). Off by
   * default.
   */
  setIgnored(ignored: boolean): this {
    this.checkCallable();
    this.showIgnored = ignored;
    return this;
  }

  /**
   * Whether to report untracked files (`--untracked-files=all`, the default, or `=no`).
   * Without them, untracked files inside submodules are not looked for either.
   */
  setUntracked(untracked: boolean): this {
    this.checkCallable();
    this.showUntracked = untracked;
    return this;
  }

  /**
   * Whether to detect renames (`--renames` / `--no-renames`). Unset, `status.renames`
   * decides, else `diff.renames`, else on (git's default).
   */
  setRenames(renames: boolean): this {
    this.checkCallable();
    this.renames = renames;
    return this;
  }

  /**
   * The rename limit: inexact renames are looked for only while the unpaired deleted
   * times added paths stay within its square. Unset, `status.renameLimit` decides, else
   * `diff.renameLimit`, else 1000; 0 is no limit.
   */
  setRenameLimit(limit: number): this {
    this.checkCallable();
    this.renameLimit = limit;
    return this;
  }

  /**
   * `--ignore-submodules=<when>`: overrides `diff.ignoreSubmodules` and every
   * `submodule.<name>.ignore`. `all` hides submodule changes (staged ones too), `dirty`
   * only reports a submodule at another commit, `untracked` ignores untracked files inside
   * submodules, `none` reports everything.
   */
  setIgnoreSubmodules(mode: SubmoduleIgnoreMode): this {
    this.checkCallable();
    this.ignoreSubmodules = mode;
    return this;
  }

  async call(): Promise<Status> {
    this.checkCallable();
    this.setCallable(false);
    const worktree = this.worktreeAccess;
    // one operation: fresh ignore rules and one lstat cache for the whole status
    return worktree?.batch ? worktree.batch(() => this.compute(worktree)) : this.compute(worktree);
  }

  private get config(): RemoteConfigStore {
    return RemoteConfigStore.from(this.workingCopy);
  }

  private async compute(worktree: Worktree | undefined): Promise<Status> {
    const head = new Map<string, StatusSide>();
    const headRef = await this.refsStore.resolve("HEAD");
    if (headRef?.objectId) {
      const headCommit = await this.commits.load(headRef.objectId).catch(() => undefined);
      if (headCommit) await this.collectTreeEntries(headCommit.tree, "", head);
    }

    const added = new Set<string>();
    const changed = new Set<string>();
    const removed = new Set<string>();
    const conflicting = new Set<string>();
    const conflictingStageState = new Map<string, StageStateValue>();
    const modified = new Set<string>();
    const missing = new Set<string>();
    const untracked = new Set<string>();
    const ignored = new Set<string>();
    const files: StatusFileEntry[] = [];

    const trust = worktree ? worktreeModeTrust(this.workingCopy, worktree) : undefined;
    const indexTime = this.staging.getUpdateTime();
    const tracked = new Set<string>();
    const gitlinks = new Set<string>();
    const refresh: IndexStatUpdate[] = [];
    const unmerged = new Map<string, [StatusSide?, StatusSide?, StatusSide?]>();

    for await (const entry of this.staging.entries()) {
      tracked.add(entry.path);
      if (entry.mode === FileMode.GITLINK) gitlinks.add(entry.path);
      if (!this.matchesPath(entry.path)) continue;
      if (entry.stage !== 0) {
        const stages = unmerged.get(entry.path) ?? [undefined, undefined, undefined];
        stages[entry.stage - 1] = { mode: entry.mode, id: entry.objectId };
        unmerged.set(entry.path, stages);
        continue;
      }
      const h = head.get(entry.path);
      const staged = { mode: entry.mode, id: entry.objectId };
      let x: StatusCode = " ";
      if (!h) {
        // an added submodule a `submodule.<name>.ignore=all` hides (git's diff_addremove)
        const hidden = isGitlink(entry.mode) && (await this.indexIgnoresAll(entry.path));
        if (!entry.intentToAdd && !hidden) {
          x = "A";
          added.add(entry.path);
        }
      } else if (h.id !== entry.objectId || h.mode !== entry.mode) {
        const hidden =
          isGitlink(h.mode) && isGitlink(entry.mode) && (await this.indexIgnoresAll(entry.path));
        if (!hidden) {
          x = typeOf(h.mode) === typeOf(entry.mode) ? "M" : "T";
          changed.add(entry.path);
        }
      }
      let y: StatusCode = " ";
      let worktreeMode: number | undefined = entry.mode;
      let commitChanged = false;
      let dirt: SubmoduleDirt = {};
      if (worktree && !entry.skipWorktree && !entry.assumeValid) {
        const flags = isGitlink(entry.mode) ? await this.worktreeFlags(entry.path) : undefined;
        if (!flags?.all) {
          const result = await compareWithWorktree(worktree, entry, { trust, indexTime });
          worktreeMode = result.worktreeMode;
          // proved clean only by hashing: its fresh stat goes into the index (git's refresh);
          // changed behind a matching stat: smudged
          const update = statUpdateOf(entry, result);
          if (update) refresh.push(update);
          if (flags && result.kind === "modified") commitChanged = true;
          // a populated submodule's own index and worktree (git's is_submodule_modified)
          if (flags && !flags.dirty && result.worktreeEntry?.isDirectory) {
            dirt = await this.submoduleDirt(worktree, entry.path, flags.untracked);
          }
          if (result.kind === "deleted") {
            y = "D";
            missing.add(entry.path);
          } else if (result.kind || dirt.modified || dirt.untracked) {
            y = result.kind === "typechange" ? "T" : "M";
            modified.add(entry.path);
          } else if (entry.intentToAdd) {
            y = "A";
            added.add(entry.path);
          }
        }
      }
      if (x !== " " || y !== " ") {
        // git's v2 line of an intent-to-add entry: no index side while the file is there
        // (".A"), and the placeholder as the HEAD side once it is gone (".D")
        const ita = entry.intentToAdd;
        files.push({
          path: entry.path,
          index: x,
          worktree: y,
          head: ita && y === "D" ? staged : h,
          staged: ita && y === "A" ? undefined : staged,
          worktreeMode,
          ...(commitChanged ? { submoduleCommitChanged: true } : {}),
          ...(dirt.modified ? { submoduleModified: true } : {}),
          ...(dirt.untracked ? { submoduleUntracked: true } : {}),
          ...(ita ? { intentToAdd: true } : {}),
        });
      }
    }

    for (const [path, stages] of unmerged) {
      conflicting.add(path);
      const [base, ours, theirs] = stages;
      conflictingStageState.set(path, getStageState(!!base, !!ours, !!theirs));
      const mask = (base ? 1 : 0) | (ours ? 2 : 0) | (theirs ? 4 : 0);
      const [x, y] = UNMERGED_CODES[mask];
      let worktreeMode: number | undefined;
      const current = worktree ? await worktree.getEntry(path) : undefined;
      if (current && !current.isDirectory && trust) {
        worktreeMode = modeFromWorktree(current.mode, (ours ?? theirs ?? base)?.mode, trust);
      }
      files.push({ path, index: x, worktree: y, worktreeMode, stages: [base, ours, theirs] });
    }

    for (const [path, h] of head) {
      if (tracked.has(path) || !this.matchesPath(path)) continue;
      if (isGitlink(h.mode) && (await this.indexIgnoresAll(path))) continue;
      removed.add(path);
      files.push({ path, index: "D", worktree: " ", head: h });
    }

    const renamed = new Map<string, string>();
    const warnings: string[] = [];
    if (this.detectsRenames()) await this.pairRenames(files, renamed, worktree, warnings);

    if (worktree && this.showUntracked) {
      for await (const file of findUntrackedFiles(worktree, (p) => tracked.has(p), {
        hasTrackedUnder: trackedUnder(tracked),
        isGitlink: (p) => gitlinks.has(p),
        includeIgnored: this.showIgnored,
        filter: (p) => this.matchesPath(p),
      })) {
        if (file.ignored) {
          ignored.add(file.path);
          files.push({ path: file.path, index: "!", worktree: "!" });
        } else {
          untracked.add(file.path);
          files.push({ path: file.path, index: "?", worktree: "?" });
        }
      }
    }

    // as git status: the refreshed stats written back when the index is free and unchanged
    await refreshIndexStats(this.staging, refresh);

    return new StatusImpl(added, changed, removed, conflicting, {
      modified,
      missing,
      untracked,
      ignored,
      conflictingStageState,
      files,
      renamed,
      warnings,
    });
  }

  /** Whether renames are detected: the setter, else `status.renames`, else `diff.renames`. */
  private detectsRenames(): boolean {
    if (this.renames !== undefined) return this.renames;
    return (
      renamesValue(this.config.value("status.renames")) ??
      renamesValue(this.config.value("diff.renames")) ??
      true
    );
  }

  /**
   * Pairs renames as git status does: on the index side (`diff-index --cached`) a path
   * removed from the index with one added to it; on the worktree side (`diff-files`) a
   * path deleted from the worktree with an intent-to-add file. The source's line goes (or
   * keeps only its other side); the destination's line becomes the rename.
   */
  private async pairRenames(
    files: StatusFileEntry[],
    renamed: Map<string, string>,
    worktree: Worktree | undefined,
    warnings: string[],
  ): Promise<void> {
    const limit =
      this.renameLimit ??
      intValue(this.config.value("status.renameLimit")) ??
      intValue(this.config.value("diff.renameLimit")) ??
      DEFAULT_RENAME_LIMIT;
    const byPath = new Map(files.map((f) => [f.path, f]));
    const blob = async (id: ObjectId) => concat((await this.blobs.load(id)) ?? []);
    const blobSize = async (id: ObjectId) => {
      try {
        return await this.blobs.size(id);
      } catch {
        return undefined;
      }
    };
    // git's diff warning when inexact renames were skipped (git status itself prints none)
    let needed = 0;
    const onRenameLimit = (n: number) => {
      needed = Math.max(needed, n);
    };
    const drop = new Set<StatusFileEntry>();

    // index side: HEAD's deletions against the index's additions
    const indexSources: RenameCandidate[] = [];
    const indexDestinations: RenameCandidate[] = [];
    for (const f of files) {
      if (f.stages) continue;
      if (f.index === "D" && f.head) indexSources.push({ path: f.path, ...side(f.head) });
      else if (f.index === "A" && f.staged) {
        indexDestinations.push({ path: f.path, ...side(f.staged) });
      }
    }
    if (indexSources.length > 0 && indexDestinations.length > 0) {
      const pairs = await detectRenames(indexSources, indexDestinations, {
        renameLimit: limit,
        onRenameLimit,
        size: (c) => blobSize(c.id),
        load: (c) => blob(c.id),
      });
      for (const pair of pairs) {
        const from = byPath.get(pair.from);
        const to = byPath.get(pair.to);
        if (!from || !to) continue;
        drop.add(from);
        to.index = "R";
        to.head = from.head;
        to.renamedFrom = pair.from;
        to.renameScore = scorePercent(pair.score);
        renamed.set(pair.to, pair.from);
      }
    }

    // worktree side: deletions from the worktree against intent-to-add files
    if (worktree) {
      const sources: RenameCandidate[] = [];
      const destinations: Array<[RenameCandidate, StatusFileEntry]> = [];
      for (const f of files) {
        if (f.stages || drop.has(f)) continue;
        if (f.worktree === "D" && f.staged) {
          sources.push({ path: f.path, ...side(f.intentToAdd ? (f.head ?? f.staged) : f.staged) });
        } else if (f.worktree === "A" && f.worktreeMode !== undefined) {
          destinations.push([{ path: f.path, mode: f.worktreeMode, id: "" }, f]);
        }
      }
      if (sources.length > 0 && destinations.length > 0) {
        for (const [candidate] of destinations) {
          candidate.id = await worktree.computeHash(candidate.path);
        }
        const pairs = await detectRenames(
          sources,
          destinations.map(([c]) => c),
          {
            renameLimit: limit,
            onRenameLimit,
            size: async (c, role) =>
              role === "source" ? blobSize(c.id) : (await worktree.getEntry(c.path))?.size,
            load: (c, role) =>
              role === "source" ? blob(c.id) : concat(worktree.readContent(c.path)),
          },
        );
        for (const pair of pairs) {
          const from = byPath.get(pair.from);
          const to = byPath.get(pair.to);
          if (!from?.staged || !to) continue;
          // the source keeps only its index side, if it has one
          if (from.index === " ") drop.add(from);
          else {
            from.worktree = " ";
            from.worktreeMode = from.staged.mode;
          }
          to.worktree = "R";
          to.head = from.staged;
          to.staged = from.staged;
          to.renamedFrom = pair.from;
          to.renameScore = scorePercent(pair.score);
          renamed.set(pair.to, pair.from);
        }
      }
    }

    if (drop.size > 0) {
      const kept = files.filter((f) => !drop.has(f));
      files.splice(0, files.length, ...kept);
    }
    if (needed > 0) {
      warnings.push(
        "warning: exhaustive rename detection was skipped due to too many files.",
        `warning: you may want to set your status.renameLimit variable to at least ${needed} and retry the command.`,
      );
    }
  }

  /** The submodules `.gitmodules` names: the worktree's file, else the index's. */
  private submodules(): Promise<GitmodulesEntry[]> {
    this.gitmodules ??= (async () => {
      const worktree = this.worktreeAccess;
      let bytes: Uint8Array | undefined;
      try {
        const entry = worktree ? await worktree.getEntry(".gitmodules") : undefined;
        if (worktree && entry && !entry.isDirectory && entry.mode !== FileMode.SYMLINK) {
          bytes = await concat(worktree.readContent(".gitmodules"));
        }
      } catch {
        bytes = undefined;
      }
      if (!bytes) {
        const staged = await this.staging.getEntry(".gitmodules");
        if (staged && staged.mode !== FileMode.SYMLINK) {
          bytes = await concat((await this.blobs.load(staged.objectId)) ?? []);
        }
      }
      return bytes ? parseGitmodules(new TextDecoder().decode(bytes)) : [];
    })();
    return this.gitmodules;
  }

  /**
   * `submodule.<name>.ignore` for the submodule at `path`: the repository's config, else
   * `.gitmodules`; undefined when neither names a valid value (or no submodule is there).
   */
  private async submoduleIgnore(path: string): Promise<SubmoduleIgnoreMode | undefined> {
    const submodule = (await this.submodules()).find((s) => s.path === path);
    if (!submodule) return undefined;
    const configured = this.config.value(`submodule.${submodule.name}.ignore`)?.trim();
    if (configured !== undefined) return isSubmoduleIgnoreMode(configured) ? configured : undefined;
    const declared = submodule.ignore?.trim();
    return isSubmoduleIgnoreMode(declared) ? declared : undefined;
  }

  /**
   * What the worktree side ignores of the submodule at `path`, as git's status sets its
   * diff flags: `--ignore-submodules` overrides everything; else `submodule.<name>.ignore`
   * replaces `diff.ignoreSubmodules` (and `--untracked-files=no`) when set.
   */
  private async worktreeFlags(path: string): Promise<SubmoduleIgnoreFlags> {
    if (this.ignoreSubmodules) return submoduleIgnoreFlags(this.ignoreSubmodules);
    const own = await this.submoduleIgnore(path);
    if (own) return submoduleIgnoreFlags(own);
    const configured = this.config.value("diff.ignoreSubmodules")?.trim();
    const flags = submoduleIgnoreFlags(isSubmoduleIgnoreMode(configured) ? configured : "none");
    if (!this.showUntracked) flags.untracked = true;
    return flags;
  }

  /**
   * Whether the index side hides submodules: only `--ignore-submodules=all` does (git
   * compares HEAD and index with `dirty` otherwise, whatever `diff.ignoreSubmodules` or
   * `submodule.<name>.ignore` say, so a staged submodule is always shown).
   */
  private async indexIgnoresAll(_path: string): Promise<boolean> {
    return this.ignoreSubmodules === "all";
  }

  /**
   * The state of the submodule's own index and worktree, as git's `is_submodule_modified`
   * reads it from `git status --porcelain=2` run inside it: an untracked file there (or a
   * nested submodule holding only untracked files, `S..U`) is untracked content; any other
   * change, a nested submodule's included, is modified content.
   */
  private async submoduleDirt(
    worktree: Worktree,
    path: string,
    ignoreUntracked: boolean,
  ): Promise<SubmoduleDirt> {
    const inner: WorkingCopy | undefined = await worktree.openGitlink?.(path);
    if (!inner) return {};
    const showUntracked =
      !ignoreUntracked &&
      !["no", "false", "off", "0"].includes(
        RemoteConfigStore.from(inner).value("status.showUntrackedFiles")?.trim().toLowerCase() ??
          "",
      );
    const status = await new StatusCommand(inner)
      .setRenames(false)
      .setUntracked(showUntracked)
      .call();
    const dirt: SubmoduleDirt = {};
    for (const f of status.files) {
      if (f.index === "!") continue;
      if (f.index === "?") {
        dirt.untracked = true;
        continue;
      }
      const token = submoduleToken(f);
      if (token[0] === "S" && token[3] === "U") dirt.untracked = true;
      if (f.stages || f.renamedFrom || token !== "S..U") dirt.modified = true;
    }
    return dirt;
  }

  /**
   * Check if a path matches the configured path filters.
   */
  private matchesPath(path: string): boolean {
    if (this.paths.length === 0) {
      return true;
    }
    const p = path.endsWith("/") ? path.slice(0, -1) : path;
    for (const raw of this.paths) {
      const filterPath = raw.replace(/\/+$/, "");
      if (filterPath === "" || filterPath === ".") return true;
      if (p === filterPath || p.startsWith(`${filterPath}/`) || filterPath.startsWith(`${p}/`)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Collect all blob entries from a tree recursively.
   */
  private async collectTreeEntries(
    treeId: ObjectId,
    prefix: string,
    entries: Map<string, StatusSide>,
  ): Promise<void> {
    for await (const entry of this.trees.loadTree(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === FileMode.TREE) {
        await this.collectTreeEntries(entry.id, path, entries);
      } else {
        entries.set(path, { mode: entry.mode, id: entry.id });
      }
    }
  }
}

/** A side's mode and id, as a rename candidate takes them. */
function side(s: StatusSide): { mode: number; id: ObjectId } {
  return { mode: s.mode, id: s.id };
}
